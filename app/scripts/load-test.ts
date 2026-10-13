/**
 * Load test: EXECUTIONS runs of a 5-step fan-out/fan-in workflow (default 2,000 x 5 = 10,000 jobs).
 *   RATE_LIMIT_MAX_REQUESTS=100000 docker compose up -d --build --scale worker=5
 *   npm run test:load
 * Numbers are computed from the timestamps PostgreSQL recorded, then written to docs/results/load-test.json.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { call, createWorkflow, db, newUser, percentile, runPool, sleep, submit } from './lib.js';

const EXECUTIONS = Number(process.env.EXECUTIONS ?? 2000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);

const token = await newUser();
const workflowId = await createWorkflow(token, 'load-test', [
  { id: 'validate', type: 'transform', config: { values: { valid: true } } },
  { id: 'enrich-customer', type: 'delay', config: { ms: 20 }, dependsOn: ['validate'] },
  { id: 'enrich-pricing', type: 'delay', config: { ms: 20 }, dependsOn: ['validate'] },
  { id: 'enrich-inventory', type: 'delay', config: { ms: 20 }, dependsOn: ['validate'] },
  { id: 'finalize', type: 'transform', config: { values: { done: true } }, dependsOn: ['enrich-customer', 'enrich-pricing', 'enrich-inventory'] },
]);

// Sample /metrics while the test runs to see how many workers were alive and busy.
let peakWorkers = 0;
let peakBusy = 0;
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const { body } = await call('/metrics');
    peakWorkers = Math.max(peakWorkers, body.workers.active);
    peakBusy = Math.max(peakBusy, body.workers.busy);
    await sleep(500);
  }
})();

console.log(`Submitting ${EXECUTIONS} executions (${EXECUTIONS * 5} jobs) with ${CONCURRENCY} concurrent clients...`);
const submitLatencies: number[] = [];
const started = Date.now();
await runPool(EXECUTIONS, CONCURRENCY, async (index) => {
  const t0 = Date.now();
  const response = await submit(token, workflowId, { order: index });
  if (response.status !== 202) throw new Error(`submit ${index} failed with ${response.status}`);
  submitLatencies.push(Date.now() - t0);
});
console.log(`Submitted in ${((Date.now() - started) / 1000).toFixed(1)}s, waiting for workers...`);

while (true) {
  const { rows: [row] } = await db.query<{ open: number; done: number }>(
    `SELECT count(*) FILTER (WHERE status IN ('QUEUED', 'RUNNING'))::int AS open,
            count(*) FILTER (WHERE status NOT IN ('QUEUED', 'RUNNING'))::int AS done
     FROM executions WHERE workflow_id = $1`, [workflowId]);
  process.stdout.write(`\r  finished ${row.done}/${EXECUTIONS}`);
  if (row.open === 0) break;
  await sleep(1000);
}
sampling = false;
await sampler;

const { rows: [summary] } = await db.query(
  `SELECT
     (SELECT count(*)::int FROM executions WHERE workflow_id = $1 AND status = 'COMPLETED') AS executions_completed,
     (SELECT count(*)::int FROM executions WHERE workflow_id = $1 AND status = 'FAILED') AS executions_failed,
     (SELECT count(*)::int FROM jobs j JOIN executions e ON e.id = j.execution_id WHERE e.workflow_id = $1) AS jobs_total,
     (SELECT count(*)::int FROM jobs j JOIN executions e ON e.id = j.execution_id WHERE e.workflow_id = $1 AND j.status = 'COMPLETED') AS jobs_completed,
     (SELECT count(DISTINCT a.worker_id)::int FROM job_attempts a JOIN jobs j ON j.id = a.job_id JOIN executions e ON e.id = j.execution_id WHERE e.workflow_id = $1) AS distinct_workers,
     (SELECT EXTRACT(EPOCH FROM max(completed_at) - min(created_at)) FROM executions WHERE workflow_id = $1) AS wall_seconds`,
  [workflowId]);
const latencies = await db.query<{ e2e: number; wait: number }>(
  `SELECT EXTRACT(EPOCH FROM completed_at - created_at) * 1000 AS e2e, EXTRACT(EPOCH FROM started_at - created_at) * 1000 AS wait
   FROM executions WHERE workflow_id = $1`, [workflowId]);
const jobDurations = await db.query<{ ms: number }>(
  `SELECT EXTRACT(EPOCH FROM a.finished_at - a.started_at) * 1000 AS ms
   FROM job_attempts a JOIN jobs j ON j.id = a.job_id JOIN executions e ON e.id = j.execution_id
   WHERE e.workflow_id = $1 AND a.status = 'COMPLETED'`, [workflowId]);

const e2e = latencies.rows.map((row) => Number(row.e2e));
const wait = latencies.rows.map((row) => Number(row.wait));
const job = jobDurations.rows.map((row) => Number(row.ms));
const wallSeconds = Number(summary.wall_seconds);
const stats = (values: number[]) => ({ p50: Math.round(percentile(values, 50)), p95: Math.round(percentile(values, 95)), p99: Math.round(percentile(values, 99)) });

const result = {
  ranAt: new Date().toISOString(),
  executions: EXECUTIONS,
  clientConcurrency: CONCURRENCY,
  executionsCompleted: summary.executions_completed,
  executionsFailed: summary.executions_failed,
  jobsTotal: summary.jobs_total,
  jobsCompleted: summary.jobs_completed,
  wallClockSeconds: +wallSeconds.toFixed(1),
  throughputJobsPerSecond: +(summary.jobs_completed / wallSeconds).toFixed(1),
  peakLiveWorkers: peakWorkers,
  peakBusyWorkers: peakBusy,
  distinctWorkersThatRanJobs: summary.distinct_workers,
  submitLatencyMs: stats(submitLatencies),
  queueWaitMs: stats(wait),
  executionLatencyMs: stats(e2e),
  jobDurationMs: stats(job),
};

console.log('\n', result);
await mkdir('../docs/results', { recursive: true });
await writeFile(process.env.RESULT_FILE ?? '../docs/results/load-test.json', `${JSON.stringify(result, null, 2)}\n`);
await db.end();
