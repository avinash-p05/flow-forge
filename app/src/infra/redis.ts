import { Redis } from 'ioredis';
import { config } from './config.js';

export const redis = config.redisUrl
  ? new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false })
  : null;

redis?.on('error', (error) => console.error(JSON.stringify({ event: 'redis.error', message: error.message })));
