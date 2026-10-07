# Failure-injection results

The retry and timeout scenario was executed against the local Docker Compose
stack using [failure-injection.ts](../server/failure-injection.ts). The
result below was captured from the API after the execution reached a terminal
state and is stored in [failure-test-result.json](../failure-test-result.json).

| Scenario | Execution status | Retryable failure | Timeout behavior | Final attempts | Worker termination |
|---|---|---|---|---:|---|
| retry-and-timeout | FAILED | `test-failure` recovered on attempt 3 | `delay` timed out on attempts 1-3 | 3 / 3 | Not exercised |

Observed persisted state:

- The retry step completed with `attempts: 3` and output
  `{ "attempt": 3, "recovered": true }`.
- The delay step ended with `status: FAILED`, `attempts: 3`, and
  `errorCode: TIMEOUT`.
- The execution ended with `status: FAILED` and
  `error: "Execution blocked by failed dependency"`.
- No worker process was terminated for this run (`workerStoppedAt` was
  `null`), so stale-claim recovery remains unmeasured by this scenario.
