import { readFile, writeFile } from 'node:fs/promises';
import { configFromEnvironment, jsonFile } from './config.js';

type Item = { workload: string; id: string; submittedAt: string; idempotencyKey: string };
const call = async (base: string, path: string, token: string): Promise<unknown> => {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
};
const main = async (): Promise<void> => {
  const config = configFromEnvironment();
  const run = JSON.parse(await readFile(jsonFile(process.argv[2] ?? config.outputFile), 'utf8')) as { apiUrl: string; executions: Item[] };
  const loginResponse = await fetch(`${run.apiUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: config.email, password: config.password }) });
  const login = await loginResponse.json() as { token?: string };
  if (!login.token) throw new Error(`Login failed: ${loginResponse.status}`);
  const deadline = Date.now() + config.timeoutMs;
  const results: Array<Record<string, unknown>> = [];
  for (const item of run.executions) {
    let execution: Record<string, unknown>;
    do {
      execution = await call(run.apiUrl, `/api/v1/executions/${item.id}`, login.token) as Record<string, unknown>;
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(String(execution.status))) break;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${item.id}`);
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    } while (true);
    results.push({ ...item, execution, jobs: await call(run.apiUrl, `/api/v1/executions/${item.id}/jobs`, login.token), history: await call(run.apiUrl, `/api/v1/executions/${item.id}/history`, login.token) });
  }
  const destination = jsonFile(process.argv[3] ?? config.resultsFile);
  await writeFile(destination, `${JSON.stringify({ collectedAt: new Date().toISOString(), ...run, results }, null, 2)}\n`, 'utf8');
  console.log(`Collected ${results.length} execution results at ${destination}`);
};
await main();
