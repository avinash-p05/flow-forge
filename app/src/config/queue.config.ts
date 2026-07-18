export type QueueConfig = {
  queueUrl: string | null;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
  maxMessages: number;
};

const positiveInteger = (name: string, value: string | undefined, fallback: string, maximum?: number): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0 || (maximum !== undefined && parsed > maximum)) {
    throw new Error(`${name} must be a positive integer${maximum ? ` no greater than ${maximum}` : ''}`);
  }
  return parsed;
};

export const getQueueConfig = (): QueueConfig => ({
  queueUrl: process.env.SQS_QUEUE_URL?.trim() || null,
  visibilityTimeoutSeconds: positiveInteger(
    'SQS_VISIBILITY_TIMEOUT_SECONDS',
    process.env.SQS_VISIBILITY_TIMEOUT_SECONDS,
    '60',
  ),
  waitTimeSeconds: positiveInteger('SQS_WAIT_TIME_SECONDS', process.env.SQS_WAIT_TIME_SECONDS, '20'),
  maxMessages: positiveInteger('SQS_MAX_MESSAGES', process.env.SQS_MAX_MESSAGES, '10', 10),
});
