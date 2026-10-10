import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { pool } from '../infra/db.js';
import { validateDefinition, ValidationError } from '../engine/rules.js';
import { requireAuth } from './auth.js';

export const isUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export const workflowRouter = Router();
workflowRouter.use(requireAuth);

workflowRouter.post('/', async (request, response) => {
  const { name, definition } = request.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    response.status(400).json({ error: 'name is required' });
    return;
  }
  try {
    const valid = validateDefinition(definition);
    const result = await pool.query(
      `INSERT INTO workflows (id, user_id, name, definition) VALUES ($1, $2, $3, $4)
       RETURNING id, name, definition, created_at AS "createdAt"`,
      [randomUUID(), request.userId, name.trim(), JSON.stringify(valid)],
    );
    response.status(201).json(result.rows[0]);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    response.status(400).json({ error: error.message });
  }
});

workflowRouter.get('/', async (request, response) => {
  const result = await pool.query(
    `SELECT id, name, definition, created_at AS "createdAt" FROM workflows WHERE user_id = $1 ORDER BY created_at DESC`,
    [request.userId],
  );
  response.json(result.rows);
});

workflowRouter.get('/:id', async (request, response) => {
  const result = isUuid(request.params.id) ? await pool.query(
    `SELECT id, name, definition, created_at AS "createdAt" FROM workflows WHERE id = $1 AND user_id = $2`,
    [request.params.id, request.userId],
  ) : { rows: [] };
  if (!result.rows[0]) {
    response.status(404).json({ error: 'Workflow not found' });
    return;
  }
  response.json(result.rows[0]);
});

workflowRouter.delete('/:id', async (request, response) => {
  const result = isUuid(request.params.id)
    ? await pool.query('DELETE FROM workflows WHERE id = $1 AND user_id = $2', [request.params.id, request.userId])
    : { rowCount: 0 };
  response.status(result.rowCount ? 204 : 404).end();
});
