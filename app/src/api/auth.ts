import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { config } from '../infra/config.js';
import { pool } from '../infra/db.js';

declare global {
  namespace Express {
    interface Request { userId?: string }
  }
}

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;
const secret = new TextEncoder().encode(config.auth.secret);

const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString('base64url')}.${hash.toString('base64url')}`;
};

const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [salt, hash] = stored.split('.');
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), 64);
  return timingSafeEqual(expected, actual);
};

const issueToken = (userId: string): Promise<string> =>
  new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt()
    .setExpirationTime(`${config.auth.tokenTtlSeconds}s`).sign(secret);

/** Express middleware: requires `Authorization: Bearer <jwt>` and sets request.userId. */
export const requireAuth = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  const token = request.header('authorization')?.replace(/^Bearer /, '');
  try {
    const { payload } = await jwtVerify(token ?? '', secret, { algorithms: ['HS256'] });
    request.userId = payload.sub;
    next();
  } catch {
    response.status(401).json({ error: 'Valid bearer token required' });
  }
};

const readCredentials = (body: unknown): { email: string; password: string } | null => {
  const { email, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (typeof password !== 'string' || password.length < 8) return null;
  return { email: email.trim().toLowerCase(), password };
};

export const authRouter = Router();

authRouter.post('/register', async (request, response) => {
  const credentials = readCredentials(request.body);
  if (!credentials) {
    response.status(400).json({ error: 'A valid email and a password of at least 8 characters are required' });
    return;
  }
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [randomUUID(), credentials.email, await hashPassword(credentials.password)],
  );
  if (!result.rowCount) {
    response.status(409).json({ error: 'Email is already registered' });
    return;
  }
  response.status(201).json({ userId: result.rows[0].id, token: await issueToken(result.rows[0].id) });
});

authRouter.post('/login', async (request, response) => {
  const credentials = readCredentials(request.body);
  const user = credentials && (await pool.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE email = $1', [credentials.email],
  )).rows[0];
  if (!credentials || !user || !(await verifyPassword(credentials.password, user.password_hash))) {
    response.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  response.json({ userId: user.id, token: await issueToken(user.id) });
});
