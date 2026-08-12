import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { pool } from '../db/pool.js';

export type UserRecord = QueryResultRow & {
  id: string;
  email: string;
  password_hash: string;
};

export const findUserByEmail = async (email: string): Promise<UserRecord | null> => {
  const result = await pool.query<UserRecord>(
    'SELECT id, email, password_hash FROM users WHERE email = $1',
    [email],
  );
  return result.rows[0] ?? null;
};

export const createUser = async (email: string, passwordHash: string): Promise<{ id: string; email: string }> => {
  const result = await pool.query<{ id: string; email: string }>(
    `INSERT INTO users (id, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, email`,
    [randomUUID(), email, passwordHash],
  );
  return result.rows[0];
};
