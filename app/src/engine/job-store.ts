import { pool, transaction } from '../infra/db.js';
import type { JobError } from './handlers.js';

/**
 * All database state changes made by workers.
 *
 * Two ideas keep this correct with many workers running at once:
 *  1. Execution lease: a worker owns an execution only while `locked_by = me AND locked_until > now`.
 *     It renews the lease with a heartbeat. If it crashes, the lease expires and another worker takes over.
 *  2. Job fencing: every claim of a job gets a fresh `claim_id`. A result is only written if the
 *     claim_id still matches, so a slow or "zombie" worker can never overwrite a newer attempt.
 */

export type ClaimedJob = {
  id: string;
  executionId: string;
  stepId: string;
  type: string;
  config: Record<string, unknown>;
  attempt: number;
  claimId: string;
  input: Record<string, unknown>;
};

const DUE_OR_ABANDONED = `(
  (status = 'QUEUED' AND next_attempt_at <= NOW()) OR
  (status = 'RUNNING' AND locked_until < NOW())
)`;

const TAKE_LEASE = `status = 'RUNNING', locked_by = $1, locked_until = NOW() + $2::int * INTERVAL '1 millisecond',
  started_at = COALESCE(started_at, NOW())`;

/** Polling path: take the oldest due execution that no other worker is holding. */
export const claimNextExecution = async (workerId: string, leaseMs: number): Promise<string | null> => {
  const result = await pool.query<{ id: string }>(
    `UPDATE executions SET ${TAKE_LEASE}
     WHERE id = (
       SELECT id FROM executions WHERE ${DUE_OR_ABANDONED}
       ORDER BY next_attempt_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [workerId, leaseMs],
  );
  return result.rows[0]?.id ?? null;
};

/** SQS path: take the execution named in a message, if it is still due. A duplicate message simply fails here. */
export const claimExecution = async (executionId: string, workerId: string, leaseMs: number): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE executions SET ${TAKE_LEASE} WHERE id = $3 AND ${DUE_OR_ABANDONED}`,
    [workerId, leaseMs, executionId],
  );
  return result.rowCount === 1;
};

export const extendLease = async (executionId: string, workerId: string, leaseMs: number): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE executions SET locked_until = NOW() + $3::int * INTERVAL '1 millisecond'
     WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING'`,
    [executionId, workerId, leaseMs],
  );
  return result.rowCount === 1;
};

export const getExecutionStatus = async (executionId: string): Promise<string | null> => {
  const result = await pool.query<{ status: string }>('SELECT status FROM executions WHERE id = $1', [executionId]);
  return result.rows[0]?.status ?? null;
};

/**
 * Called right after taking over an execution. Any job still RUNNING belonged to a worker that died
 * (we now hold the lease), so it is put back for retry, or dead-lettered if it has used all its attempts.
 */
export const recoverLostJobs = async (executionId: string, maxAttempts: number): Promise<number> => {
  return transaction(async (client) => {
    const lost = await client.query<{ id: string; attempts: number; max_attempts: number }>(
      `SELECT id, attempts, COALESCE((config->>'maxAttempts')::int, $2) AS max_attempts
       FROM jobs WHERE execution_id = $1 AND status = 'RUNNING' FOR UPDATE`,
      [executionId, maxAttempts],
    );
    if (!lost.rowCount) return 0;
    const ids = lost.rows.map((job) => job.id);
    const exhausted = lost.rows.filter((job) => job.attempts >= job.max_attempts).map((job) => job.id);
    const message = 'Worker stopped while running this job';
    await client.query(
      `UPDATE job_attempts SET status = 'LOST', error = $2, error_code = 'WORKER_LOST', finished_at = NOW()
       WHERE job_id = ANY($1) AND status = 'RUNNING'`,
      [ids, message],
    );
    await client.query(
      `UPDATE jobs SET status = 'RETRYING', next_attempt_at = NOW(), claim_id = NULL, error = $2, error_code = 'WORKER_LOST'
       WHERE id = ANY($1) AND NOT (id = ANY($3))`,
      [ids, message, exhausted],
    );
    if (exhausted.length) {
      await client.query(
        `UPDATE jobs SET status = 'FAILED', claim_id = NULL, error = $2, error_code = 'WORKER_LOST', completed_at = NOW()
         WHERE id = ANY($1)`,
        [exhausted, message],
      );
      await client.query(
        `INSERT INTO dead_letter_jobs (job_id, execution_id, error, error_code, attempts)
         SELECT id, execution_id, $2, 'WORKER_LOST', attempts FROM jobs WHERE id = ANY($1)
         ON CONFLICT (job_id) DO UPDATE SET error = EXCLUDED.error, attempts = EXCLUDED.attempts, created_at = NOW(), replayed_at = NULL`,
        [exhausted, message],
      );
    }
    return ids.length;
  });
};

