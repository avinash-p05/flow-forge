import { createRequire } from 'node:module';

export type RedisClient = {
  status: string;
  connect: () => Promise<void>;
  get: (key: string) => Promise<string | null>;
  setex: (key: string, seconds: number, value: string) => Promise<string>;
  del: (key: string) => Promise<number>;
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
};

const require = createRequire(import.meta.url);
const Redis = require('ioredis') as new (
  url: string,
  options: { lazyConnect: boolean; maxRetriesPerRequest: number },
) => RedisClient;

const redisUrl = process.env.REDIS_URL?.trim();

export const redis: RedisClient | null = redisUrl
  ? new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  : null;

export const ensureRedisConnection = async (): Promise<RedisClient | null> => {
  if (!redis) return null;
  if (redis.status === 'wait') await redis.connect();
  return redis;
};
