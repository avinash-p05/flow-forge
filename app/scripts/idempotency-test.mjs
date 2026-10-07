const api = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const email = `idempotency-${Date.now()}@example.com`;
const password = 'flowforge-idempotency-password';
const call = async (path, options = {}) => {
  const response = await fetch(`${api}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const registration = await call('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
if (registration.status !== 201) throw new Error(`Registration failed: ${registration.status}`);
const login = await call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
if (!login.body?.token) throw new Error(`Login failed: ${login.status}`);
const auth = { authorization: `Bearer ${login.body.token}` };
const workflow = await call('/api/v1/workflows', {
  method: 'POST', headers: auth,
  body: JSON.stringify({ name: 'idempotency-test', definition: { steps: [{ id: 'only', name: 'only', type: 'worker', dependsOn: [] }] } }),
});
if (workflow.status !== 201) throw new Error(`Workflow failed: ${workflow.status}`);
const key = `same-${Date.now()}`;
const submit = (input) => call(`/api/v1/workflows/${workflow.body.id}/executions`, {
  method: 'POST', headers: { ...auth, 'idempotency-key': key }, body: JSON.stringify({ input }),
});
const responses = await Promise.all([submit({ value: 1 }), submit({ value: 2 }), submit({ value: 3 })]);
if (responses.some((item) => item.status !== 202)) throw new Error(`Concurrent submission failed: ${JSON.stringify(responses)}`);
const ids = new Set(responses.map((item) => item.body.id));
if (ids.size !== 1) throw new Error(`Expected one execution, got ${ids.size}`);
const jobs = await call(`/api/v1/executions/${responses[0].body.id}/jobs`, { headers: auth });
if (jobs.status !== 200 || jobs.body.length !== 1) throw new Error(`Expected one durable job set, got ${jobs.status}/${jobs.body.length}`);
console.log(`Idempotency test passed: ${responses.length} concurrent requests produced execution ${responses[0].body.id} and one job set`);
