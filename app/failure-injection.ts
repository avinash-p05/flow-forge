import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const api = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const email = process.env.FAILURE_TEST_EMAIL ?? `failure-${randomUUID()}@example.com`;
const password = process.env.FAILURE_TEST_PASSWORD ?? 'flowforge-failure-password';
const timeout = Number(process.env.FAILURE_TEST_TIMEOUT_MS ?? 300_000);
const request = async (path: string, options: RequestInit = {}): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${api}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const waitForTerminal = async (id: string, token: string): Promise<any> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await request(`/api/v1/executions/${id}`, { headers: { authorization: `Bearer ${token}` } });
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(result.body?.status)) return result.body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for execution ${id}`);
};
const main = async (): Promise<void> => {
  const registration = await request('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (registration.status !== 201 && registration.status !== 409) throw new Error(`Registration failed: ${registration.status}`);
  const login = await request('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (!login.body?.token) throw new Error(`Login failed: ${login.status}`);
  const token = login.body.token;
  const auth = { authorization: `Bearer ${token}` };
  const workflow = await request('/api/v1/workflows', { method: 'POST', headers: auth, body: JSON.stringify({
    name: `failure-injection-${Date.now()}`,
    definition: { steps: [
      { id: 'recover', name: 'recover', type: 'test-failure', config: { failures: 2 }, dependsOn: [] },
      { id: 'timeout', name: 'timeout', type: 'delay', config: { ms: Number(process.env.FAILURE_TEST_DELAY_MS ?? 31_000) }, dependsOn: ['recover'] },
    ] },
  }) });
  if (workflow.status !== 201) throw new Error(`Workflow creation failed: ${workflow.status}`);
  const key = `failure-${randomUUID()}`;
  const submitted = await request(`/api/v1/workflows/${workflow.body.id}/executions`, { method: 'POST', headers: { ...auth, 'idempotency-key': key }, body: JSON.stringify({ input: { scenario: 'retry-and-timeout' } }) });
  if (submitted.status !== 202) throw new Error(`Execution submission failed: ${submitted.status}`);
  let workerStoppedAt: string | null = null;
  const workerPid = Number(process.env.FAILURE_TEST_WORKER_PID);
  if (Number.isInteger(workerPid) && workerPid > 0) {
    process.kill(workerPid, 'SIGTERM');
    workerStoppedAt = new Date().toISOString();
    console.log(`Stopped requested worker PID ${workerPid} at ${workerStoppedAt}`);
  }
  const execution = await waitForTerminal(submitted.body.id, token);
  const jobs = await request(`/api/v1/executions/${submitted.body.id}/jobs`, { headers: auth });
  const history = await request(`/api/v1/executions/${submitted.body.id}/history`, { headers: auth });
  const result = { scenario: 'retry-and-timeout', startedAt: new Date().toISOString(), workerStoppedAt, api, execution: execution, jobs: jobs.body, history: history.body };
  const output = process.env.FAILURE_TEST_OUTPUT ?? `failure-test-${Date.now()}.json`;
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`Failure injection completed; actual API state written to ${output}`);
};
await main();
