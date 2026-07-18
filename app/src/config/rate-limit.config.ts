export type RateLimitConfig = {
  windowSeconds: number;
  maxRequests: number;
};

const positiveInteger = (name: string, value: string | undefined, fallback: string): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

export const getRateLimitConfig = (): RateLimitConfig => ({
  windowSeconds: positiveInteger('RATE_LIMIT_WINDOW_SECONDS', process.env.RATE_LIMIT_WINDOW_SECONDS, '60'),
  maxRequests: positiveInteger('RATE_LIMIT_MAX_REQUESTS', process.env.RATE_LIMIT_MAX_REQUESTS, '30'),
});
