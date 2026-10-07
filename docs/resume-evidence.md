# Resume evidence

This document records implementation-backed checks completed for the current
FlowForge backend work. Performance values are local measurements only.

## Automated checks

- Backend TypeScript type-check passed with `npm run typecheck`.
- Benchmark script type-check passed with `npm run typecheck:scripts`.
- The handler test suite passed before the benchmark runs.
- API, worker, PostgreSQL, and Redis containers were healthy during the
  measurements.
- Three concurrent requests using one idempotency key produced one execution
  and one job set.

## Measured execution behavior

- The quick benchmark completed 24 of 24 executions across worker counts of
  one, two, and three.
- Sequential and independent parallel jobs were both executed through the
  public API and persisted job state.
- Retry handling recovered the deterministic failure on attempt 3.
- Timeout handling classified the delay failure as `TIMEOUT` after the
  configured retry limit.
- No claim-loss recovery was claimed as measured; the failure scenario did not
  terminate a worker.

See [benchmark-results.md](./benchmark-results.md) and
[failure-test-results.md](./failure-test-results.md) for the complete measured
tables and scope limitations.
