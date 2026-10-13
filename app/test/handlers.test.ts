import assert from 'node:assert/strict';
import test from 'node:test';
import { getHandler, JobError, runWithTimeout } from '../src/engine/handlers.js';

const context = { input: { orderId: 7 }, attempt: 1, idempotencyKey: 'exec-1:step-1' };

test('transform merges configured values into the input', async () => {
  const output = await runWithTimeout(getHandler('transform'), { values: { status: 'ready' } }, context, 1000);
  assert.deepEqual(output, { orderId: 7, status: 'ready' });
});

test('flaky fails deterministically until the configured attempt', async () => {
  const flaky = getHandler('flaky');
  await assert.rejects(runWithTimeout(flaky, { failUntilAttempt: 3 }, { ...context, attempt: 2 }, 1000), JobError);
  assert.deepEqual(await runWithTimeout(flaky, { failUntilAttempt: 3 }, { ...context, attempt: 3 }, 1000), { attempt: 3, recovered: true });
});

test('a job that exceeds its timeout fails with a retryable TIMEOUT error', async () => {
  await assert.rejects(runWithTimeout(getHandler('delay'), { ms: 500 }, context, 20), (error: JobError) =>
    error.code === 'TIMEOUT' && error.retryable);
});

test('unknown step types and bad config are not retryable', async () => {
  assert.throws(() => getHandler('shell'), (error: JobError) => !error.retryable);
  await assert.rejects(runWithTimeout(getHandler('delay'), { ms: -1 }, context, 1000), (error: JobError) =>
    error.code === 'VALIDATION_ERROR' && !error.retryable);
});
