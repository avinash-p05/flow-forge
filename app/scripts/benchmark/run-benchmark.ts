import { readFile, writeFile } from 'node:fs/promises';
import { configFromEnvironment, jsonFile } from './config.js';

type Workload = { name: string; steps: unknown[]; executions: number; input: Record<string, unknown> };
type ResponseBody = Record<string, unknown> & { token?: string; id?: string; status?: string };
const request = async (base: string, path: string, options: RequestInit = {}): Promise<{ status: number; body: ResponseBody | ResponseBody[] | null; receivedAt: string }> => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as ResponseBody : null, receivedAt: new Date().toISOString() };
};
const must = <T>(value: T | null | undefined, message: string): T => { if (value === null || value === undefined) throw new Error(message); return value; };
const main = async (): Promise<void> => {
  const config = configFromEnvironment();
  const input = JSON.parse(await readFile(jsonFile(process.argv[2] ?? config.workloadFile), 'utf8')) as { workloads: Workload[] };
  const startedAt = new Date().toISOString();
  const registration = await request(config.apiUrl, '/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: config.email, password: config.password }) });
  if (registration.status !== 201 && registration.status !== 409) throw new Error(`Registration failed: ${registration.status}`);
  const login = await request(config.apiUrl, '/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: config.email, password: config.password }) });
  const token = must((login.body as ResponseBody | null)?.token, `Login failed: ${login.status}`);
  const auth = { authorization: `Bearer ${token}` };
  const executions: Array<{ workload: string; id: string; submittedAt: string; idempotencyKey: string }> = [];
  for (const workload of input.workloads) {
    const workflow = await request(config.apiUrl, '/api/v1/workflows', {
      method: 'POST', headers: auth, body: JSON.stringify({ name: `${workload.name}-${Date.now()}`, definition: { steps: workload.steps } }),
    });
    const workflowId = must((workflow.body as ResponseBody | null)?.id, `Workflow creation failed: ${workflow.status}`);
    let next = 0;
    const submitOne = async (): Promise<void> => {
      const index = next++;
      if (index >= workload.executions) return;
      const key = `${workload.name}-${Date.now()}-${index}`;
      const submitted = await request(config.apiUrl, `/api/v1/workflows/${workflowId}/executions`, {
        method: 'POST', headers: { ...auth, 'idempotency-key': key }, body: JSON.stringify({ input: workload.input }),
      });
      const id = (submitted.body as ResponseBody | null)?.id;
      if (submitted.status !== 202 || !id) throw new Error(`Execution submission failed: ${submitted.status}`);
      executions.push({ workload: workload.name, id: String(id), submittedAt: submitted.receivedAt, idempotencyKey: key });
      await submitOne();
    };
    await Promise.all(Array.from({ length: Math.min(config.concurrency, workload.executions) }, submitOne));
  }
  const output = { startedAt, submittedAt: new Date().toISOString(), apiUrl: config.apiUrl, workloadFile: process.argv[2] ?? config.workloadFile, executions };
  const destination = jsonFile(process.argv[3] ?? config.outputFile);
  await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Submitted ${executions.length} executions at ${destination}`);
};
await main();
