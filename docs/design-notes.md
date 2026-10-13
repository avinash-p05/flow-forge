# Design notes

Why FlowForge is built the way it is, where each feature lives, and the trade-offs behind it.

## Core model

| Table | One row per | Key columns |
|---|---|---|
| `workflows` | workflow definition (a DAG) | `definition` JSON: `{ steps: [{ id, type, config, dependsOn }] }` |
| `executions` | run of a workflow | `status`, `idempotency_key`, `next_attempt_at`, `locked_by`, `locked_until` |
| `jobs` | step of a run | `status`, `attempts`, `claim_id`, `depends_on`, `next_attempt_at`, `output` |
| `job_attempts` | attempt of a job | `worker_id`, `status` (RUNNING/COMPLETED/FAILED/LOST), timings |
| `dead_letter_jobs` | job that gave up | `error`, `attempts`, `replayed_at` |
| `workers` | worker slot | `last_heartbeat_at`, `current_execution` |

Execution states: `QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED` (a RUNNING execution can go back to QUEUED while it waits for a retry).
Job states: `PENDING → RUNNING → COMPLETED`, or `RUNNING → RETRYING → RUNNING ...`, or `→ FAILED` (dead-lettered), or `SKIPPED` (a dependency failed).

## Queue-based worker architecture

- **SQS for dispatch, PostgreSQL for state.** The message only says "execution X is ready". All state lives in
  PostgreSQL, so a duplicated message is harmless (the claim `UPDATE` fails for the second worker) and a lost
  message is harmless (idle workers also sweep PostgreSQL with `FOR UPDATE SKIP LOCKED`).
- **Why not only PostgreSQL polling?** It works (and is the fallback), but SQS gives push-style long polling,
  built-in redelivery and a dead-letter queue for poison messages, and lets the API and workers scale on their own.
- **Why not only SQS?** SQS is at-least-once and has no "query by state". We need durable per-job state,
  dependency tracking and history, which a database does well.
- **Scaling:** each worker process runs `WORKER_CONCURRENCY` slots; each slot handles one execution at a time
  and runs that execution's ready jobs in parallel. 5 containers × 10 slots = 50 concurrent workers.
  [executor.ts](../app/src/engine/executor.ts), [worker.ts](../app/src/worker.ts)

## Idempotent execution (three layers)

1. **Submission:** `UNIQUE (user_id, idempotency_key)` + `INSERT ... ON CONFLICT DO NOTHING`. Concurrent duplicate
   requests produce one execution; replays get `200` with the original. A plain "check, then insert" would race.
   [executions.ts](../app/src/api/executions.ts)
2. **Claiming:** a job is moved to `RUNNING` with a single `UPDATE ... WHERE status IN ('PENDING','RETRYING')` and
   `FOR UPDATE SKIP LOCKED`, so two workers can never claim the same job.
3. **Writing results (fencing):** every claim gets a new `claim_id`. `completeJob` only writes
   `WHERE claim_id = $mine AND status = 'RUNNING'`. If a worker stalls, loses its lease, and another worker re-runs the
   job, the slow worker's late write is rejected. Failure test: **0 jobs committed twice**.
   [job-store.ts](../app/src/engine/job-store.ts)
4. **Side effects:** delivery is at-least-once (a job can run again after a crash), so the `http` step sends an
   `Idempotency-Key: <executionId>:<stepId>` header that stays the same across retries. The downstream service uses it
   to de-duplicate. True exactly-once side effects are not possible without the downstream service's cooperation.

## Retries, backoff, dead-letter queue

- `delay = base × 2^(attempt-1)`, capped at 60 s, plus up to 20% random jitter so failed jobs don't all retry at the
  same moment (thundering herd). [rules.ts](../app/src/engine/rules.ts)
- **Retryable:** handler errors, timeouts, HTTP 5xx/429, network errors. **Not retryable:** validation errors, HTTP 4xx.
- A waiting retry does not tie up a worker: the execution goes back to `QUEUED` with `next_attempt_at`, and the SQS
  message's visibility is set to the same delay.
