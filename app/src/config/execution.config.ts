export type ExecutionConfig = {
  maxAttempts: number;
  retryBaseDelayMs: number;
  pollIntervalMs: number;
  handlerTimeoutMs: number;
};

class ExecutionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionConfigError';
  }
}

const positiveInteger = (name: string, value: string | undefined, fallback: string): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ExecutionConfigError(`${name} must be a positive integer`);
  }
  return parsed;
};

export const getExecutionConfig = (): ExecutionConfig => ({
  maxAttempts: positiveInteger('JOB_MAX_ATTEMPTS', process.env.JOB_MAX_ATTEMPTS, '3'),
  retryBaseDelayMs: positiveInteger('JOB_RETRY_BASE_DELAY_MS', process.env.JOB_RETRY_BASE_DELAY_MS, '1000'),
  pollIntervalMs: positiveInteger('WORKER_POLL_INTERVAL_MS', process.env.WORKER_POLL_INTERVAL_MS, '1000'),
  handlerTimeoutMs: positiveInteger('JOB_TIMEOUT_MS', process.env.JOB_TIMEOUT_MS, '30000'),
});
