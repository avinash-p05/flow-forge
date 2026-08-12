import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { pool } from '../db/pool.js';
import type { WorkflowDefinition } from '../types/workflow.types.js';
import type { JobExecution, WorkflowExecution } from '../types/execution.types.js';

type ExecutionRow = QueryResultRow & {
  id: string;
  workflow_id: string;
  status: WorkflowExecution['status'];
  idempotency_key: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  next_attempt_at: Date | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
};

type JobRow = QueryResultRow & {
  id: string;
  execution_id: string;
  step_id: string;
  step_name: string;
  step_type: string;
  step_config: Record<string, unknown>;
  step_order: number;
  status: JobExecution['status'];
  attempts: number;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  next_attempt_at: Date | null;
  depends_on: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error_code: string | null;
};

const toExecution = (row: ExecutionRow): WorkflowExecution => ({
  id: row.id,
  workflowId: row.workflow_id,
  status: row.status,
  idempotencyKey: row.idempotency_key,
  error: row.error,
  createdAt: row.created_at.toISOString(),
  startedAt: row.started_at?.toISOString() ?? null,
  completedAt: row.completed_at?.toISOString() ?? null,
  input: row.input ?? {},
  output: row.output ?? null,
});

const toJob = (row: JobRow): JobExecution => ({
  id: row.id,
  executionId: row.execution_id,
  stepId: row.step_id,
  stepName: row.step_name,
  stepType: row.step_type,
  stepConfig: row.step_config,
  stepOrder: row.step_order,
  status: row.status,
  attempts: row.attempts,
  error: row.error,
  startedAt: row.started_at?.toISOString() ?? null,
  completedAt: row.completed_at?.toISOString() ?? null,
  input: row.input ?? {},
  output: row.output ?? null,
  errorCode: row.error_code,
});

export const createExecution = async (
  workflowId: string,
  userId: string,
  definition: WorkflowDefinition,
  idempotencyKey: string | null,
  input: Record<string, unknown> = {},
): Promise<WorkflowExecution> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = idempotencyKey
      ? await client.query<ExecutionRow>(
          `SELECT id, workflow_id, status, idempotency_key, error, created_at, started_at, completed_at, next_attempt_at, input, output
           FROM workflow_executions WHERE user_id = $1 AND idempotency_key = $2`,
          [userId, idempotencyKey],
        )
      : { rows: [] };
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return toExecution(existing.rows[0]);
    }

    const executionId = randomUUID();
    const result = await client.query<ExecutionRow>(
      `INSERT INTO workflow_executions (id, workflow_id, user_id, status, idempotency_key, input, next_attempt_at)
       VALUES ($1, $2, $3, 'QUEUED', $4, $5::jsonb, NOW())
       RETURNING id, workflow_id, status, idempotency_key, error, created_at, started_at, completed_at, next_attempt_at, input, output`,
      [executionId, workflowId, userId, idempotencyKey, JSON.stringify(input)],
    );
    for (const [stepOrder, step] of definition.steps.entries()) {
      await client.query(
        `INSERT INTO job_executions
          (id, execution_id, step_id, step_name, step_type, step_config, depends_on, step_order, status, input)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'PENDING', $9::jsonb)`,
        [randomUUID(), executionId, step.id, step.name, step.type, JSON.stringify(step.config), step.dependsOn, stepOrder, JSON.stringify(input)],
      );
    }
    await client.query('COMMIT');
    return toExecution(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (idempotencyKey && typeof error === 'object' && error !== null &&
        'code' in error && error.code === '23505') {
      const existing = await pool.query<ExecutionRow>(
        `SELECT id, workflow_id, status, idempotency_key, error, created_at, started_at, completed_at, next_attempt_at, input, output
         FROM workflow_executions WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (existing.rows[0]) return toExecution(existing.rows[0]);
    }
    throw error;
  } finally {
    client.release();
  }
};

export const findExecution = async (id: string, userId: string): Promise<WorkflowExecution | null> => {
  const result = await pool.query<ExecutionRow>(
    `SELECT id, workflow_id, status, idempotency_key, error, created_at, started_at, completed_at, next_attempt_at, input, output
     FROM workflow_executions WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ? toExecution(result.rows[0]) : null;
};

export const findExecutionForWorker = async (id: string): Promise<WorkflowExecution | null> => {
  const result = await pool.query<ExecutionRow>(
    `SELECT id, workflow_id, status, idempotency_key, error, created_at, started_at, completed_at, next_attempt_at, input
     FROM workflow_executions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? toExecution(result.rows[0]) : null;
};

export const reconcileExecution = async (executionId: string): Promise<'COMPLETED' | 'BLOCKED' | 'WAITING'> => {
  const result = await pool.query<{ pending: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('PENDING','RETRYING')) AS pending,
            count(*) FILTER (WHERE status IN ('FAILED','BLOCKED')) AS failed
     FROM job_executions WHERE execution_id = $1`,
    [executionId],
  );
  const row = result.rows[0];
  if (Number(row.pending) > 0) return Number(row.failed) > 0 ? 'BLOCKED' : 'WAITING';
  return Number(row.failed) > 0 ? 'BLOCKED' : 'COMPLETED';
};

export const listJobs = async (executionId: string, userId: string): Promise<JobExecution[] | null> => {
  const access = await pool.query('SELECT 1 FROM workflow_executions WHERE id = $1 AND user_id = $2', [executionId, userId]);
  if (access.rowCount === 0) return null;
  const result = await pool.query<JobRow>(
    `SELECT id, execution_id, step_id, step_name, step_type, step_config, depends_on, step_order, status, attempts, error, error_code, input, output, started_at, completed_at
     FROM job_executions WHERE execution_id = $1 ORDER BY step_order`,
    [executionId],
  );
  return result.rows.map(toJob);
};

export const cancelExecution = async (id: string, userId: string): Promise<boolean> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE workflow_executions
       SET status = 'CANCELLED', completed_at = NOW(), next_attempt_at = NULL
       WHERE id = $1 AND user_id = $2 AND status IN ('PENDING', 'QUEUED', 'RETRYING')`,
      [id, userId],
    );
    if (result.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE job_executions SET status = 'CANCELLED', completed_at = NOW(), next_attempt_at = NULL
       WHERE execution_id = $1 AND status IN ('PENDING', 'RETRYING')`,
      [id],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const claimNextExecution = async (): Promise<string | null> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string }>(
      `SELECT id FROM workflow_executions
       WHERE status IN ('QUEUED', 'RETRYING')
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const execution = result.rows[0];
    if (!execution) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `UPDATE workflow_executions SET status = 'RUNNING', started_at = COALESCE(started_at, NOW()), next_attempt_at = NULL
       WHERE id = $1`,
      [execution.id],
    );
    await client.query('COMMIT');
    return execution.id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const claimExecution = async (executionId: string): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE workflow_executions
     SET status = 'RUNNING', started_at = COALESCE(started_at, NOW()), next_attempt_at = NULL
     WHERE id = $1
       AND status IN ('QUEUED', 'RETRYING')
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())`,
    [executionId],
  );
  return result.rowCount === 1;
};

