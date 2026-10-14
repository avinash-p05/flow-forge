# FlowForge — Distributed Workflow Engine

FlowForge runs multi-step workflows (DAGs of jobs) on a pool of horizontally scalable workers.
An API accepts workflow runs and puts them on **AWS SQS**. Workers pull them, run each step when its
dependencies are done, retry failures with **exponential backoff**, move permanently failing jobs to a
**dead-letter queue**, and record every state change in **PostgreSQL**. **Redis** provides rate limiting
shared by all API instances.

**Stack:** TypeScript · Node.js · Express · PostgreSQL · Redis · AWS SQS · Docker · GitHub Actions · AWS ECS Fargate

Architecture diagram: [flowforge-architecture.html](flowforge-architecture.html) (published with GitHub Pages)

## Measured results

Measured with **real AWS SQS** (`ap-south-1`). The API, 5 worker containers × 10 slots = 50 workers,
PostgreSQL and Redis ran in Docker, and local ElasticMQ was stopped so every message went through AWS.
All numbers are computed from the timestamps stored in PostgreSQL. Raw output: [docs/results/](docs/results/).

| Load test ([load-test.ts](app/scripts/load-test.ts)) | |
|---|---|
| Workload | 2,000 executions of a 5-step fan-out/fan-in workflow = **10,000 jobs** |
| Result | 10,000 / 10,000 jobs completed, 0 failed; 1,997 of 2,000 executions delivered via SQS |
| Concurrent workers | **50 live, 50 busy** at peak; all 50 ran jobs |
| Throughput | ~700 jobs/s (14.3 s wall clock) |
| Latency | job p95 60 ms · execution end-to-end p50 339 ms / p95 651 ms / p99 768 ms |

| Failure-injection test ([failure-test.ts](app/scripts/failure-test.ts)), 3 runs | |
|---|---|
| Workload per run | 1,000 executions × 4 steps = 4,000 jobs (12,000 jobs in total) |
| Injected failures | every attempt fails with 30% probability, **and** 2 of 5 worker containers are SIGKILLed twice mid-run |
| Job recovery per run | 98.68% · 99.00% · 99.32% |
| Combined | 3,556 of 3,592 failure-affected jobs recovered → **99.0% recovery** |
| Jobs lost to a killed worker | 72, all 72 recovered (100%) |
| Jobs committed twice | 0 |
| Execution success rate | 98.8% (2,964 / 3,000); the 36 jobs that failed all 5 attempts went to the dead-letter queue |

Expected recovery for these settings is 1 − 0.3⁴ ≈ 99.2% (a job that has failed once still gets 4 more attempts),
so the measured rates match the math. The observed per-attempt failure rate was 29.96%.

**Local run with ElasticMQ** (an SQS-compatible broker in Docker): 10,000 / 10,000 jobs at ~950 jobs/s, and 99.41%
recovery in one failure-injection run ([load-test.json](docs/results/load-test.json), [failure-test.json](docs/results/failure-test.json)).

**What the AWS run uncovered:** at first, 5% of executions waited about 30 s. Separate database processes saw clocks
up to ~100 ms apart, so a worker sometimes judged brand-new work "not due yet" and left its SQS message hidden for
the 30 s visibility timeout. The fix: new work is always due immediately, and an SQS message means "look at this
execution now". After it, p99 latency dropped from 29 s to under 1 s.

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
│   │   ├── config.ts             every environment variable in one place (+ loads the root .env in dev)
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
└── scripts/                      e2e-test.ts, load-test.ts, failure-test.ts
.env.example                      template for the single .env (read by npm scripts and docker compose)
deploy/
├── local/elasticmq.conf          local SQS queue + its dead-letter queue (used by docker-compose.yml)
├── aws/ecs/                      ECS task definitions (used by the CD job in ci.yml)
└── aws/iam/                      least-privilege IAM policies for the API and worker task roles
.github/workflows/ci.yml          CI (typecheck, unit + e2e tests) and CD (ECR push + ECS deploy)
```

## Run it locally

Requires Docker and Node.js 22.

All configuration lives in one file, `.env` at the repository root. `npm` scripts and `docker compose` both
read it. Inside Docker, the database, Redis and ElasticMQ addresses are switched to container hostnames
automatically. To use a real AWS SQS queue, set its URL, region and keys in `.env` and leave `AWS_ENDPOINT_URL` empty.

```bash
cp .env.example .env                             # local defaults: ElasticMQ, local Postgres/Redis
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
