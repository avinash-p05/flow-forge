# FlowForge Performance and Reliability Plan

## Audit baseline

FlowForge has an API process and independently deployable worker process. The API persists workflow executions and runtime jobs in PostgreSQL, then publishes an execution ID to SQS when `SQS_QUEUE_URL` is configured. When SQS is not configured, workers poll PostgreSQL directly.

PostgreSQL is the durable source of truth. Redis is used for workflow-definition caching and distributed rate limiting. The worker uses the handler registry to execute built-in step types and persists job outputs, attempts, errors, and timestamps.

## Current execution path

```text
Client
  -> API authentication and validation
  -> workflow definition loaded from Redis/PostgreSQL
  -> workflow_executions row created
  -> job_executions rows created
  -> SQS message published or PostgreSQL polling fallback
  -> worker claims execution
  -> worker claims dependency-ready jobs
  -> built-in handler executes
  -> job output/attempt state persisted
  -> execution reconciled
```

## Current measurable capabilities

- Workflow and job creation timestamps
- Job start and completion timestamps
- Attempt records in `job_attempts`
- Job status, retry count, error code, and output
- Execution status, start/completion timestamps, input, and output
- Audit events
- Process-local counters exposed through `/metrics` and `/metrics/prometheus`
- SQS visibility heartbeats
- Stale job recovery
- PostgreSQL row locking with `FOR UPDATE SKIP LOCKED`
- Parallel claiming of independent ready jobs

## Current gaps

- Metrics are process-local and are not an aggregated multi-worker monitoring system.
- Full PostgreSQL integration tests for concurrent claiming and stale recovery are required.
- SQS integration tests require a configured queue or AWS-compatible local endpoint.
- There is no repeatable benchmark runner or checked-in measured result yet.
- HTTP handler benchmarking requires an explicit safe test endpoint and should not target arbitrary private network addresses.
- Worker crash testing must use controlled disposable processes or containers.

## Benchmark methodology

Benchmarks must use the public API and the real PostgreSQL-backed execution path:

1. Start PostgreSQL, Redis, API, and a controlled number of workers.
2. Register a unique benchmark user.
3. Create real workflow definitions through the API.
4. Submit executions concurrently using unique idempotency keys.
5. Poll execution status until each run reaches a terminal state.
6. Fetch jobs and execution history.
7. Calculate job and workflow latency from persisted timestamps.
8. Calculate throughput from completed real jobs divided by elapsed benchmark time.
9. Record failures, retries, skipped jobs, and outputs from API state.
10. Store environment, workload, configuration, command, and timestamp with every result.

Each worker-count run must be isolated or use a unique workload namespace. Worker counts must be explicitly started and verified; they must not be inferred from configuration alone.

## Workloads

The benchmark should cover:

- Sequential workflows, where each step depends on the previous step.
- Fan-out workflows, where multiple independent steps are eligible concurrently.
- Fan-in workflows, where a final step depends on multiple completed steps.
- Retry workloads using a deterministic built-in test handler contract.
- Timeout workloads using the bounded delay handler.

Benchmark results must remain empty until a command has actually produced measurements. No throughput, latency, or recovery number should be estimated.

### Running the checked-in tooling

From `server/`, use the explicit commands below after starting the API and the
intended, verified number of workers:

```sh
npm run benchmark:generate -- benchmark-workflows.json
npm run benchmark:run -- benchmark-workflows.json benchmark-run.json
npm run benchmark:collect -- benchmark-run.json benchmark-results.json
npm run benchmark:report -- benchmark-results.json benchmark-report.md
```

The runner registers a unique user, creates workflows through the public API,
submits with unique idempotency keys, and the collector reads terminal
execution, job, and audit state back through the API. It never invents
latencies or throughput. `npm run failure:test` is an explicit reliability
run; it exercises deterministic retries and bounded timeout handling and writes
the observed API state to `FAILURE_TEST_OUTPUT` (or a timestamped JSON file).
These commands are intentionally not part of the normal CI test job.

## Failure-injection methodology

Failure tests should use controlled scenarios:

- Stop a worker after work has been claimed.
- Make a handler fail a configured number of times before succeeding.
- Make a handler exceed `JOB_TIMEOUT_MS`.
- Configure a low maximum attempt count and verify dead-letter persistence.
- Stop or isolate the queue consumer where practical.

For each scenario, record:

- Jobs affected
- Jobs recovered
- Jobs permanently failed
- Attempt count
- Time to recovery
- Final job state
- Final workflow state
- Duplicate execution observations

The failure-injection harness must use real PostgreSQL state and must not replace database locking with an in-memory lock.

## Idempotency verification

For the same user and idempotency key, concurrent submissions must be verified to produce one durable execution and one job set. Tests must cover:

- Sequential duplicate requests
- Concurrent duplicate requests
- Different keys
- Same key with different input payloads

The result and documented behavior must come from the database constraint and repository behavior, not from client-side deduplication.

## CI strategy

Every pull request should run type-checking, focused tests, Compose validation, API health, smoke testing, and image builds. Full benchmarks and destructive failure-injection runs should be explicit commands and should not run on every pull request.

## Evidence policy

Only actual command output may be used in `docs/benchmark-results.md`, `docs/failure-test-results.md`, and `docs/resume-evidence.md`. Every numerical claim must include its workload, worker count, environment, command, and timestamp.
