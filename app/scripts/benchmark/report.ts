import { readFile, writeFile } from 'node:fs/promises';
import { configFromEnvironment, jsonFile } from './config.js';
type Row = {
  workload: string;
  execution: { status: string; createdAt: string; startedAt: string | null; completedAt: string | null };
  jobs: Array<{ status: string; attempts: number; errorCode?: string | null; startedAt: string | null; completedAt: string | null }>;
};
const duration = (from: string | null, to: string | null): number | null => from && to ? new Date(to).getTime() - new Date(from).getTime() : null;
const percentile = (values: number[], percentage: number): string => {
  if (!values.length) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[index].toFixed(1);
};
const main = async (): Promise<void> => {
  const config = configFromEnvironment();
  const data = JSON.parse(await readFile(jsonFile(process.argv[2] ?? config.resultsFile), 'utf8')) as { startedAt: string; collectedAt: string; results: Row[] };
  const groups = new Map<string, Row[]>();
  for (const row of data.results) groups.set(row.workload, [...(groups.get(row.workload) ?? []), row]);
  const elapsedSeconds = Math.max(0, (new Date(data.collectedAt).getTime() - new Date(data.startedAt).getTime()) / 1000);
  const lines = [
    '# FlowForge benchmark report', '',
    `Started: ${data.startedAt}`, `Collected: ${data.collectedAt}`, `Elapsed: ${elapsedSeconds.toFixed(3)} seconds`, '',
    '| Workload | Runs | Completed | Failed | Jobs | Retries | Skipped | Recovery | Throughput (jobs/s) | Job p50/p95/p99 (ms) | Workflow p50/p95/p99 (ms) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|',
  ];
  for (const [name, rows] of groups) {
    const jobs = rows.flatMap((row) => row.jobs);
    const jobLatencies = jobs.map((job) => duration(job.startedAt, job.completedAt)).filter((value): value is number => value !== null);
    const workflowLatencies = rows.map((row) => duration(row.execution.createdAt, row.execution.completedAt)).filter((value): value is number => value !== null);
    const completedJobs = jobs.filter((job) => job.status === 'COMPLETED').length;
    const retries = jobs.reduce((total, job) => total + Math.max(0, job.attempts - 1), 0);
    const skipped = jobs.filter((job) => job.status === 'SKIPPED').length;
    const recovery = jobs.filter((job) => job.errorCode === 'WORKER_LOST').length;
    const metric = (values: number[]): string => `${percentile(values, 50)}/${percentile(values, 95)}/${percentile(values, 99)}`;
    lines.push(`| ${name} | ${rows.length} | ${rows.filter((r) => r.execution.status === 'COMPLETED').length} | ${rows.filter((r) => r.execution.status !== 'COMPLETED').length} | ${jobs.length} | ${retries} | ${skipped} | ${recovery} | ${elapsedSeconds ? (completedJobs / elapsedSeconds).toFixed(2) : 'n/a'} | ${metric(jobLatencies)} | ${metric(workflowLatencies)} |`);
  }
  lines.push('', 'All values above are calculated from API responses and persisted timestamps; no estimates are inserted.');
  const destination = jsonFile(process.argv[3] ?? config.reportFile);
  await writeFile(destination, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote report to ${destination}`);
};
await main();
