const baseUrl = process.env.API_URL ?? 'http://localhost:3000';
const email = `smoke-${Date.now()}@example.com`;
const password = 'flowforge-smoke-password';

const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
};

const registration = await request('/api/v1/auth/register', {
  method: 'POST',
  body: JSON.stringify({ email, password }),
});
if (registration.response.status !== 201 || !registration.body?.token) {
  throw new Error(`Registration failed: ${registration.response.status} ${JSON.stringify(registration.body)}`);
}

const token = registration.body.token;
const workflow = await request('/api/v1/workflows', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({
    name: 'smoke-workflow',
    definition: { steps: [{ name: 'first-step', type: 'worker' }] },
  }),
});
if (workflow.response.status !== 201 || !workflow.body?.id) {
  throw new Error(`Workflow creation failed: ${workflow.response.status} ${JSON.stringify(workflow.body)}`);
}

const list = await request('/api/v1/workflows', {
  headers: { authorization: `Bearer ${token}` },
});
if (list.response.status !== 200 || list.body.length !== 1) {
  throw new Error(`Workflow listing failed: ${list.response.status} ${JSON.stringify(list.body)}`);
}

const unauthorized = await request('/api/v1/workflows');
if (unauthorized.response.status !== 401) {
  throw new Error(`Unauthorized request was not rejected: ${unauthorized.response.status}`);
}

console.log('Smoke test passed: registration, authenticated workflow CRUD access, and unauthorized access protection');
