import 'dotenv/config';
import {
  claimNextExecution, claimExecution, claimReadyJobs, completeJob, failJobPermanently,
  findExecutionForWorker, retryJob, skipBlockedJobs, finishExecution, reconcileExecution,
  releaseStaleJobs,
} from './repositories/execution.repository.js';
import { getAuthConfig } from './config/auth.config.js';
import { getExecutionConfig } from './config/execution.config.js';
import { runMigrations } from './db/migrations.js';
import { getHandler } from './handlers/registry.js';
import { HandlerError } from './handlers/handler.types.js';
import { recordAuditEvent } from './repositories/audit.repository.js';
import { incrementMetric } from './metrics.js';
import { deleteExecutionMessage, extendExecutionMessage, isSqsConfigured, receiveExecution } from './queue/execution.queue.js';

const config = getExecutionConfig();

const withTimeout = async <T>(promise: Promise<T>, signal: AbortController): Promise<T> => {
  const timer = setTimeout(() => signal.abort(), config.handlerTimeoutMs);
  try { return await promise; } finally { clearTimeout(timer); }
};

const processJob = async (job: Awaited<ReturnType<typeof claimReadyJobs>>[number], executionInput: Record<string, unknown>) => {
  const controller = new AbortController();
  try {
    const output = await withTimeout(getHandler(job.stepType)(job.stepConfig, {
      input: job.input ?? executionInput,
      signal: controller.signal,
      attempt: job.attempts,
    }), controller);
    await completeJob(job.id, output);
    incrementMetric('jobs.completed');
  } catch (error) {
    const classified = error instanceof HandlerError
      ? error
      : controller.signal.aborted ? new HandlerError('Job timed out', 'TIMEOUT') : new HandlerError(error instanceof Error ? error.message : 'Unknown job failure');
    if (job.attempts >= config.maxAttempts || classified.code === 'VALIDATION_ERROR') {
      await failJobPermanently(job.executionId, job.id, classified.message, classified.code);
      incrementMetric('jobs.dead_lettered');
      return;
    }
    const next = new Date(Date.now() + config.retryBaseDelayMs * (2 ** Math.max(0, job.attempts - 1)));
    await retryJob(job.executionId, job.id, classified.message, next, classified.code);
    incrementMetric('jobs.retried');
  }
};

const processExecution = async (executionId: string): Promise<boolean> => {
  while (true) {
    await skipBlockedJobs(executionId);
    const execution = await findExecutionForWorker(executionId);
    const jobs = await claimReadyJobs(executionId, 10);
    if (jobs.length) {
      await Promise.all(jobs.map((job) => processJob(job, execution?.input ?? {})));
      continue;
    }
    const state = await reconcileExecution(executionId);
    if (state === 'WAITING') return false;
    await finishExecution(executionId, state === 'BLOCKED' ? 'FAILED' : 'COMPLETED', state === 'BLOCKED' ? 'Execution blocked by failed dependency' : null);
    return true;
  }
};

const run = async (): Promise<void> => {
  getAuthConfig();
  await runMigrations();
  console.log('FlowForge worker is running');
  while (true) {
    await releaseStaleJobs(config.handlerTimeoutMs * 2);
    if (isSqsConfigured()) {
      const received = await receiveExecution();
      if (!received || !(await claimExecution(received.executionId))) continue;
      const heartbeat = setInterval(() => { void extendExecutionMessage(received.message, Math.ceil(config.handlerTimeoutMs / 1000) + 30); }, Math.max(1000, config.handlerTimeoutMs / 2));
      try {
        if (await processExecution(received.executionId)) await deleteExecutionMessage(received.message);
      }
      finally { clearInterval(heartbeat); }
      continue;
    }
    const executionId = await claimNextExecution();
    if (executionId) await processExecution(executionId);
    else await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
};
run().catch((error: unknown) => { console.error('Worker stopped', error); process.exitCode = 1; });
