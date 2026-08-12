import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { pool } from '../db/pool.js';

export type AuditEvent = QueryResultRow & {
  id: string;
  event_type: string;
  payload: unknown;
  created_at: Date;
};

export const recordAuditEvent = async (
  executionId: string,
  eventType: string,
  payload: unknown,
): Promise<void> => {
  await pool.query(
    `INSERT INTO audit_logs (id, execution_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [randomUUID(), executionId, eventType, JSON.stringify(payload)],
  );
};

export const listAuditEvents = async (
  executionId: string,
  userId: string,
): Promise<AuditEvent[] | null> => {
  const access = await pool.query(
    'SELECT 1 FROM workflow_executions WHERE id = $1 AND user_id = $2',
    [executionId, userId],
  );
  if (access.rowCount === 0) return null;
  const result = await pool.query<AuditEvent>(
    `SELECT audit_logs.id, audit_logs.event_type, audit_logs.payload, audit_logs.created_at
     FROM audit_logs
     JOIN workflow_executions ON workflow_executions.id = audit_logs.execution_id
     WHERE audit_logs.execution_id = $1 AND workflow_executions.user_id = $2
     ORDER BY audit_logs.created_at`,
    [executionId, userId],
  );
  return result.rows;
};
