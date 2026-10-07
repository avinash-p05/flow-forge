# FlowForge Architecture

## 1. System overview

FlowForge separates workflow definition, execution orchestration, and job processing:

```text
Client
  |
  v
API service
  |-----------------------> PostgreSQL
  |                            |
  |                            ├── workflows
  |                            ├── workflow_executions
  |                            ├── job_executions
  |                            ├── job_attempts
  |                            ├── audit_logs
  |                            └── dead_letter_jobs
  |
  ├── Redis
  |     ├── workflow-definition cache
  |     └── distributed rate limiting
  |
  └── SQS execution queue
             |
             v
        Worker service
             |
             └── Built-in step handlers
```

The API is responsible for accepting and persisting work. Workers are responsible for executing jobs. PostgreSQL remains the durable source of truth.

## 2. Runtime components

### API service

Entry point: [server/src/server.ts](server/src/server.ts)

Responsibilities:

- Load and validate configuration
- Run database migrations
- Expose health and metrics endpoints
- Authenticate users with JWTs
- Manage workflows
- Create workflow executions
- Persist execution input and job records
- Publish execution IDs to SQS when configured

### Worker service

Entry point: [server/src/worker.ts](server/src/worker.ts)

Responsibilities:

- Poll PostgreSQL or consume SQS messages
- Claim executions and ready jobs safely
- Resolve dependency order
- Run multiple independent jobs in parallel
- Invoke the correct built-in handler
- Enforce timeouts
- Record attempts, outputs, retries, and failures
- Extend SQS visibility while processing
- Delete SQS messages only after successful processing

### PostgreSQL

PostgreSQL stores all durable workflow and execution state. Migrations are applied in lexical order by the migration runner.

Important tables:

| Table | Purpose |
| --- | --- |
| `users` | Registered users |
| `workflows` | Reusable workflow definitions |
| `workflow_executions` | One row per workflow run |
| `job_executions` | One runtime job per workflow step |
| `job_attempts` | One row per attempt/retry |
| `audit_logs` | Execution lifecycle events |
| `dead_letter_jobs` | Permanently failed application jobs |
| `schema_migrations` | Applied migration history |

### Redis

Redis is used for:

- Workflow-definition caching
- Per-user/IP execution rate limiting

Cache failures are fail-open for workflow reads: PostgreSQL remains authoritative. Rate limiting is fail-closed when Redis is required but unavailable.

### Amazon SQS

SQS is an optional production execution transport:

```text
API -> PostgreSQL transaction -> SQS execution message -> Worker
```

Messages contain an execution ID. The worker reloads state from PostgreSQL and claims the exact execution.

The queue is configured in AWS. Its redrive policy should route poison messages to an SQS DLQ. The application also records permanently failed jobs in PostgreSQL through `dead_letter_jobs`; these are separate concerns.

## 3. Workflow model

A workflow is a reusable definition:

```json
{
  "name": "Customer onboarding",
  "definition": {
    "steps": [
      {
        "id": "create-customer",
        "name": "Create customer",
        "type": "http",
        "config": {
          "method": "POST",
          "url": "https://example.com/customers"
        },
        "dependsOn": []
      },
      {
        "id": "notify-customer",
        "name": "Notify customer",
        "type": "webhook",
        "config": {
          "method": "POST",
          "url": "https://example.com/notify"
        },
        "dependsOn": ["create-customer"]
      }
    ]
  }
}
```

### Step identity

- `step.id` is the stable technical identity within a workflow.
- `step.name` is a display label and may be duplicated.
- The API generates a UUID when a new step omits `id`.
- Dependencies reference step IDs, never display names.

### Runtime identity

Each submitted execution creates:

```text
Workflow execution
  ├── Job for step A
  ├── Job for step B
  └── Job for step C
```

The identities are intentionally separate:

```text
step.id                 stable definition identity
job_executions.id       runtime job identity
workflow_executions.id  complete workflow-run identity
job_attempts.id         individual attempt identity
```

## 4. Execution lifecycle

### Submission

1. The client submits an execution request.
2. The API loads the workflow definition from Redis or PostgreSQL.
3. PostgreSQL creates a `workflow_executions` row.
4. PostgreSQL creates one `job_executions` row per step.
5. The API publishes the execution ID to SQS when SQS is configured.
6. The API returns `202 Accepted`.

Execution input is persisted as JSON:

```json
{
  "input": {
    "customerId": "customer-123"
  }
}
```

### Job scheduling

A worker claims ready jobs using PostgreSQL row locks:

```sql
FOR UPDATE SKIP LOCKED
```

A job is ready when:

- Its status is `PENDING` or eligible `RETRYING`.
- Its retry time has arrived.
- Every dependency has status `COMPLETED`.

