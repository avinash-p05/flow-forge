import assert from 'node:assert/strict';
import test from 'node:test';
import { getHandler } from '../src/handlers/registry.js';

const context = {
  input: { customerId: 'customer-1', name: 'Ada' },
  signal: new AbortController().signal,
};

test('worker handler returns configured result and input', async () => {
  const output = await getHandler('worker')({ result: { accepted: true } }, context);
  assert.deepEqual(output, { accepted: true, input: context.input });
});

test('transform handler maps input values', async () => {
  const output = await getHandler('transform')(
    { operation: 'set', key: 'status', value: 'ready' },
    context,
  );
  assert.deepEqual(output, { ...context.input, status: 'ready' });
});

test('delay handler returns its delay metadata', async () => {
  const output = await getHandler('delay')({ ms: 0 }, context);
  assert.deepEqual(output, { delayedMs: 0 });
});

test('unsupported handlers fail with a validation error', () => {
  assert.throws(() => getHandler('arbitrary-code'), /Unsupported handler type/);
});
