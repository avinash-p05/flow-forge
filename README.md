# FlowForge — Distributed Workflow Engine

FlowForge runs multi-step workflows (DAGs of jobs) on a pool of horizontally scalable workers.
An API accepts workflow runs and puts them on **AWS SQS**. Workers pull them, run each step when its
dependencies are done, retry failures with **exponential backoff**, move permanently failing jobs to a
**dead-letter queue**, and record every state change in **PostgreSQL**. **Redis** provides rate limiting
shared by all API instances.

**Stack:** TypeScript · Node.js · Express · PostgreSQL · Redis · AWS SQS · Docker · GitHub Actions · AWS ECS Fargate

Architecture diagram: [flowforge-architecture.html](flowforge-architecture.html) (published with GitHub Pages)

## Measured results

Both tests run against the full Docker stack (5 worker containers × 10 slots = 50 workers) and compute
their numbers from the timestamps stored in PostgreSQL. Raw output: [docs/results/](docs/results/).

| Load test ([load-test.ts](app/scripts/load-test.ts)) | |
|---|---|
| Workload | 2,000 executions of a 5-step fan-out/fan-in workflow = **10,000 jobs** |
| Result | 10,000 / 10,000 jobs completed, 0 failed |
| Concurrent workers | **50 live**, 49 busy at peak |
| Throughput | ~950 jobs/s (10.5 s wall clock) |
| Latency | job p95 38 ms · execution end-to-end p95 236 ms · queue wait p95 139 ms |

| Failure-injection test ([failure-test.ts](app/scripts/failure-test.ts)) | |
|---|---|
| Workload | 1,000 executions × 4 steps = 4,000 jobs |
| Injected failures | every attempt fails with 30% probability, **and** 2 of 5 worker containers are SIGKILLed twice mid-run |
| Jobs that hit ≥1 failure or crash | 1,178 |
| Of those, recovered and completed | 1,171 → **99.41% recovery** |
| Jobs lost to a killed worker | 20, all 20 recovered (100%) |
| Jobs committed twice | 0 |
| Execution success rate | 99.3% (the 7 jobs that failed all 5 attempts went to the dead-letter queue) |

## How it works

```
 client ──HTTP──▶ API (Express) ──INSERT──▶ PostgreSQL  ◀──── source of truth for all state
                    │   │                        ▲
       rate limit ──┘   └──SendMessage──▶ SQS ───┘ ReceiveMessage
          (Redis)                         │
                                          ▼
                                  Workers (N containers × M slots)
                                  claim execution (lease) → run ready jobs → retry / DLQ
```

1. **Submit** — `POST /api/v1/workflows/:id/executions` creates one `executions` row and one `jobs` row per
   step in a single transaction, then sends `{ executionId }` to SQS. The `Idempotency-Key` header makes
   this safe to retry.
2. **Claim** — a worker slot receives the message and takes a **lease** on the execution with one conditional
   `UPDATE` (`locked_by`, `locked_until`). Only one worker can hold the lease; it renews it with a heartbeat.
3. **Run** — the worker repeatedly claims every job whose dependencies are `COMPLETED`, runs them in parallel,
   and passes each job the outputs of the steps it depends on.
4. **Fail** — a failed job is retried after `base × 2^(attempt-1)` (+ jitter). After `maxAttempts`, or on a
   non-retryable error, it is marked `FAILED`, written to `dead_letter_jobs`, and its dependents are `SKIPPED`.
5. **Wait** — when the remaining jobs are only waiting for a retry, the execution goes back to `QUEUED` with
   `next_attempt_at` set, the lease is released, and the SQS message is hidden until that time.
6. **Crash** — if a worker dies, its lease expires. Another worker takes over (via SQS redelivery or the
   PostgreSQL sweep), marks the dead worker's attempts `LOST`, and re-runs those jobs.

## Code map

```
app/
├── migrations/001_schema.sql     tables: users, workflows, executions, jobs, job_attempts, dead_letter_jobs, workers
├── src/
│   ├── server.ts                 API entry point
│   ├── worker.ts                 worker entry point (WORKER_CONCURRENCY slots, graceful shutdown)
│   ├── app.ts                    Express app: request logging, routes, error handler
│   ├── infra/                    connections to the outside world
│   │   ├── config.ts             every environment variable in one place (+ loads .env.local in dev)
│   │   ├── db.ts                 PostgreSQL pool, transactions, migration runner
│   │   ├── redis.ts              Redis client
│   │   ├── queue.ts              SQS adapter (send, receive, delete, change visibility)
│   │   └── log.ts                structured JSON logs
│   ├── api/
│   │   ├── auth.ts               register/login, scrypt password hashing, JWT middleware
│   │   ├── rate-limit.ts         Redis fixed-window limiter
│   │   ├── workflows.ts          create/list/get/delete workflows
│   │   ├── executions.ts         idempotent submit, status, cancel, dead letters + replay
│   │   └── metrics.ts            /health and /metrics
│   └── engine/
│       ├── rules.ts              DAG validation (cycle detection) and backoff formula
│       ├── handlers.ts           step types: http, delay, transform, flaky; timeouts
│       ├── job-store.ts          every SQL statement the worker runs (leases, fencing, retries, DLQ)
│       └── executor.ts           the worker loop
├── test/                         unit tests (node:test)
├── scripts/                      e2e-test.ts, load-test.ts, failure-test.ts
└── .env.example                  template for .env.local (local dev only; never used in Docker or AWS)
deploy/
├── local/elasticmq.conf          local SQS queue + its dead-letter queue (used by docker-compose.yml)
├── aws/ecs/                      ECS task definitions (used by the CD job in ci.yml)
└── aws/iam/                      least-privilege IAM policies for the API and worker task roles
.github/workflows/ci.yml          CI (typecheck, unit + e2e tests) and CD (ECR push + ECS deploy)
```