/**
 * Claims up to `limit` jobs whose dependencies have all completed, and builds each job's input:
 * the execution input merged with the outputs of the steps it depends on.
 */
export const claimReadyJobs = async (executionId: string, workerId: string, limit: number): Promise<ClaimedJob[]> => {
  return transaction(async (client) => {
    const claimed = await client.query<{
      id: string; step_id: string; step_type: string; config: Record<string, unknown>;
      depends_on: string[]; attempts: number; claim_id: string;
    }>(
      `WITH ready AS (
         SELECT j.id FROM jobs j
         JOIN executions e ON e.id = j.execution_id
         WHERE j.execution_id = $1
           AND e.status = 'RUNNING' AND e.locked_by = $2
           AND j.status IN ('PENDING', 'RETRYING') AND j.next_attempt_at <= NOW()
           AND NOT EXISTS (
             SELECT 1 FROM jobs d
             WHERE d.execution_id = j.execution_id AND d.step_id = ANY(j.depends_on) AND d.status <> 'COMPLETED'
           )
         ORDER BY j.step_order
         LIMIT $3
         FOR UPDATE OF j SKIP LOCKED
       )
       UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, claim_id = gen_random_uuid(),
                       started_at = COALESCE(started_at, NOW())
       FROM ready WHERE jobs.id = ready.id
       RETURNING jobs.id, jobs.step_id, jobs.step_type, jobs.config, jobs.depends_on, jobs.attempts, jobs.claim_id`,
      [executionId, workerId, limit],
    );
    if (!claimed.rowCount) return [];

    await client.query(
      `INSERT INTO job_attempts (id, job_id, attempt, worker_id, status)
       SELECT *, $4::text, 'RUNNING' FROM unnest($1::uuid[], $2::uuid[], $3::int[])`,
      [claimed.rows.map((job) => job.claim_id), claimed.rows.map((job) => job.id), claimed.rows.map((job) => job.attempts), workerId],
    );

    const context = await client.query<{ input: Record<string, unknown>; outputs: Record<string, Record<string, unknown>> }>(
      `SELECT e.input,
              COALESCE((SELECT jsonb_object_agg(step_id, output) FROM jobs
                        WHERE execution_id = e.id AND status = 'COMPLETED'), '{}') AS outputs
       FROM executions e WHERE e.id = $1`,
      [executionId],
    );
    const { input, outputs } = context.rows[0];

    return claimed.rows.map((job) => ({
      id: job.id,
      executionId,
      stepId: job.step_id,
      type: job.step_type,
      config: job.config,
      attempt: job.attempts,
      claimId: job.claim_id,
      input: Object.assign({}, input, ...job.depends_on.map((dep) => outputs[dep] ?? {})),
    }));
  });
};

