import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { pool } from '../db/pool.js';
import type { Workflow, WorkflowDefinition } from '../types/workflow.types.js';

type WorkflowRow = QueryResultRow & {
  id: string;
  name: string;
  version: number;
  definition: WorkflowDefinition;
  created_at: Date;
  updated_at: Date;
};

const toWorkflow = (row: WorkflowRow): Workflow => ({
  id: row.id,
  name: row.name,
  version: row.version,
  definition: row.definition,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const listWorkflows = async (userId: string): Promise<Workflow[]> => {
  const result = await pool.query<WorkflowRow>(
    `SELECT id, name, version, definition, created_at, updated_at
     FROM workflows WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map(toWorkflow);
};

export const findWorkflowById = async (id: string, userId: string): Promise<Workflow | null> => {
  const result = await pool.query<WorkflowRow>(
    `SELECT id, name, version, definition, created_at, updated_at
     FROM workflows WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ? toWorkflow(result.rows[0]) : null;
};

export const findWorkflowDefinition = async (
  id: string,
  userId: string,
): Promise<WorkflowDefinition | null> => {
  const result = await pool.query<{ definition: WorkflowDefinition }>(
    'SELECT definition FROM workflows WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rows[0]?.definition ?? null;
};

export const createWorkflow = async (
  name: string,
  definition: WorkflowDefinition,
  userId: string,
): Promise<Workflow> => {
  const result = await pool.query<WorkflowRow>(
    `INSERT INTO workflows (id, name, version, definition, user_id)
     VALUES ($1, $2, 1, $3::jsonb, $4)
     RETURNING id, name, version, definition, created_at, updated_at`,
    [randomUUID(), name, JSON.stringify(definition), userId],
  );
  return toWorkflow(result.rows[0]);
};

export const updateWorkflow = async (
  id: string,
  name: string,
  definition: WorkflowDefinition,
  userId: string,
): Promise<Workflow | null> => {
  const result = await pool.query<WorkflowRow>(
    `UPDATE workflows
     SET name = $2, definition = $3::jsonb, version = version + 1, updated_at = NOW()
     WHERE id = $1 AND user_id = $4
     RETURNING id, name, version, definition, created_at, updated_at`,
    [id, name, JSON.stringify(definition), userId],
  );
  return result.rows[0] ? toWorkflow(result.rows[0]) : null;
};

export const deleteWorkflow = async (id: string, userId: string): Promise<boolean> => {
  const result = await pool.query(
    'DELETE FROM workflows WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rowCount === 1;
};
