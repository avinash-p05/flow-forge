import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { getAuthConfig } from '../config/auth.config.js';
import type { AuthUser } from '../types/auth.types.js';

export const createToken = async (user: AuthUser): Promise<string> => {
  const config = getAuthConfig();

  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(config.secret);
};

export const verifyToken = async (token: string): Promise<AuthUser | null> => {
  const config = getAuthConfig();

  try {
    const { payload } = await jwtVerify(token, config.secret, {
      algorithms: ['HS256'],
      issuer: config.issuer,
      audience: config.audience,
    });
    const decoded = payload as JWTPayload & { email?: unknown };
    if (
      typeof decoded.sub !== 'string' ||
      typeof decoded.email !== 'string' ||
      typeof decoded.exp !== 'number'
    ) return null;
    return { id: decoded.sub, email: decoded.email };
  } catch {
    return null;
  }
};
