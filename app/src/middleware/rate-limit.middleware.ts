import type { NextFunction, Request, Response } from 'express';
import { getRateLimitConfig } from '../config/rate-limit.config.js';
import { ensureRedisConnection } from '../infrastructure/redis.client.js';
const config = getRateLimitConfig();

export const rateLimit = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  if (!process.env.REDIS_URL?.trim()) {
    response.status(503).json({ error: 'Rate limiting is not configured' });
    return;
  }

  try {
    const redis = await ensureRedisConnection();
    if (!redis) {
      response.status(503).json({ error: 'Rate limiting is not configured' });
      return;
    }
    const key = `flowforge:rate-limit:${request.user?.id ?? request.ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, config.windowSeconds);
    if (count > config.maxRequests) {
      response.setHeader('Retry-After', config.windowSeconds);
      response.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }
    next();
  } catch (error) {
    console.error('Rate limiter unavailable', error);
    response.status(503).json({ error: 'Rate limiter temporarily unavailable' });
  }
};
