import { Router } from 'express';
import { pool } from '../infra/db.js';
import { redis } from '../infra/redis.js';

export const opsRouter = Router();

/** Liveness + dependency check, used by Docker, the ECS health check and the load balancer. */
opsRouter.get('/health', async (_request, response) => {
  const check = async (probe: () => Promise<unknown>) => probe().then(() => 'ok', () => 'down');
  const database = await check(() => pool.query('SELECT 1'));
  const cache = redis ? await check(() => redis!.ping()) : 'not configured';
  response.status(database === 'ok' ? 200 : 503).json({ status: database === 'ok' ? 'ok' : 'degraded', database, redis: cache });
});

/**
 * System-wide metrics computed from PostgreSQL, so they cover every API and worker instance
 * (in-memory counters would only describe the single process that serves the request).
 */
opsRouter.get('/metrics', async (_request, response) => {
  const [executions, jobs, workers, throughput, latency, failures, deadLetters] = await Promise.all([
    pool.query(`SELECT status, count(*)::int AS count FROM executions GROUP BY status`),
    pool.query(`SELECT status, count(*)::int AS count FROM jobs GROUP BY status`),
    pool.query(`SELECT count(*)::int AS active, count(current_execution)::int AS busy
                FROM workers WHERE last_heartbeat_at > NOW() - INTERVAL '30 seconds'`),
    pool.query(`SELECT count(*)::int AS completed FROM job_attempts
                WHERE status = 'COMPLETED' AND finished_at > NOW() - INTERVAL '60 seconds'`),
    pool.query(`SELECT
                  percentile_cont(0.5)  WITHIN GROUP (ORDER BY ms) AS p50,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
                  percentile_cont(0.99) WITHIN GROUP (ORDER BY ms) AS p99
                FROM (SELECT EXTRACT(EPOCH FROM finished_at - started_at) * 1000 AS ms FROM job_attempts
                      WHERE status = 'COMPLETED' AND finished_at > NOW() - INTERVAL '5 minutes') t`),
    pool.query(`SELECT status, count(*)::int AS count FROM job_attempts
                WHERE status IN ('FAILED', 'LOST') AND finished_at > NOW() - INTERVAL '5 minutes' GROUP BY status`),
    pool.query(`SELECT count(*)::int AS count FROM dead_letter_jobs WHERE replayed_at IS NULL`),
  ]);
  const byStatus = (rows: { status: string; count: number }[]) => Object.fromEntries(rows.map((row) => [row.status, row.count]));
  const round = (value: number | null) => (value === null ? null : Math.round(value));
  response.json({
    executions: byStatus(executions.rows),
    jobs: byStatus(jobs.rows),
    workers: workers.rows[0],
    throughput: { jobsCompletedLastMinute: throughput.rows[0].completed, jobsPerSecond: +(throughput.rows[0].completed / 60).toFixed(2) },
    jobLatencyMsLast5m: { p50: round(latency.rows[0].p50), p95: round(latency.rows[0].p95), p99: round(latency.rows[0].p99) },
    failedAttemptsLast5m: byStatus(failures.rows),
    deadLetteredJobs: deadLetters.rows[0].count,
  });
});