Independent jobs can be claimed together and processed with `Promise.all`.

### Input propagation

A job receives:

```text
execution input
+ its stored job input
+ outputs from completed dependency jobs
```

Completed outputs are stored in `job_executions.output`. The final execution output is assembled from completed step outputs.

### Completion and failure

Successful jobs become `COMPLETED`.

Retryable failures become `RETRYING` and receive an exponential backoff delay:

```text
JOB_RETRY_BASE_DELAY_MS * 2^(attempt - 1)
```

Validation errors and jobs that exceed `JOB_MAX_ATTEMPTS` become `FAILED` and are recorded in `dead_letter_jobs`.

Jobs whose dependencies fail or are skipped become `SKIPPED`. An execution with failed or blocked work becomes `BLOCKED`/failed according to the execution reconciliation path.

## 5. Handler architecture

Handler entry point: [server/src/handlers/registry.ts](server/src/handlers/registry.ts)

Handlers implement a constrained contract:

```typescript
type BuiltInHandler = (
  config: Record<string, unknown>,
  context: {
    input: Record<string, unknown>;
    signal: AbortSignal;
  },
) => Promise<Record<string, unknown>>;
```

No workflow can execute arbitrary user-supplied JavaScript.

| Handler | Responsibility |
| --- | --- |
| `worker` | Built-in internal worker contract |
| `http` | Outbound HTTP request |
| `webhook` | Outbound HTTP request using webhook semantics |
| `delay` | Abortable bounded delay |
| `transform` | Built-in merge, pick, and set operations |

All handlers receive an `AbortSignal`. The worker aborts a handler after `JOB_TIMEOUT_MS`.

## 6. Failure and retry model

Errors are classified as:

- `VALIDATION_ERROR`: configuration or input is invalid; not retried.
- `TIMEOUT`: handler exceeded the configured timeout; retryable.
- `HANDLER_ERROR`: handler or downstream operation failed; retryable by default.
- `WORKER_LOST`: a claimed job became stale; eligible for recovery.

Each attempt is persisted in `job_attempts` with its input, output, error, status, and timestamps.

## 7. SQS processing model

When `SQS_QUEUE_URL` is empty:

```text
Worker -> PostgreSQL polling
```

When `SQS_QUEUE_URL` is configured:

```text
Worker -> ReceiveMessage -> claim execution -> process jobs
       -> extend visibility heartbeat
       -> delete message only after successful processing
```

If processing fails or the worker stops, the message remains available for redelivery after its visibility timeout. AWS queue redrive configuration controls movement to the SQS DLQ.

## 8. API layers

The API follows a layered structure:

```text
Routes
  -> Middleware
  -> Controllers
  -> Services
  -> Repositories
  -> PostgreSQL / Redis / SQS
```

- Routes define HTTP paths.
- Middleware handles authentication and rate limiting.
- Controllers translate HTTP requests and responses.
- Services contain business rules.
- Repositories own persistence queries.
- Infrastructure adapters isolate Redis and SQS clients.

## 9. Security boundaries

Current controls include:

- JWT signature, issuer, audience, algorithm, and expiration validation
- Hashed password storage
- Hashed refresh-token storage
- User ownership checks on workflows and executions
- JSON body size limits
- Security response headers
- No arbitrary code execution
- Separate API and worker IAM policy examples

Production deployments should additionally enforce outbound HTTP allowlists or egress controls to prevent SSRF, use AWS Secrets Manager, configure TLS, and restrict IAM permissions to exact resources.

## 10. Deployment topology

Recommended AWS topology:

```text
Application Load Balancer
          |
          v
      ECS API service  -----> RDS PostgreSQL
          |                         |
          v                         |
         SQS <----------------------+
          |
          v
      ECS worker service -----> ElastiCache Redis
```

The API and worker have separate ECS task definitions so they can scale independently:

- API scales with HTTP traffic.
- Workers scale with queue depth and execution load.

Task definitions are templates. Replace account, region, role, image, and Secrets Manager placeholders before deployment.

## 11. Operational concerns

Available endpoints:

```text
GET /health
GET /metrics
GET /metrics/prometheus
```

HTTP requests include structured logs with request IDs and duration. The current metric counters are process-local; production multi-instance monitoring should export them to Prometheus, CloudWatch, or another shared metrics system.

## 12. Extension points

Planned extensions include:

- Durable workflow definition snapshots per execution
- Per-step retry and timeout configuration
- Rich job-attempt duration metrics
- Full PostgreSQL and SQS integration tests
- Terraform, CDK, or CloudFormation infrastructure
- Graceful shutdown coordination for long-running workers