/** Returns false if this claim was fenced off (another worker already took the job over). */
export const completeJob = async (job: ClaimedJob, output: Record<string, unknown>): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE jobs SET status = 'COMPLETED', output = $3, error = NULL, error_code = NULL, completed_at = NOW()
     WHERE id = $1 AND claim_id = $2 AND status = 'RUNNING'`,
    [job.id, job.claimId, JSON.stringify(output)],
  );
  await pool.query(`UPDATE job_attempts SET status = 'COMPLETED', finished_at = NOW() WHERE id = $1 AND status = 'RUNNING'`, [job.claimId]);
  return result.rowCount === 1;
};

const recordFailedAttempt = (job: ClaimedJob, error: JobError) => pool.query(
  `UPDATE job_attempts SET status = 'FAILED', error = $2, error_code = $3, finished_at = NOW() WHERE id = $1 AND status = 'RUNNING'`,
  [job.claimId, error.message, error.code],
);

export const retryJob = async (job: ClaimedJob, error: JobError, retryAt: Date): Promise<void> => {
  await pool.query(
    `UPDATE jobs SET status = 'RETRYING', error = $3, error_code = $4, next_attempt_at = $5
     WHERE id = $1 AND claim_id = $2 AND status = 'RUNNING'`,
    [job.id, job.claimId, error.message, error.code, retryAt],
  );
  await recordFailedAttempt(job, error);
};

/** Permanently fails a job and records it in the dead-letter table, where it can be inspected and replayed. */
export const deadLetterJob = async (job: ClaimedJob, error: JobError): Promise<void> => {
  await transaction(async (client) => {
    const failed = await client.query(
      `UPDATE jobs SET status = 'FAILED', error = $3, error_code = $4, completed_at = NOW()
       WHERE id = $1 AND claim_id = $2 AND status = 'RUNNING'`,
      [job.id, job.claimId, error.message, error.code],
    );
    if (!failed.rowCount) return;
    await client.query(
      `INSERT INTO dead_letter_jobs (job_id, execution_id, error, error_code, attempts) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_id) DO UPDATE SET error = EXCLUDED.error, error_code = EXCLUDED.error_code,
         attempts = EXCLUDED.attempts, created_at = NOW(), replayed_at = NULL`,
      [job.id, job.executionId, error.message, error.code, job.attempt],
    );
  });
  await recordFailedAttempt(job, error);
};

/** Marks jobs whose dependency failed as SKIPPED. Repeats so the skip cascades down the DAG. */
export const skipBlockedJobs = async (executionId: string): Promise<void> => {
  let changed: number | null;
  do {
    ({ rowCount: changed } = await pool.query(
      `UPDATE jobs j SET status = 'SKIPPED', error = 'A dependency failed', completed_at = NOW()
       WHERE j.execution_id = $1 AND j.status IN ('PENDING', 'RETRYING')
         AND EXISTS (
           SELECT 1 FROM jobs d
           WHERE d.execution_id = j.execution_id AND d.step_id = ANY(j.depends_on)
             AND d.status IN ('FAILED', 'SKIPPED', 'CANCELLED')
         )`,
      [executionId],
    ));
  } while (changed);
};

export type Settlement = { done: true } | { done: false; nextAttemptAt: Date };

/**
 * Called when no job is ready to run. Either the execution is finished (all jobs terminal), or some jobs
 * are waiting for a retry: then the execution goes back to QUEUED, due when the earliest retry is due,
 * and the lease is released so any worker can pick it up then.
 */
export const settleExecution = async (executionId: string, workerId: string): Promise<Settlement> => {
  const { rows: [counts] } = await pool.query<{ open: number; failed: number; next_retry: Date | null }>(
    `SELECT count(*) FILTER (WHERE status IN ('PENDING', 'RETRYING', 'RUNNING'))::int AS open,
            count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
            min(next_attempt_at) FILTER (WHERE status = 'RETRYING') AS next_retry
     FROM jobs WHERE execution_id = $1`,
    [executionId],
  );

  if (counts.open > 0) {
    const nextAttemptAt = counts.next_retry ?? new Date();
    const requeued = await pool.query(
      `UPDATE executions SET status = 'QUEUED', next_attempt_at = $3, locked_by = NULL, locked_until = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING'`,
      [executionId, workerId, nextAttemptAt],
    );
    return requeued.rowCount ? { done: false, nextAttemptAt } : { done: true };
  }

  await pool.query(
    `UPDATE executions SET status = $3, error = $4, completed_at = NOW(), locked_by = NULL, locked_until = NULL,
       output = (SELECT COALESCE(jsonb_object_agg(step_id, output), '{}') FROM jobs WHERE execution_id = $1 AND status = 'COMPLETED')
     WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING'`,
    [executionId, workerId, counts.failed ? 'FAILED' : 'COMPLETED', counts.failed ? `${counts.failed} job(s) failed` : null],
  );
  return { done: true };
};

export const heartbeatWorker = async (workerId: string, executionId: string | null): Promise<void> => {
  await pool.query(
    `INSERT INTO workers (id, current_execution) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = NOW(), current_execution = EXCLUDED.current_execution`,
    [workerId, executionId],
  );
};

export const removeWorker = async (workerId: string): Promise<void> => {
  await pool.query('DELETE FROM workers WHERE id = $1', [workerId]);
};
