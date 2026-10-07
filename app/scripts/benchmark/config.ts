import { randomUUID } from 'node:crypto';
import path from 'node:path';

export type BenchmarkConfig = {
  apiUrl: string;
  email: string;
  password: string;
  workloadFile: string;
  outputFile: string;
  resultsFile: string;
  reportFile: string;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
};

const integer = (name: string, value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

export const configFromEnvironment = (): BenchmarkConfig => {
  const runId = process.env.BENCHMARK_RUN_ID ?? randomUUID();
  return {
    apiUrl: (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    email: process.env.BENCHMARK_EMAIL ?? `benchmark-${runId}@example.com`,
    password: process.env.BENCHMARK_PASSWORD ?? 'flowforge-benchmark-password',
    workloadFile: process.env.BENCHMARK_WORKLOAD ?? 'benchmark-workflows.json',
    outputFile: process.env.BENCHMARK_OUTPUT ?? `benchmark-${runId}.json`,
    resultsFile: process.env.BENCHMARK_RESULTS ?? `benchmark-results-${runId}.json`,
    reportFile: process.env.BENCHMARK_REPORT ?? `benchmark-report-${runId}.md`,
    concurrency: integer('BENCHMARK_CONCURRENCY', process.env.BENCHMARK_CONCURRENCY, 10),
    pollIntervalMs: integer('BENCHMARK_POLL_INTERVAL_MS', process.env.BENCHMARK_POLL_INTERVAL_MS, 250),
    timeoutMs: integer('BENCHMARK_TIMEOUT_MS', process.env.BENCHMARK_TIMEOUT_MS, 300_000),
  };
};

export const jsonFile = (value: string): string => value.startsWith('\\') || /^[A-Za-z]:/.test(value)
  ? value
  : path.resolve(process.cwd(), value);
