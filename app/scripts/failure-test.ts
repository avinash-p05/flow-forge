/**
 * Failure-injection test. Two kinds of failure are injected at the same time:
 *   1. Every job attempt fails with probability FAILURE_RATE (default 30%); each step allows 5 attempts.
 *   2. Worker containers are SIGKILLed mid-run (KILL_WORKERS=2 containers, KILL_ROUNDS=2 times),
 *      so jobs are lost while RUNNING and must be recovered from the expired lease.
 *
 *   EXECUTION_LEASE_MS=10000 RATE_LIMIT_MAX_REQUESTS=100000 docker compose up -d --build --scale worker=5
 *   npm run test:failure
 *
 * "Recovery rate" = jobs that had at least one failed or lost attempt and still completed,
 * divided by all jobs that had at least one failed or lost attempt.
 */
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWorkflow, db, newUser, runPool, sleep, submit } from './lib.js';

const EXECUTIONS = Number(process.env.EXECUTIONS ?? 1000);
const FAILURE_RATE = Number(process.env.FAILURE_RATE ?? 0.3);
const KILL_WORKERS = Number(process.env.KILL_WORKERS ?? 2);
const KILL_ROUNDS = Number(process.env.KILL_ROUNDS ?? 2);

const token = await newUser();
const flaky = { failureRate: FAILURE_RATE, delayMs: 100, maxAttempts: 5 };
const workflowId = await createWorkflow(token, 'failure-test', [
  { id: 'reserve', type: 'flaky', config: flaky },
  { id: 'charge', type: 'flaky', config: flaky, dependsOn: ['reserve'] },
  { id: 'notify', type: 'flaky', config: flaky, dependsOn: ['reserve'] },
  { id: 'ship', type: 'flaky', config: flaky, dependsOn: ['charge', 'notify'] },
]);

console.log(`Submitting ${EXECUTIONS} executions (${EXECUTIONS * 4} jobs), failure rate ${FAILURE_RATE * 100}% per attempt`);
const submissions = runPool(EXECUTIONS, 25, async (index) => {
  const response = await submit(token, workflowId, { order: index });
  if (response.status !== 202) throw new Error(`submit failed with ${response.status}`);
});

// Kill workers while executions are still being submitted and processed.
// CHAOS=docker (default): SIGKILL local containers, then restart them.
// CHAOS=ecs: stop ECS worker tasks with the AWS CLI; the ECS service starts replacements by itself.
const chaos = process.env.CHAOS ?? 'docker';
const ecsTasks = () => execSync(
  `aws ecs list-tasks --cluster ${process.env.ECS_CLUSTER ?? 'flowforge'} --service-name flowforge-worker --desired-status RUNNING --query taskArns --output text`,
).toString().trim().split(/\s+/).filter(Boolean);

const killed: string[] = [];
for (let round = 1; round <= KILL_ROUNDS; round++) {
  await sleep(2000);
  if (chaos === 'ecs') {
    const victims = ecsTasks().slice(0, KILL_WORKERS);
    for (const task of victims) execSync(`aws ecs stop-task --cluster ${process.env.ECS_CLUSTER ?? 'flowforge'} --task ${task} --reason failure-test`);
    killed.push(...victims.map((task) => `round ${round}: ${task.split('/').pop()}`));
    console.log(`  round ${round}: stopped ${victims.length} ECS worker task(s); the service replaces them`);
    continue;
  }
  const containers = execSync('docker compose -f ../docker-compose.yml ps -q worker').toString().trim().split(/\s+/).filter(Boolean);
  const victims = containers.slice(0, KILL_WORKERS);
  if (!victims.length) break;
  execSync(`docker kill ${victims.join(' ')}`);
  killed.push(...victims.map((id) => `round ${round}: ${id.slice(0, 12)}`));
  console.log(`  round ${round}: SIGKILLed ${victims.length} worker container(s)`);
  await sleep(3000);
  execSync(`docker start ${victims.join(' ')}`);
  console.log(`  round ${round}: restarted them`);
}
await submissions;

while (true) {
  const { rows: [row] } = await db.query<{ open: number }>(
    `SELECT count(*)::int AS open FROM executions WHERE workflow_id = $1 AND status IN ('QUEUED', 'RUNNING')`, [workflowId]);
  process.stdout.write(`\r  executions still running: ${row.open}   `);
  if (row.open === 0) break;
  await sleep(1000);
}

const { rows: [r] } = await db.query(
  `WITH job_stats AS (
     SELECT j.id, j.status,
            count(*) FILTER (WHERE a.status = 'FAILED') AS failed_attempts,
            count(*) FILTER (WHERE a.status = 'LOST') AS lost_attempts,
            count(*) FILTER (WHERE a.status = 'COMPLETED') AS completed_attempts
     FROM jobs j JOIN executions e ON e.id = j.execution_id
     LEFT JOIN job_attempts a ON a.job_id = j.id
     WHERE e.workflow_id = $1
     GROUP BY j.id, j.status
   )
   SELECT
     count(*)::int AS jobs_total,
     count(*) FILTER (WHERE status = 'COMPLETED')::int AS jobs_completed,
     count(*) FILTER (WHERE status = 'FAILED')::int AS jobs_dead_lettered,
     count(*) FILTER (WHERE status = 'SKIPPED')::int AS jobs_skipped,
     count(*) FILTER (WHERE failed_attempts + lost_attempts > 0)::int AS jobs_affected,
     count(*) FILTER (WHERE failed_attempts + lost_attempts > 0 AND status = 'COMPLETED')::int AS jobs_recovered,
     count(*) FILTER (WHERE lost_attempts > 0)::int AS jobs_hit_by_worker_crash,
     count(*) FILTER (WHERE lost_attempts > 0 AND status = 'COMPLETED')::int AS jobs_recovered_from_crash,
     sum(failed_attempts)::int AS failed_attempts,
     sum(lost_attempts)::int AS lost_attempts,
     count(*) FILTER (WHERE completed_attempts > 1)::int AS jobs_completed_twice,
     (SELECT count(*)::int FROM executions WHERE workflow_id = $1 AND status = 'COMPLETED') AS executions_completed
   FROM job_stats`,
  [workflowId]);

const pct = (part: number, whole: number) => +((100 * part) / whole).toFixed(2);
const result = {
  ranAt: new Date().toISOString(),
  executions: EXECUTIONS,
  failureRatePerAttempt: FAILURE_RATE,
  maxAttemptsPerJob: 5,
  workerContainersKilled: killed,
  ...r,
  jobRecoveryRatePercent: pct(r.jobs_recovered, r.jobs_affected),
  crashRecoveryRatePercent: r.jobs_hit_by_worker_crash ? pct(r.jobs_recovered_from_crash, r.jobs_hit_by_worker_crash) : null,
  executionSuccessRatePercent: pct(r.executions_completed, EXECUTIONS),
};

console.log('\n', result);
await mkdir('../docs/results', { recursive: true });
await writeFile(process.env.RESULT_FILE ?? '../docs/results/failure-test.json', `${JSON.stringify(result, null, 2)}\n`);
await db.end();
