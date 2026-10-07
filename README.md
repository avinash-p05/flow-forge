# FlowForge

FlowForge is a distributed workflow execution platform. It provides a REST API for defining workflows, queues workflow executions, and processes runtime jobs through horizontally scalable workers.

## Features

- JWT authentication with rotating refresh tokens
- PostgreSQL-backed workflow and execution persistence
- Server-generated stable step IDs
- Dependency-aware workflow scheduling
- Runtime job records for every workflow step
- Retry and exponential backoff
- PostgreSQL dead-letter records
- AWS SQS execution queue support
- SQS visibility-timeout heartbeats
- Redis-backed rate limiting and workflow-definition caching
- Built-in step handlers:
  - `worker`
  - `http`
  - `webhook`
  - `delay`
  - `transform`
- Execution input and output persistence
- Audit history and operational metrics
- API and worker Docker images
- ECS task definitions and IAM policy examples
- Postman collection and OpenAPI documentation

## Repository structure

```text
.
├── frontend/
│   ├── src/                  # React workflow control center
│   ├── package.json
│   └── vite.config.ts
├── deploy/
│   ├── ecs/                  # ECS task definitions
│   └── iam/                  # IAM policy examples
├── docs/
│   └── openapi.yaml          # REST API contract
├── postman/
│   └── FlowForge.postman_collection.json
├── app/
│   ├── migrations/           # Ordered PostgreSQL migrations
│   ├── scripts/              # Smoke tests and utility scripts
│   ├── src/
│   │   ├── config/           # Validated runtime configuration
│   │   ├── controllers/      # HTTP request/response handling
│   │   ├── db/               # PostgreSQL pool and migration runner
│   │   ├── handlers/         # Built-in workflow step handlers
│   │   ├── infrastructure/  # Redis and other infrastructure clients
│   │   ├── middleware/       # Authentication and rate limiting
│   │   ├── queue/            # SQS queue adapter
│   │   ├── repositories/     # PostgreSQL data access
│   │   ├── routes/           # Express route registration
│   │   ├── services/         # Business logic
│   │   ├── types/            # Domain types
│   │   ├── utils/            # Shared utilities
│   │   ├── app.ts            # Express application
│   │   ├── server.ts         # API process entry point
│   │   └── worker.ts         # Worker process entry point
│   ├── Dockerfile.api
│   ├── Dockerfile.worker
│   └── .env.example
├── docker-compose.yml
├── architecture.md
└── README.md
```

## Prerequisites

- Node.js 20+
- npm
- Docker Desktop for local PostgreSQL, Redis, and container validation
- PostgreSQL and Redis if running the server directly
- AWS credentials and an SQS queue for production queue mode

## Local setup

Install dependencies:

```powershell
cd D:\FlowForge\frontend
npm ci

cd D:\FlowForge\app
npm ci
```

Create the local environment file:

```powershell
Copy-Item .env.example .env
```

Set a unique local `AUTH_TOKEN_SECRET` with at least 32 characters. Never commit `.env`.

Start the local dependencies:

```powershell
docker compose up -d postgres redis
```

Start the API:

```powershell
cd app
npm start
```

Start a worker in a second terminal:

```powershell
cd app
npm run worker
```

The API is available at `http://localhost:3000`.

## GitHub Pages architecture diagram

The standalone architecture diagram is deployed automatically by
`.github/workflows/pages.yml` whenever `flowforge-architecture.html` changes
on `main` or `master`. After enabling GitHub Pages for the repository with
**Source: GitHub Actions**, it is available at:

```text
https://avinash-p05.github.io/flow-forge/
https://avinash-p05.github.io/flow-forge/flowforge-architecture.html
```

Build the frontend and serve it from the same Express process:

```powershell
cd D:\FlowForge\frontend
npm run build

cd ..\server
npm start
```

Once built, `http://localhost:3000/` serves the React application and the API remains available on the same port. During frontend-only development, use `npm run dev` in `frontend`; Vite proxies API requests to port 3000.

Health check:

```http
GET http://localhost:3000/api/v1/health
```

## Run the complete local stack

The Compose file starts PostgreSQL, Redis, the API, and a worker:

```powershell
docker compose up --build --wait
```

Stop the stack:

```powershell
docker compose down
```

Add `-v` only when you intentionally want to remove local database and Redis volumes.

## Configuration

The complete configuration reference is in [app/.env.example](app/.env.example).

Important settings:

