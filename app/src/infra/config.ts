import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Local development reads the repository's single .env (resolved from this file, so it works from any
// working directory, from src/ and dist/). It overrides variables already set on the machine, such as a
// global AWS_REGION. Containers read no file: docker compose passes .env in, ECS uses the task definition.
if (process.env.NODE_ENV !== 'production') {
  const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
  dotenv.config({ path: envFile, override: true, quiet: true });
}

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
};

const str = (name: string, fallback?: string): string => {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} must be configured`);
  return value;
};

/**
 * Optional custom SQS endpoint (ElasticMQ locally; empty or an amazonaws.com URL means real AWS).
 * docker compose sets LOCAL_SQS_HOST so that a 127.0.0.1/localhost endpoint from the shared .env
 * resolves to the ElasticMQ container instead of the container itself.
 */
const sqsEndpoint = (): string | undefined => {
  const raw = process.env.AWS_ENDPOINT_URL?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  const localHost = process.env.LOCAL_SQS_HOST?.trim();
  if (localHost && ['127.0.0.1', 'localhost'].includes(url.hostname)) url.host = localHost;
  return url.origin;
};

export const config = {
  port: int('PORT', 3000),
  databaseUrl: str('DATABASE_URL', 'postgresql://flowforge:flowforge@127.0.0.1:5433/flowforge'),
  databasePoolSize: int('DATABASE_POOL_SIZE', 20),
  redisUrl: process.env.REDIS_URL?.trim() || null,

  auth: {
    secret: process.env.AUTH_TOKEN_SECRET?.trim() ?? '',
    tokenTtlSeconds: int('AUTH_TOKEN_TTL_SECONDS', 3600),
  },

  rateLimit: {
    windowSeconds: int('RATE_LIMIT_WINDOW_SECONDS', 60),
    maxRequests: int('RATE_LIMIT_MAX_REQUESTS', 100),
  },

  sqs: {
    queueUrl: process.env.SQS_QUEUE_URL?.trim() || null,
    region: str('AWS_REGION', 'us-east-1'),
    endpoint: sqsEndpoint(),
    waitTimeSeconds: int('SQS_WAIT_TIME_SECONDS', 20),
  },

  worker: {
    concurrency: int('WORKER_CONCURRENCY', 10),
    pollIntervalMs: int('WORKER_POLL_INTERVAL_MS', 500),
    leaseMs: int('EXECUTION_LEASE_MS', 30_000),
    maxParallelJobs: int('MAX_PARALLEL_JOBS_PER_EXECUTION', 10),
  },

  jobs: {
    maxAttempts: int('JOB_MAX_ATTEMPTS', 3),
    retryBaseDelayMs: int('JOB_RETRY_BASE_DELAY_MS', 1000),
    retryMaxDelayMs: int('JOB_RETRY_MAX_DELAY_MS', 60_000),
    timeoutMs: int('JOB_TIMEOUT_MS', 30_000),
  },
};