- After `maxAttempts`, the job is `FAILED`, added to `dead_letter_jobs`, and its dependents become `SKIPPED`
  (independent branches keep running). `POST /dead-letters/:jobId/replay` re-runs it with fresh attempts.
- There are two dead-letter queues. **Job DLQ** (table): business failures, can be inspected and replayed.
  **SQS DLQ** (redrive policy, maxReceiveCount 5): messages that can't be processed at all, such as a malformed body
  or a worker crashing on it every time (a "poison pill").

## Failure recovery (worker crash)

- A worker holds an execution through a **lease** (`locked_until`), renewed every `lease/3` by a heartbeat.
- If the worker is killed, the lease expires. The SQS message becomes visible again, or the PostgreSQL sweep finds
  `status = 'RUNNING' AND locked_until < now()`. The new owner runs `recoverLostJobs`: the dead worker's `RUNNING` jobs are
  marked `LOST` in `job_attempts` and retried. A job that keeps killing workers is dead-lettered once it has used up its attempts.
- On `SIGTERM` (deploys, scale-in) workers stop taking new work, finish what they are doing, and exit.
- Measured: [failure-test.json](results/failure-test.json): 99.41% of failure-affected jobs recovered,
  and all 20 jobs lost to SIGKILLed containers were recovered.

## Redis rate limiting

- Fixed window per user: key `ratelimit:<user>:<window>`, `INCR` + `EXPIRE` inside `MULTI` (atomic, so the key always
  expires). All API instances share the counter. [rate-limit.ts](../app/src/api/rate-limit.ts)
- Returns `429` with `Retry-After`, and `X-RateLimit-Limit`/`X-RateLimit-Remaining` headers.
- **Fails open:** if Redis is down, requests are allowed and the problem is logged. The limiter protects the system
  but should not become a single point of failure.
- Trade-off: a fixed window allows up to 2× the limit across a window boundary. A sliding-window log
  (sorted set) or token bucket (Lua script) is smoother, at the cost of more Redis work.

## Observability

- `/metrics`: executions and jobs by status, jobs completed per second, job latency p50/p95/p99, failed/lost attempts,
  dead-letter count, live/busy workers. It is computed from PostgreSQL, so it covers every instance. In-memory
  counters would only describe the one process that answered the request.
- `/health` checks PostgreSQL and Redis. It is used by Docker, the ECS health check and the load balancer.
- Structured JSON logs with a request id (`x-request-id`), ready for CloudWatch Logs Insights.

## Known limits / what I'd do next

- An execution's jobs run in "waves": a fast job's dependents wait until the slowest sibling in the same wave finishes.
  An event-driven scheduler would start each dependent as soon as its own dependencies are done.
- `/metrics` runs aggregate queries. At larger scale, publish to CloudWatch/Prometheus instead and keep job history in
  partitioned tables with a retention policy.
- There is a small gap between the database commit and `SendMessage`. If the API crashes in that gap, the message is
  never sent; the database sweep still runs the execution, just later. A transactional outbox would remove the gap.
- PostgreSQL is the throughput ceiling (every job is a few writes). Batching writes or sharding by execution would help.

## Likely interview questions

- *What happens if a worker dies halfway through a job?* The lease expires, and the next owner marks the attempt
  `LOST` and retries the job. Fencing stops the old worker from writing if it was only slow, not dead.
- *How do you avoid two workers running the same execution?* A conditional `UPDATE` (lease) for the execution, and
  `FOR UPDATE SKIP LOCKED` for jobs.
- *Exactly-once?* Exactly-once **state transitions** (fencing + unique constraints); at-least-once **execution**;
  idempotency keys for side effects.
- *Why exponential backoff with jitter?* It gives a struggling dependency time to recover, and jitter spreads retries
  out instead of hitting it all at once.
- *How does it scale?* Run more worker containers (scale on SQS queue depth) and more API tasks behind the load
  balancer. All are stateless; state is in PostgreSQL and Redis.
- *How did you measure 99%+?* [failure-test.ts](../app/scripts/failure-test.ts) injects random failures (30% of
  attempts) and SIGKILLs worker containers mid-run, then computes recovery from `job_attempts`.
