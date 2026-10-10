import assert from 'node:assert/strict';
import test from 'node:test';
import { retryDelayMs, validateDefinition } from '../src/engine/rules.js';

const step = (id: string, dependsOn: string[] = []) => ({ id, type: 'transform', dependsOn });

test('accepts a valid DAG and fills defaults', () => {
  const result = validateDefinition({ steps: [step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])] });
  assert.equal(result.steps.length, 4);
  assert.deepEqual(result.steps[0], { id: 'a', type: 'transform', config: {}, dependsOn: [] });
});

test('rejects a dependency cycle', () => {
  assert.throws(() => validateDefinition({ steps: [step('a', ['c']), step('b', ['a']), step('c', ['b'])] }), /cycle/);
});

test('rejects self-dependency, unknown dependency, duplicate ids and unknown types', () => {
  assert.throws(() => validateDefinition({ steps: [step('a', ['a'])] }), /cycle/);
  assert.throws(() => validateDefinition({ steps: [step('a', ['missing'])] }), /unknown step/);
  assert.throws(() => validateDefinition({ steps: [step('a'), step('a')] }), /unique/);
  assert.throws(() => validateDefinition({ steps: [{ id: 'a', type: 'shell' }] }), /unknown type/);
  assert.throws(() => validateDefinition({ steps: [] }), /non-empty/);
});

test('retry delay grows exponentially and is capped', () => {
  const noJitter = () => 0;
  assert.deepEqual([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt, 1000, 60_000, noJitter)), [1000, 2000, 4000, 8000]);
  assert.equal(retryDelayMs(20, 1000, 60_000, noJitter), 60_000);
});

test('retry jitter adds at most 20%', () => {
  assert.equal(retryDelayMs(1, 1000, 60_000, () => 1), 1200);
});