## Run it locally

Requires Docker and Node.js 22.

```bash
docker compose up -d --build --scale worker=5    # Postgres, Redis, SQS (ElasticMQ), API, 5 workers × 10 slots
cd app && npm install
npm test                 # unit tests
npm run test:e2e         # every feature through the API
```

Load and failure tests need a higher rate limit (one test user submits thousands of runs):

```bash
RATE_LIMIT_MAX_REQUESTS=100000 docker compose up -d --build --scale worker=5
npm run test:load

EXECUTION_LEASE_MS=10000 RATE_LIMIT_MAX_REQUESTS=100000 docker compose up -d --build --scale worker=5
npm run test:failure
```

Try it by hand:

```bash
TOKEN=$(curl -s localhost:3000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"password-123"}' | jq -r .token)

WF=$(curl -s localhost:3000/api/v1/workflows -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "order",
  "definition": { "steps": [
    { "id": "load",   "type": "transform", "config": { "values": { "loaded": true } } },
    { "id": "charge", "type": "flaky",     "config": { "failUntilAttempt": 2 }, "dependsOn": ["load"] },
    { "id": "ship",   "type": "delay",     "config": { "ms": 500 },             "dependsOn": ["charge"] }
  ] } }' | jq -r .id)

EX=$(curl -s localhost:3000/api/v1/workflows/$WF/executions -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'idempotency-key: order-1' -d '{"input":{"orderId":1}}' | jq -r .id)

curl -s localhost:3000/api/v1/executions/$EX -H "authorization: Bearer $TOKEN" | jq
curl -s localhost:3000/metrics | jq
```

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/auth/register`, `/api/v1/auth/login` | returns a JWT |
| POST/GET | `/api/v1/workflows` | create (validated DAG) / list |
| GET/DELETE | `/api/v1/workflows/:id` | |
| POST | `/api/v1/workflows/:id/executions` | rate-limited; `Idempotency-Key` header; 202 new, 200 replay |
| GET | `/api/v1/executions/:id` | execution with all its jobs |
| POST | `/api/v1/executions/:id/cancel` | |
| GET | `/api/v1/dead-letters` | jobs that exhausted their retries |
| POST | `/api/v1/dead-letters/:jobId/replay` | re-run a dead-lettered job and its skipped dependents |
| GET | `/health` | checks PostgreSQL and Redis |
| GET | `/metrics` | throughput, latency percentiles, failures, DLQ size, live/busy workers |

Step types: `http` (5xx/429 retried, 4xx not; sends an `Idempotency-Key` header), `delay`, `transform`,
`flaky` (failure injection). Per-step `config.maxAttempts` and `config.timeoutMs` override the defaults.

## Deploying to AWS

Step-by-step commands for creating everything, testing on AWS and tearing it down: **[docs/aws-deployment.md](docs/aws-deployment.md)**.

- **Compute:** one image, two ECS Fargate services — `flowforge-api` behind an Application Load Balancer
  (health check `/health`) and `flowforge-worker` (command `node dist/worker.js`). Task definitions: [deploy/aws/ecs/](deploy/aws/ecs/).
- **Data:** RDS PostgreSQL, ElastiCache Redis, secrets in Secrets Manager.
- **Queue:** `flowforge-executions` with a redrive policy to `flowforge-executions-dlq` (maxReceiveCount 5):
  ```bash
  aws sqs create-queue --queue-name flowforge-executions-dlq
  aws sqs create-queue --queue-name flowforge-executions --attributes '{
    "VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20",
    "RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:<region>:<account-id>:flowforge-executions-dlq\",\"maxReceiveCount\":\"5\"}"}'
  ```
- **Permissions:** least-privilege task roles in [deploy/aws/iam/](deploy/aws/iam/) (API can only send, workers can only receive/delete/change visibility).
- **CI/CD:** [ci.yml](.github/workflows/ci.yml) typechecks and runs unit + end-to-end tests on every push and PR.
  On `master` it builds the image, pushes it to ECR and rolls both ECS services, waiting until they are healthy.
  It authenticates with GitHub OIDC, so no AWS keys are stored in GitHub.
- **Observability:** JSON logs go to CloudWatch Logs (`/ecs/flowforge`); `/metrics` reports system-wide numbers from PostgreSQL;
  scale workers on the SQS `ApproximateNumberOfMessagesVisible` metric.

Design decisions and trade-offs: [docs/design-notes.md](docs/design-notes.md).
