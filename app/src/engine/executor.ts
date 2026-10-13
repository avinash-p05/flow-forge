import { config } from '../infra/config.js';
import { log } from '../infra/log.js';
import { deleteMessage, delayMessage, isQueueEnabled, receiveExecution, type QueueMessage } from '../infra/queue.js';
import { getHandler, JobError, runWithTimeout } from './handlers.js';
import {
  claimExecution, claimNextExecution, claimReadyJobs, completeJob, deadLetterJob, extendLease,
  getExecutionStatus, heartbeatWorker, recoverLostJobs, retryJob, settleExecution, skipBlockedJobs,
  type ClaimedJob, type Settlement,
} from './job-store.js';
import { retryDelayMs } from './rules.js';

const { leaseMs, maxParallelJobs } = config.worker;
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** Runs one job and records the outcome: completed, scheduled for retry, or dead-lettered. */
const runJob = async (job: ClaimedJob): Promise<void> => {
  const startedAt = Date.now();
  try {
    const output = await runWithTimeout(
      getHandler(job.type),
      job.config,
      { input: job.input, attempt: job.attempt, idempotencyKey: `${job.executionId}:${job.stepId}` },
      Number(job.config.timeoutMs ?? config.jobs.timeoutMs),
    );
    const written = await completeJob(job, output);
    log(written ? 'job.completed' : 'job.fenced', { jobId: job.id, step: job.stepId, attempt: job.attempt, ms: Date.now() - startedAt });
  } catch (caught) {
    const error = caught instanceof JobError ? caught : new JobError(caught instanceof Error ? caught.message : String(caught));
    const maxAttempts = Number(job.config.maxAttempts ?? config.jobs.maxAttempts);
    if (error.retryable && job.attempt < maxAttempts) {
      const delay = retryDelayMs(job.attempt, config.jobs.retryBaseDelayMs, config.jobs.retryMaxDelayMs);
      await retryJob(job, error, new Date(Date.now() + delay));
      log('job.retry_scheduled', { jobId: job.id, step: job.stepId, attempt: job.attempt, delayMs: delay, error: error.message });
    } else {
      await deadLetterJob(job, error);
      log('job.dead_lettered', { jobId: job.id, step: job.stepId, attempt: job.attempt, code: error.code, error: error.message });
    }
  }
};

/**
 * Drives one execution (already leased by this worker) as far as it can go:
 * repeatedly run every job whose dependencies are done, until nothing is runnable right now.
 */
export const processExecution = async (executionId: string, workerId: string, message?: QueueMessage): Promise<Settlement> => {
  const recovered = await recoverLostJobs(executionId, config.jobs.maxAttempts);
  if (recovered) log('execution.recovered_lost_jobs', { executionId, jobs: recovered });

  const heartbeat = setInterval(() => {
    void extendLease(executionId, workerId, leaseMs).catch(() => {});
    void heartbeatWorker(workerId, executionId).catch(() => {});
    if (message) void delayMessage(message, leaseMs / 1000).catch(() => {});
  }, leaseMs / 3);

  try {
    await heartbeatWorker(workerId, executionId);
    while (true) {
      await skipBlockedJobs(executionId);
      const jobs = await claimReadyJobs(executionId, workerId, maxParallelJobs);
      if (!jobs.length) {
        const settlement = await settleExecution(executionId, workerId);
        log(settlement.done ? 'execution.settled' : 'execution.waiting_for_retry', { executionId, workerId });
        return settlement;
      }
      await Promise.all(jobs.map(runJob));
    }
  } finally {
    clearInterval(heartbeat);
  }
};

const handleMessage = async (message: QueueMessage, workerId: string): Promise<void> => {
  // Malformed messages are left alone; after maxReceiveCount SQS moves them to the dead-letter queue.
  if (!message.executionId) return;
  if (!(await claimExecution(message.executionId, workerId, leaseMs))) {
    const status = await getExecutionStatus(message.executionId);
    if (status === null || TERMINAL.includes(status)) await deleteMessage(message);
    return; // otherwise another worker holds it, or it is not due yet; SQS redelivers it later
  }
  const settlement = await processExecution(message.executionId, workerId, message);
  if (settlement.done) await deleteMessage(message);
  else await delayMessage(message, (settlement.nextAttemptAt.getTime() - Date.now()) / 1000);
};

/**
 * One worker slot. Prefers SQS (push-style, low latency) and falls back to sweeping PostgreSQL,
 * which also catches executions whose message was lost and executions abandoned by a crashed worker.
 * Returns true if it did any work.
 */
const pollOnce = async (workerId: string): Promise<boolean> => {
  if (isQueueEnabled()) {
    const message = await receiveExecution(leaseMs / 1000);
    if (message) {
      await handleMessage(message, workerId);
      return true;
    }
  }
  const executionId = await claimNextExecution(workerId, leaseMs);
  if (!executionId) return false;
  await processExecution(executionId, workerId);
  return true;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const runWorkerSlot = async (workerId: string, isStopping: () => boolean): Promise<void> => {
  let lastHeartbeat = 0;
  while (!isStopping()) {
    try {
      if (Date.now() - lastHeartbeat > 5000) {
        await heartbeatWorker(workerId, null);
        lastHeartbeat = Date.now();
      }
      if (!(await pollOnce(workerId))) await sleep(config.worker.pollIntervalMs);
    } catch (error) {
      log('worker.error', { workerId, error: error instanceof Error ? error.message : String(error) });
      await sleep(1000);
    }
  }
};
