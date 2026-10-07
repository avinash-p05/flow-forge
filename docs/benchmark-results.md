# Benchmark results

These results were collected from the public API at `http://localhost:3000` using
[quick-workload.json](../server/scripts/benchmark/quick-workload.json). Each run
submitted eight executions: four sequential two-step workflows and four
parallel three-step workflows. PostgreSQL and Redis ran through Docker Compose.
Worker counts were verified with `docker compose ps worker` before each run.

The measurements below are from persisted execution and job timestamps. They
are local measurements, not production capacity claims.

| Workers | Workload | Runs | Completed | Failed | Jobs | Retries | Skipped | Recovery | Throughput (jobs/s) | Job p50/p95/p99 (ms) | Workflow p50/p95/p99 (ms) |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1 | quick-sequential | 4 | 4 | 0 | 8 | 0 | 0 | 0 | 4.14 | 5.0/6.0/6.0 | 415.0/474.0/474.0 |
| 1 | quick-parallel | 4 | 4 | 0 | 12 | 0 | 0 | 0 | 6.21 | 7.0/10.0/10.0 | 493.0/542.0/542.0 |
| 2 | quick-sequential | 4 | 4 | 0 | 8 | 0 | 0 | 0 | 4.13 | 5.0/9.0/9.0 | 373.0/428.0/428.0 |
| 2 | quick-parallel | 4 | 4 | 0 | 12 | 0 | 0 | 0 | 6.20 | 8.0/19.0/19.0 | 442.0/468.0/468.0 |
| 3 | quick-sequential | 4 | 4 | 0 | 8 | 0 | 0 | 0 | 4.29 | 4.0/9.0/9.0 | 486.0/535.0/535.0 |
| 3 | quick-parallel | 4 | 4 | 0 | 12 | 0 | 0 | 0 | 6.44 | 8.0/21.0/21.0 | 581.0/606.0/606.0 |

The generated per-run evidence is available in
[benchmark-report-workers-1.md](../benchmark-report-workers-1.md),
[benchmark-report-workers-2.md](../benchmark-report-workers-2.md), and
[benchmark-report-workers-3.md).

## Interpretation

- All 24 measured executions completed successfully.
- No retries, skipped jobs, or worker-loss recoveries occurred in this
  workload.
- Increasing the local worker count did not produce a monotonic improvement
  for this small workload; the results should not be generalized without
  larger samples and production-like infrastructure.
