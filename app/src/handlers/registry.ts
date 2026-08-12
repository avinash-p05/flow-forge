import type { BuiltInHandler } from './handler.types.js';
import { HandlerError } from './handler.types.js';

const requiredString = (config: Record<string, unknown>, key: string): string => {
  const value = config[key];
  if (typeof value !== 'string' || !value) throw new HandlerError(`${key} is required`, 'VALIDATION_ERROR');
  return value;
};

const worker: BuiltInHandler = async (config, { input }) => ({
  ...(typeof config.result === 'object' && config.result !== null ? config.result as Record<string, unknown> : {}),
  input,
});

const delay: BuiltInHandler = async (config, { signal }) => {
  const ms = Number(config.ms ?? 0);
  if (!Number.isInteger(ms) || ms < 0 || ms > 300_000) throw new HandlerError('ms must be between 0 and 300000', 'VALIDATION_ERROR');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new HandlerError('delay timed out', 'TIMEOUT')); }, { once: true });
  });
  return { delayedMs: ms };
};

const transform: BuiltInHandler = async (config, { input }) => {
  const operation = config.operation ?? 'merge';
  if (operation === 'merge') return { ...input, ...(config.values as Record<string, unknown> ?? {}) };
  if (operation === 'pick') {
    const keys = Array.isArray(config.keys) ? config.keys.filter((key): key is string => typeof key === 'string') : [];
    return Object.fromEntries(keys.map((key) => [key, input[key]]));
  }
  if (operation === 'set') {
    const key = requiredString(config, 'key');
    return { ...input, [key]: config.value };
  }
  throw new HandlerError(`Unsupported transform operation: ${String(operation)}`, 'VALIDATION_ERROR');
};

const request: BuiltInHandler = async (config, { signal }) => {
  const url = requiredString(config, 'url');
  const method = String(config.method ?? 'GET').toUpperCase();
  const response = await fetch(url, {
    method,
    headers: (config.headers ?? {}) as Record<string, string>,
    body: config.body === undefined ? undefined : JSON.stringify(config.body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new HandlerError(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* non-JSON response */ }
  return { status: response.status, body };
};

// Deliberately deterministic and side-effect free; intended for controlled reliability tests.
const testFailure: BuiltInHandler = async (config, { attempt = 1 }) => {
  const failures = Number(config.failures ?? 0);
  if (!Number.isInteger(failures) || failures < 0) throw new HandlerError('failures must be a non-negative integer', 'VALIDATION_ERROR');
  if (attempt <= failures) throw new HandlerError(`Configured test failure on attempt ${attempt}`, 'HANDLER_ERROR');
  return { attempt, recovered: true };
};

export const handlerRegistry: Readonly<Record<string, BuiltInHandler>> = {
  worker,
  http: request,
  webhook: request,
  delay,
  transform,
  'test-failure': testFailure,
};

export const getHandler = (type: string): BuiltInHandler => {
  const handler = handlerRegistry[type];
  if (!handler) throw new HandlerError(`Unsupported handler type: ${type}`, 'VALIDATION_ERROR');
  return handler;
};
