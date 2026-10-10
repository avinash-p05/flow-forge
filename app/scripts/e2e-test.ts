/**
 * End-to-end check of every feature through the public API, against a running stack:
 *   docker compose up -d --build && npm run test:e2e
 */
import { randomUUID } from 'node:crypto';
import { call, createWorkflow, db, expect, newUser, submit, waitForExecution } from './lib.js';

console.log('health and auth');
const health = await call('/health');
expect(health.status === 200 && health.body.database === 'ok', 'health check reports database ok');
expect((await call('/api/v1/workflows')).status === 401, 'requests without a token are rejected');
const token = await newUser();

console.log('workflow validation');
const cyclic = await call('/api/v1/workflows', { token, body: { name: 'bad', definition: { steps: [
  { id: 'a', type: 'transform', dependsOn: ['b'] }, { id: 'b', type: 'transform', dependsOn: ['a'] },
] } } });
expect(cyclic.status === 400 && /cycle/.test(cyclic.body.error), 'a workflow with a cycle is rejected');

console.log('DAG execution (fan-out / fan-in)');
const dag = await createWorkflow(token, 'order-pipeline', [
  { id: 'load', type: 'transform', config: { values: { loaded: true } } },
  { id: 'price', type: 'transform', config: { values: { price: 42 } }, dependsOn: ['load'] },
  { id: 'stock', type: 'transform', config: { values: { inStock: true } }, dependsOn: ['load'] },
  { id: 'confirm', type: 'transform', config: { values: { confirmed: true } }, dependsOn: ['price', 'stock'] },
]);
const run = await submit(token, dag, { orderId: 1 });
expect(run.status === 202 && run.body.status === 'QUEUED', 'submission returns 202 and a QUEUED execution');
const finished = await waitForExecution(token, run.body.id);
expect(finished.status === 'COMPLETED', 'execution completes');
expect(finished.jobs.every((job: any) => job.status === 'COMPLETED' && job.attempts === 1), 'every job ran exactly once');
expect(finished.output.confirm.price === 42 && finished.output.confirm.inStock === true && finished.output.confirm.orderId === 1,
  'the fan-in step received the execution input and both parent outputs');

console.log('idempotent submission');
const key = randomUUID();
const concurrent = await Promise.all([1, 2, 3, 4, 5].map(() => submit(token, dag, { orderId: 2 }, key)));
const ids = new Set(concurrent.map((response) => response.body.id));
expect(ids.size === 1, '5 concurrent requests with one Idempotency-Key create exactly one execution');
expect(concurrent.filter((response) => response.status === 202).length === 1, 'one request gets 202, the replays get 200');
const jobRows = await db.query('SELECT count(*)::int AS n FROM jobs WHERE execution_id = $1', [[...ids][0]]);
expect(jobRows.rows[0].n === 4, 'only one set of jobs was created');

console.log('retry with exponential backoff');
const flaky = await createWorkflow(token, 'flaky', [{ id: 'call-partner', type: 'flaky', config: { failUntilAttempt: 3 } }]);
const retried = await waitForExecution(token, (await submit(token, flaky)).body.id);
expect(retried.status === 'COMPLETED' && retried.jobs[0].attempts === 3, 'a job failing twice succeeds on attempt 3');
const gaps = await db.query(
  `SELECT EXTRACT(EPOCH FROM started_at - lag(finished_at) OVER (ORDER BY attempt)) * 1000 AS gap
   FROM job_attempts WHERE job_id = $1 ORDER BY attempt`, [retried.jobs[0].id]);
const [, first, second] = gaps.rows.map((row) => Number(row.gap));
expect(first >= 900 && second >= 1800, `backoff grows between attempts (${Math.round(first)}ms, then ${Math.round(second)}ms)`);

console.log('dead-letter queue and replay');
const doomed = await createWorkflow(token, 'doomed', [
  { id: 'charge', type: 'flaky', config: { failUntilAttempt: 99, maxAttempts: 2 } },
  { id: 'email', type: 'transform', dependsOn: ['charge'] },
]);
const failed = await waitForExecution(token, (await submit(token, doomed)).body.id);
expect(failed.status === 'FAILED', 'execution fails once a job exhausts its retries');
expect(failed.jobs[0].status === 'FAILED' && failed.jobs[0].attempts === 2, 'the job stopped after maxAttempts');
expect(failed.jobs[1].status === 'SKIPPED', 'the dependent step was skipped');
const letters = await call('/api/v1/dead-letters', { token });
expect(letters.body.some((entry: any) => entry.jobId === failed.jobs[0].id), 'the failed job is in the dead-letter list');
const replay = await call(`/api/v1/dead-letters/${failed.jobs[0].id}/replay`, { token, body: {} });
expect(replay.status === 202, 'a dead-lettered job can be replayed');
const replayed = await waitForExecution(token, failed.id);
expect(replayed.jobs[0].attempts === 2 && replayed.jobs[1].status === 'SKIPPED', 'the replay ran with a fresh set of attempts');

console.log('non-retryable errors');
const badConfig = await createWorkflow(token, 'bad-config', [{ id: 'wait', type: 'delay', config: { ms: -5 } }]);
const invalid = await waitForExecution(token, (await submit(token, badConfig)).body.id);
expect(invalid.status === 'FAILED' && invalid.jobs[0].attempts === 1, 'a validation error is dead-lettered without retrying');

console.log('rate limiting and metrics');
const limited = await submit(token, dag);
expect(Number(limited.headers.get('x-ratelimit-remaining')) >= 0 && limited.headers.get('x-ratelimit-limit'), 'submissions carry rate-limit headers');
const metrics = await call('/metrics');
expect(metrics.body.workers.active > 0 && metrics.body.jobs.COMPLETED > 0, `metrics report ${metrics.body.workers.active} live workers and completed jobs`);

await db.end();
console.log('\nAll end-to-end checks passed');
