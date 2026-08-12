import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getAuthConfig } from '../config/auth.config.js';
import { createUser, findUserByEmail } from '../repositories/auth.repository.js';
import {
  createRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
} from '../repositories/refresh-token.repository.js';
import { createToken } from '../utils/auth.tokens.js';

const scrypt = promisify(scryptCallback);

const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const newRefreshToken = (): { token: string; hash: string; expiresAt: Date } => {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + getAuthConfig().refreshTokenTtlSeconds * 1000);
  return { token, hash: hashRefreshToken(token), expiresAt };
};

const issueTokens = async (user: { id: string; email: string }) => {
  const refresh = newRefreshToken();
  await createRefreshToken(user.id, refresh.hash, refresh.expiresAt);
  return {
    user,
    token: await createToken(user),
    refreshToken: refresh.token,
  };
};

export class AuthValidationError extends Error {}

const validateCredentials = (email: unknown, password: unknown): { email: string; password: string } => {
  if (
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    typeof password !== 'string' ||
    password.length < 8
  ) {
    throw new AuthValidationError('A valid email and password of at least 8 characters are required');
  }
  return { email: email.trim().toLowerCase(), password };
};

const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `${salt.toString('base64url')}.${derived.toString('base64url')}`;
};

const verifyPassword = async (password: string, encoded: string): Promise<boolean> => {
  const [saltValue, hashValue] = encoded.split('.');
  if (!saltValue || !hashValue) return false;
  const derived = await scrypt(password, Buffer.from(saltValue, 'base64url'), 64) as Buffer;
  const expected = Buffer.from(hashValue, 'base64url');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
};

export const register = async (emailValue: unknown, passwordValue: unknown) => {
  const { email, password } = validateCredentials(emailValue, passwordValue);
  if (await findUserByEmail(email)) return null;
  const user = await createUser(email, await hashPassword(password));
  return issueTokens(user);
};

export const login = async (emailValue: unknown, passwordValue: unknown) => {
  const { email, password } = validateCredentials(emailValue, passwordValue);
  const user = await findUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) return null;
  return issueTokens({ id: user.id, email: user.email });
};

export const refresh = async (tokenValue: unknown) => {
  if (typeof tokenValue !== 'string' || tokenValue.length < 20) return null;
  const replacement = newRefreshToken();
  const user = await rotateRefreshToken(
    hashRefreshToken(tokenValue),
    replacement.hash,
    replacement.expiresAt,
  );
  if (!user) return null;
  return {
    user,
    token: await createToken(user),
    refreshToken: replacement.token,
  };
};

export const logout = async (tokenValue: unknown): Promise<boolean> => {
  if (typeof tokenValue !== 'string' || tokenValue.length < 20) return false;
  return revokeRefreshToken(hashRefreshToken(tokenValue));
};