export const claimReadyJobs = async (executionId: string, limit = 10): Promise<JobExecution[]> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const executionResult = await client.query<{ input: Record<string, unknown> }>(
      'SELECT input FROM workflow_executions WHERE id = $1 FOR UPDATE',
      [executionId],
    );
    const executionInput = executionResult.rows[0]?.input ?? {};
    const result = await client.query<JobRow>(
    `SELECT j.id, j.execution_id, j.step_id, j.step_name, j.step_type, j.step_config,
            j.depends_on, j.input, j.output, j.error_code,
            j.step_order, j.status, j.attempts, j.error, j.started_at, j.completed_at, j.next_attempt_at
     FROM job_executions j
     WHERE j.execution_id = $1
       AND j.status IN ('PENDING', 'RETRYING')
       AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= NOW())
       AND NOT EXISTS (
         SELECT 1
         FROM unnest(j.depends_on) dependency_id
         WHERE NOT EXISTS (
           SELECT 1 FROM job_executions dependency
           WHERE dependency.execution_id = j.execution_id
             AND dependency.step_id = dependency_id
             AND dependency.status = 'COMPLETED'
         )
       )
     ORDER BY j.step_order LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [executionId, limit],
    );
    for (const job of result.rows) {
      const dependencyResult = await client.query<{ output: Record<string, unknown> | null }>(
        `SELECT output FROM job_executions
         WHERE execution_id = $1 AND step_id = ANY($2) AND status = 'COMPLETED'`,
        [executionId, job.depends_on],
      );
      const input = dependencyResult.rows.reduce<Record<string, unknown>>(
        (merged, dependency) => ({ ...merged, ...(dependency.output ?? {}) }),
        { ...executionInput, ...(job.input ?? {}) },
      );
      await client.query(
        `UPDATE job_executions
         SET status = 'RUNNING', attempts = attempts + 1, input = $2::jsonb,
             claimed_at = NOW(), started_at = COALESCE(started_at, NOW())
         WHERE id = $1`,
        [job.id, JSON.stringify(input)],
      );
      job.input = input;
      job.attempts += 1;
      await client.query(
        `INSERT INTO job_attempts (id, job_id, attempt, status, input)
         VALUES ($1, $2, $3, 'RUNNING', $4::jsonb)`,
        [randomUUID(), job.id, job.attempts, JSON.stringify(input)],
      );
    }
    await client.query('COMMIT');
    return result.rows.map(toJob);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};

export const findNextJob = async (executionId: string): Promise<JobExecution | null> => (await claimReadyJobs(executionId, 1))[0] ?? null;

export const completeJob = async (jobId: string, output: Record<string, unknown> = {}): Promise<void> => {
  await pool.query(
    `UPDATE job_executions SET status = 'COMPLETED', output = $2::jsonb, next_attempt_at = NULL, completed_at = NOW(), claimed_at = NULL
     WHERE id = $1`,
    [jobId, JSON.stringify(output)],
  );
  await pool.query(`UPDATE job_attempts SET status = 'COMPLETED', output = $2::jsonb, completed_at = NOW() WHERE job_id = $1::uuid AND status = 'RUNNING'`, [jobId, JSON.stringify(output)]);
};

export const retryJob = async (
  executionId: string,
  jobId: string,
  error: string,
  nextAttemptAt: Date,
  errorCode = 'HANDLER_ERROR',
): Promise<void> => {
  await pool.query(
    `UPDATE job_executions SET status = 'RETRYING', error = $2, error_code = $4, next_attempt_at = $3, claimed_at = NULL
     WHERE id = $1::uuid`,
    [jobId, error, nextAttemptAt, errorCode],
  );
  await pool.query(`UPDATE job_attempts SET status = 'FAILED', error = $2, error_code = $3, completed_at = NOW() WHERE job_id = $1::uuid AND status = 'RUNNING'`, [jobId, error, errorCode]);
  await pool.query(
    `UPDATE workflow_executions SET status = 'RETRYING', next_attempt_at = $2, error = $3
     WHERE id = $1`,
    [executionId, nextAttemptAt, error],
  );
};

export const failJobPermanently = async (
  executionId: string,
  jobId: string,
  error: string,
  errorCode = 'HANDLER_ERROR',
): Promise<void> => {
  await pool.query(
    `UPDATE job_executions SET status = 'FAILED', error = $2, error_code = $3, completed_at = NOW(), claimed_at = NULL
     WHERE id = $1::uuid`,
    [jobId, error, errorCode],
  );
  await pool.query(`UPDATE job_attempts SET status = 'FAILED', error = $2, error_code = $3, completed_at = NOW() WHERE job_id = $1::uuid AND status = 'RUNNING'`, [jobId, error, errorCode]);
  await pool.query(
    `INSERT INTO dead_letter_jobs (id, execution_id, job_id, error, attempts)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4, attempts FROM job_executions WHERE id = $3::uuid`,
    [randomUUID(), executionId, jobId, error],
  );
  await finishExecution(executionId, 'FAILED', error);
};

export const skipBlockedJobs = async (executionId: string): Promise<void> => {
  await pool.query(
    `UPDATE job_executions j SET status = 'SKIPPED', error = 'Dependency failed or was skipped', completed_at = NOW()
     WHERE j.execution_id = $1 AND j.status IN ('PENDING', 'RETRYING')
       AND EXISTS (SELECT 1 FROM job_executions d WHERE d.execution_id = j.execution_id AND d.step_id = ANY(j.depends_on) AND d.status IN ('FAILED', 'SKIPPED', 'CANCELLED'))`,
    [executionId],
  );
};

export const releaseStaleJobs = async (timeoutMs: number): Promise<void> => {
  await pool.query(
    `UPDATE job_executions
     SET status = 'RETRYING', next_attempt_at = NOW(), claimed_at = NULL,
         error = 'Worker claim expired', error_code = 'WORKER_LOST'
     WHERE status = 'RUNNING' AND claimed_at < NOW() - ($1 * INTERVAL '1 millisecond')`,
    [timeoutMs],
  );
};

export const finishExecution = async (
  executionId: string,
  status: 'COMPLETED' | 'FAILED',
  error: string | null = null,
  output: Record<string, unknown> | null = null,
): Promise<void> => {
  const outputResult = output === null
    ? await pool.query<{ step_id: string; output: Record<string, unknown> | null }>(
        `SELECT step_id, output FROM job_executions WHERE execution_id = $1 AND status = 'COMPLETED'`,
        [executionId],
      )
    : null;
  const finalOutput = output ?? Object.fromEntries(
    (outputResult?.rows ?? []).map((row) => [row.step_id, row.output ?? {}]),
  );
  await pool.query(
    `UPDATE workflow_executions SET status = $2, error = $3, output = $4::jsonb, next_attempt_at = NULL, completed_at = NOW()
     WHERE id = $1`,
    [executionId, status, error, JSON.stringify(finalOutput)],
  );
};
