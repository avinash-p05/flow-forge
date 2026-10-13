import { randomUUID } from 'node:crypto';
import pg from 'pg';

export const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://flowforge:flowforge@127.0.0.1:5433/flowforge',
  max: 4,
});

export type ApiResponse = { status: number; body: any; headers: Headers };

export const call = async (path: string, options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResponse> => {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
};

export const expect = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok - ${message}`);
};

export const newUser = async (): Promise<string> => {
  const result = await call('/api/v1/auth/register', { body: { email: `user-${randomUUID()}@example.com`, password: 'password-123' } });
  if (result.status !== 201) throw new Error(`register failed: ${result.status}`);
  return result.body.token;
};

export const createWorkflow = async (token: string, name: string, steps: unknown[]): Promise<string> => {
  const result = await call('/api/v1/workflows', { token, body: { name, definition: { steps } } });
  if (result.status !== 201) throw new Error(`workflow create failed: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body.id;
};

export const submit = (token: string, workflowId: string, input: object = {}, idempotencyKey: string = randomUUID()) =>
  call(`/api/v1/workflows/${workflowId}/executions`, { token, body: { input }, headers: { 'idempotency-key': idempotencyKey } });

export const waitForExecution = async (token: string, id: string, timeoutMs = 60_000): Promise<any> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await call(`/api/v1/executions/${id}`, { token });
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(body.status)) return body;
    await sleep(200);
  }
  throw new Error(`execution ${id} did not finish within ${timeoutMs}ms`);
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** Runs `task(i)` for i in [0, total) with at most `concurrency` in flight. */
export const runPool = async (total: number, concurrency: number, task: (index: number) => Promise<void>): Promise<void> => {
  let next = 0;
  const lane = async () => { while (next < total) await task(next++); };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, lane));
};
