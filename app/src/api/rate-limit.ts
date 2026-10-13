import type { NextFunction, Request, Response } from 'express';
import { config } from '../infra/config.js';
import { log } from '../infra/log.js';
import { redis } from '../infra/redis.js';

const { windowSeconds, maxRequests } = config.rateLimit;

/**
 * Fixed-window rate limit per user, shared by every API instance through Redis.
 * Key = user + current window number; INCR and EXPIRE run in one MULTI so the key always expires.
 * If Redis is unavailable we fail open: the limiter protects the system but must not take it down.
 */
export const rateLimit = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  if (!redis) return next();
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `ratelimit:${request.userId ?? request.ip}:${window}`;
  try {
    const results = await redis.multi().incr(key).expire(key, windowSeconds).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const resetSeconds = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
    response.setHeader('X-RateLimit-Limit', maxRequests);
    response.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - count));
    if (count > maxRequests) {
      response.setHeader('Retry-After', resetSeconds);
      response.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }
  } catch (error) {
    log('ratelimit.unavailable', { error: error instanceof Error ? error.message : String(error) });
  }
  next();
};