```env
PORT=3000
DATABASE_URL=postgresql://flowforge:flowforge@127.0.0.1:5433/flowforge
REDIS_URL=redis://localhost:6379
AUTH_TOKEN_SECRET=replace-with-at-least-32-random-characters
JOB_MAX_ATTEMPTS=3
JOB_RETRY_BASE_DELAY_MS=1000
JOB_TIMEOUT_MS=30000
SQS_QUEUE_URL=
```

When `SQS_QUEUE_URL` is empty, workers use PostgreSQL polling. When it is configured, workers consume execution messages from SQS.

## Workflow example

Create a workflow without supplying step IDs:

```http
POST /workflows
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "name": "Customer onboarding",
  "definition": {
    "steps": [
      {
        "name": "Prepare customer",
        "type": "transform",
        "config": {
          "operation": "set",
          "key": "status",
          "value": "prepared"
        }
      },
      {
        "name": "Notify customer",
        "type": "webhook",
        "dependsOn": ["<generated-step-id>"],
        "config": {
          "method": "POST",
          "url": "https://example.com/webhook"
        }
      }
    ]
  }
}
```

The API generates a UUID for any omitted step ID. Dependencies must reference step IDs, not display names. Duplicate display names are allowed; duplicate step IDs are rejected.

Submit an execution:

```http
POST /workflows/<workflow-id>/executions
Authorization: Bearer <access-token>
Idempotency-Key: onboarding-customer-123
Content-Type: application/json
```

```json
{
  "input": {
    "customerId": "customer-123"
  }
}
```

Execution input and completed dependency outputs are provided to subsequent jobs. Execution status, job status, output, retries, and audit events can be queried through the execution endpoints.

## Step handlers

Handlers are built-in and selected by the step `type`. FlowForge does not execute arbitrary user-supplied JavaScript.

| Type | Current behavior |
| --- | --- |
| `worker` | Returns configured result and input through the built-in worker contract |
| `http` | Performs an outbound HTTP request and returns status/body |
| `webhook` | Uses the HTTP handler contract |
| `delay` | Waits for a configured duration |
| `transform` | Supports merge, pick, and set operations |

## API documentation and testing

- OpenAPI contract: [docs/openapi.yaml](docs/openapi.yaml)
- Postman collection: [postman/FlowForge.postman_collection.json](postman/FlowForge.postman_collection.json)

Import the Postman collection, run **Register** or **Login**, then run the workflow and execution requests. Collection scripts save access tokens, refresh tokens, workflow IDs, and execution IDs automatically.

## Validation commands

Run the TypeScript check:

```powershell
cd app
npx tsc --noEmit
```

Run handler tests:

```powershell
npm test
```

Run the API smoke test against a running API:

```powershell
$env:API_URL = "http://localhost:3000"
npm run smoke
```

Validate Compose:

```powershell
cd ..
docker compose config
```

Build production-style images:

```powershell
docker build -f app/Dockerfile.api -t flowforge-api:local app
docker build -f app/Dockerfile.worker -t flowforge-worker:local app
```

## Deployment

The repository includes deployment starting points:

- [deploy/ecs/api-task-definition.json](deploy/ecs/api-task-definition.json)
- [deploy/ecs/worker-task-definition.json](deploy/ecs/worker-task-definition.json)
- [deploy/iam/flowforge-api-policy.json](deploy/iam/flowforge-api-policy.json)
- [deploy/iam/flowforge-worker-policy.json](deploy/iam/flowforge-worker-policy.json)

Before deploying, replace placeholders and configure:

- ECR repositories and image tags
- ECS execution and task roles
- Secrets Manager values
- SQS queue and redrive policy
- RDS PostgreSQL
- ElastiCache Redis
- CloudWatch log groups and alarms
- Load balancer and TLS

Do not use the Compose placeholder secret in production.

## CI

The GitHub Actions workflow in [.github/workflows/ci.yml](.github/workflows/ci.yml) runs TypeScript validation, starts local dependencies, performs health and smoke checks, validates Compose, and builds API and worker images.

## Current limitations

- Metrics are process-local counters; use Prometheus or a shared metrics backend for multi-instance aggregation.
- Complete AWS infrastructure is not managed as Terraform, CDK, or CloudFormation.
- Full PostgreSQL/SQS integration tests are still separate from the focused handler tests.
- Outbound HTTP handlers should be protected with an allowlist or SSRF-safe egress policy in production.
