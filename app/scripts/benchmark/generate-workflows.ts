import { writeFile } from 'node:fs/promises';
import { configFromEnvironment, jsonFile } from './config.js';

type Step = { id: string; name: string; type: string; config?: Record<string, unknown>; dependsOn: string[] };
type Workload = { name: string; steps: Step[]; executions: number; input: Record<string, unknown> };

const sequential = (): Workload => ({
  name: 'benchmark-sequential',
  executions: 20,
  input: { workload: 'sequential' },
  steps: [0, 1, 2, 3].map((index) => ({
    id: `sequential-${index}`, name: `sequential-${index}`, type: 'transform',
    config: { operation: 'set', key: `step${index}`, value: index }, dependsOn: index ? [`sequential-${index - 1}`] : [],
  })),
});

const fanOut = (): Workload => ({
  name: 'benchmark-fan-out',
  executions: 20,
  input: { workload: 'fan-out' },
  steps: [0, 1, 2, 3, 4].map((index) => ({
    id: `fanout-${index}`, name: `fanout-${index}`, type: 'worker', dependsOn: [],
  })),
});

const fanIn = (): Workload => ({
  name: 'benchmark-fan-in',
  executions: 20,
  input: { workload: 'fan-in' },
  steps: [
    ...[0, 1, 2, 3].map((index) => ({ id: `fanin-${index}`, name: `fanin-${index}`, type: 'worker', dependsOn: [] })),
    { id: 'fanin-final', name: 'fanin-final', type: 'transform', config: { operation: 'set', key: 'joined', value: true }, dependsOn: [0, 1, 2, 3].map((index) => `fanin-${index}`) },
  ],
});

const retry = (): Workload => ({
  name: 'benchmark-retry',
  executions: 10,
  input: { workload: 'retry' },
  steps: [{ id: 'retry-step', name: 'retry-step', type: 'http', config: { url: 'http://127.0.0.1:9/benchmark-disabled' }, dependsOn: [] }],
});

const timeout = (): Workload => ({
  name: 'benchmark-timeout',
  executions: 10,
  input: { workload: 'timeout' },
  steps: [{ id: 'timeout-step', name: 'timeout-step', type: 'delay', config: { ms: 31_000 }, dependsOn: [] }],
});

const main = async (): Promise<void> => {
  const config = configFromEnvironment();
  const workloads = [sequential(), fanOut(), fanIn(), retry(), timeout()];
  const output = jsonFile(process.argv[2] ?? config.workloadFile);
  await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), workloads }, null, 2)}\n`, 'utf8');
  console.log(`Generated ${workloads.length} workloads at ${output}`);
};
await main();
