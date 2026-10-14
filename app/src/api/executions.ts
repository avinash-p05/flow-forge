import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { pool, transaction } from '../infra/db.js';
import type { WorkflowDefinition } from '../engine/rules.js';
import { log } from '../infra/log.js';
import { enqueueExecution } from '../infra/queue.js';
import { requireAuth } from './auth.js';
import { rateLimit } from './rate-limit.js';
import { isUuid } from './workflows.js';

export const executionRouter = Router();
executionRouter.use(requireAuth);

const EXECUTION_COLUMNS = `id, workflow_id AS "workflowId", status, idempotency_key AS "idempotencyKey", input, output, error,
  created_at AS "createdAt", started_at AS "startedAt", completed_at AS "completedAt"`;

/**
 * Submit a run. Idempotent: the same `Idempotency-Key` header from the same user always returns the
 * same execution, even for concurrent requests, because of the UNIQUE (user_id, idempotency_key)
 * constraint plus INSERT ... ON CONFLICT DO NOTHING.
 */
executionRouter.post('/workflows/:workflowId/executions', rateLimit, async (request, response) => {
  const workflowId = String(request.params.workflowId);
  const idempotencyKey = request.header('idempotency-key')?.slice(0, 255) || null;
  const input = request.body?.input ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    response.status(400).json({ error: 'input must be an object' });
    return;
  }

  const workflow = isUuid(workflowId) ? (await pool.query<{ definition: WorkflowDefinition }>(
    'SELECT definition FROM workflows WHERE id = $1 AND user_id = $2', [workflowId, request.userId],
  )).rows[0] : undefined;
  if (!workflow) {
    response.status(404).json({ error: 'Workflow not found' });
    return;
  }

  const created = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO executions (id, workflow_id, user_id, status, idempotency_key, input)
       VALUES ($1, $2, $3, 'QUEUED', $4, $5)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [randomUUID(), workflowId, request.userId, idempotencyKey, JSON.stringify(input)],
    );
    const executionId = inserted.rows[0]?.id;
    if (!executionId) return null;
    const { steps } = workflow.definition;
    await client.query(
      `INSERT INTO jobs (id, execution_id, step_id, step_type, config, depends_on, step_order, status)
       SELECT gen_random_uuid(), $1, s.step_id, s.step_type, s.config,
              ARRAY(SELECT jsonb_array_elements_text(s.depends_on)), s.step_order, 'PENDING'
       FROM jsonb_to_recordset($2::jsonb) AS s(step_id text, step_type text, config jsonb, depends_on jsonb, step_order int)`,
      [executionId, JSON.stringify(steps.map((step, index) => ({
        step_id: step.id, step_type: step.type, config: step.config, depends_on: step.dependsOn, step_order: index,
      })))],
    );
    return executionId;
  });

  if (created) {
    const execution = (await pool.query(`SELECT ${EXECUTION_COLUMNS} FROM executions WHERE id = $1`, [created])).rows[0];
    // If this fails the execution is still safe in PostgreSQL; workers' database sweep will pick it up.
    await enqueueExecution(created).catch((error: Error) => log('queue.enqueue_failed', { executionId: created, error: error.message }));
    response.status(202).json(execution);
    return;
  }

  const existing = (await pool.query(
    `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE user_id = $1 AND idempotency_key = $2`,
    [request.userId, idempotencyKey],
  )).rows[0];
  if (existing.workflowId !== workflowId) {
    response.status(422).json({ error: 'Idempotency-Key was already used for a different workflow' });
    return;
  }
  response.setHeader('Idempotent-Replay', 'true');
  response.status(200).json(existing);
});

executionRouter.get('/executions/:id', async (request, response) => {
  const execution = isUuid(request.params.id) ? (await pool.query(
    `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE id = $1 AND user_id = $2`, [request.params.id, request.userId],
  )).rows[0] : undefined;
  if (!execution) {
    response.status(404).json({ error: 'Execution not found' });
    return;
  }
  const jobs = await pool.query(
    `SELECT id, step_id AS "stepId", step_type AS "type", status, attempts, output, error, error_code AS "errorCode",
            started_at AS "startedAt", completed_at AS "completedAt"
     FROM jobs WHERE execution_id = $1 ORDER BY step_order`,
    [execution.id],
  );
  response.json({ ...execution, jobs: jobs.rows });
});

executionRouter.post('/executions/:id/cancel', async (request, response) => {
  const cancelled = isUuid(request.params.id) && await transaction(async (client) => {
    const result = await client.query(
      `UPDATE executions SET status = 'CANCELLED', completed_at = NOW(), locked_by = NULL, locked_until = NULL
       WHERE id = $1 AND user_id = $2 AND status IN ('QUEUED', 'RUNNING')`,
      [request.params.id, request.userId],
    );
    if (!result.rowCount) return false;
    await client.query(
      `UPDATE jobs SET status = 'CANCELLED', completed_at = NOW() WHERE execution_id = $1 AND status IN ('PENDING', 'RETRYING')`,
      [request.params.id],
    );
    return true;
  });
  if (!cancelled) {
    response.status(409).json({ error: 'Execution not found or already finished' });
    return;
  }
  response.status(204).end();
});

/** Jobs that exhausted their retries, newest first. */
executionRouter.get('/dead-letters', async (request, response) => {
  const result = await pool.query(
    `SELECT d.job_id AS "jobId", d.execution_id AS "executionId", j.step_id AS "stepId", d.error, d.error_code AS "errorCode",
            d.attempts, d.created_at AS "createdAt"
     FROM dead_letter_jobs d
     JOIN jobs j ON j.id = d.job_id
     JOIN executions e ON e.id = d.execution_id
     WHERE e.user_id = $1 AND d.replayed_at IS NULL
     ORDER BY d.created_at DESC LIMIT 100`,
    [request.userId],
  );
  response.json(result.rows);
});

/**
 * Replays a dead-lettered job: it gets a fresh set of attempts, the steps that were skipped because of it
 * go back to PENDING, and the execution is queued again.
 */
executionRouter.post('/dead-letters/:jobId/replay', async (request, response) => {
  const executionId = isUuid(request.params.jobId) && await transaction(async (client) => {
    const entry = (await client.query<{ execution_id: string }>(
      `UPDATE dead_letter_jobs d SET replayed_at = NOW()
       FROM executions e
       WHERE d.job_id = $1 AND d.replayed_at IS NULL AND e.id = d.execution_id AND e.user_id = $2
         AND e.status IN ('FAILED', 'QUEUED', 'RUNNING')
       RETURNING d.execution_id`,
      [request.params.jobId, request.userId],
    )).rows[0];
    if (!entry) return null;
    await client.query(
      `UPDATE jobs SET status = 'PENDING', attempts = 0, claim_id = NULL, error = NULL, error_code = NULL,
                       next_attempt_at = '-infinity', completed_at = NULL
       WHERE id = $1 OR (execution_id = $2 AND status = 'SKIPPED')`,
      [request.params.jobId, entry.execution_id],
    );
    await client.query(
      `UPDATE executions SET status = 'QUEUED', next_attempt_at = '-infinity', error = NULL, completed_at = NULL
       WHERE id = $1 AND status = 'FAILED'`,
      [entry.execution_id],
    );
    return entry.execution_id;
  });
  if (!executionId) {
    response.status(404).json({ error: 'Dead-lettered job not found' });
    return;
  }
  await enqueueExecution(executionId).catch(() => {});
  response.status(202).json({ executionId });
});
