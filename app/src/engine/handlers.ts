export type JobContext = {
  input: Record<string, unknown>;
  signal: AbortSignal;
  attempt: number;
  /** Stable across retries of the same job, so downstream systems can de-duplicate side effects. */
  idempotencyKey: string;
};

export type Handler = (config: Record<string, unknown>, context: JobContext) => Promise<Record<string, unknown>>;

export class JobError extends Error {
  constructor(
    message: string,
    public readonly code: 'VALIDATION_ERROR' | 'TIMEOUT' | 'HANDLER_ERROR' | 'HTTP_ERROR' = 'HANDLER_ERROR',
    public readonly retryable = code !== 'VALIDATION_ERROR',
  ) {
    super(message);
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new JobError('Job timed out', 'TIMEOUT')); }, { once: true });
});

/** Calls an HTTP endpoint. 5xx/429/network errors are retried; other 4xx are permanent. */
const http: Handler = async (config, { signal, idempotencyKey }) => {
  if (typeof config.url !== 'string') throw new JobError('config.url is required', 'VALIDATION_ERROR');
  const response = await fetch(config.url, {
    method: String(config.method ?? 'GET').toUpperCase(),
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, ...(config.headers as Record<string, string> ?? {}) },
    body: config.body === undefined ? undefined : JSON.stringify(config.body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    throw new JobError(`HTTP ${response.status}: ${text.slice(0, 200)}`, 'HTTP_ERROR', retryable);
  }
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text body */ }
  return { status: response.status, body };
};

/** Waits `ms` milliseconds. Useful for simulating slow work. */
const delay: Handler = async (config, { signal }) => {
  const ms = Number(config.ms ?? 0);
  if (!Number.isInteger(ms) || ms < 0) throw new JobError('config.ms must be a non-negative integer', 'VALIDATION_ERROR');
  await sleep(ms, signal);
  return { delayedMs: ms };
};

/** Adds `config.values` to the input it receives from earlier steps. */
const transform: Handler = async (config, { input }) => ({
  ...input,
  ...(typeof config.values === 'object' && config.values !== null ? config.values as Record<string, unknown> : {}),
});

/**
 * Fails on purpose, for failure-injection tests.
 *   failureRate: probability (0..1) that any single attempt fails
 *   failUntilAttempt: deterministic, fails every attempt below this number
 */
const flaky: Handler = async (config, { attempt, signal }) => {
  if (config.delayMs) await sleep(Number(config.delayMs), signal);
  const failUntil = Number(config.failUntilAttempt ?? 0);
  const rate = Number(config.failureRate ?? 0);
  if (attempt < failUntil || Math.random() < rate) throw new JobError(`Injected failure on attempt ${attempt}`);
  return { attempt, recovered: attempt > 1 };
};

const handlers: Record<string, Handler> = { http, delay, transform, flaky };

export const handlerTypes = Object.keys(handlers);

export const getHandler = (type: string): Handler => {
  const handler = handlers[type];
  if (!handler) throw new JobError(`Unknown step type: ${type}`, 'VALIDATION_ERROR');
  return handler;
};

/** Runs a handler, aborting it if it exceeds `timeoutMs`. */
export const runWithTimeout = async (
  handler: Handler,
  config: Record<string, unknown>,
  context: Omit<JobContext, 'signal'>,
  timeoutMs: number,
): Promise<Record<string, unknown>> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JobError(`Job timed out after ${timeoutMs}ms`, 'TIMEOUT'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([handler(config, { ...context, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
};
