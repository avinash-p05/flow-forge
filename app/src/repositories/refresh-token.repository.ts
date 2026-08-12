import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { AuthUser } from '../types/auth.types.js';

export const createRefreshToken = async (
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> => {
  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), userId, tokenHash, expiresAt],
  );
};

export const rotateRefreshToken = async (
  tokenHash: string,
  replacementHash: string,
  replacementExpiresAt: Date,
): Promise<AuthUser | null> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ user_id: string; email: string }>(
      `SELECT refresh_tokens.user_id, users.email
       FROM refresh_tokens
       JOIN users ON users.id = refresh_tokens.user_id
       WHERE refresh_tokens.token_hash = $1
         AND refresh_tokens.revoked_at IS NULL
         AND refresh_tokens.expires_at > NOW()
       FOR UPDATE`,
      [tokenHash],
    );
    const record = result.rows[0];
    if (!record) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1',
      [tokenHash],
    );
    await client.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), record.user_id, replacementHash, replacementExpiresAt],
    );
    await client.query('COMMIT');
    return { id: record.user_id, email: record.email };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const revokeRefreshToken = async (tokenHash: string): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  return result.rowCount === 1;
};
