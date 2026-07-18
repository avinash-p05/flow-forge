export type AuthConfig = {
  secret: Uint8Array;
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
};

class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

const encoder = new TextEncoder();
let cachedConfig: AuthConfig | undefined;

const requiredString = (name: string, value: string | undefined): string => {
  if (!value?.trim()) {
    throw new AuthConfigError(`${name} must be configured`);
  }
  return value.trim();
};

const positiveInteger = (name: string, value: string | undefined, fallback: string): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AuthConfigError(`${name} must be a positive integer`);
  }
  return parsed;
};

export const getAuthConfig = (): AuthConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }

  const secret = requiredString('AUTH_TOKEN_SECRET', process.env.AUTH_TOKEN_SECRET);
  if (secret.length < 32) {
    throw new AuthConfigError('AUTH_TOKEN_SECRET must be at least 32 characters');
  }

  cachedConfig = {
    secret: encoder.encode(secret),
    issuer: requiredString('AUTH_TOKEN_ISSUER', process.env.AUTH_TOKEN_ISSUER ?? 'flowforge-server'),
    audience: requiredString('AUTH_TOKEN_AUDIENCE', process.env.AUTH_TOKEN_AUDIENCE ?? 'flowforge-client'),
    accessTokenTtlSeconds: positiveInteger(
      'AUTH_ACCESS_TOKEN_TTL_SECONDS',
      process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      '3600',
    ),
    refreshTokenTtlSeconds: positiveInteger(
      'AUTH_REFRESH_TOKEN_TTL_SECONDS',
      process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      '604800',
    ),
  };

  return cachedConfig;
};
