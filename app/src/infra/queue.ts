import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { config } from './config.js';

/**
 * SQS carries "execution X is ready" notifications from the API to workers.
 * PostgreSQL stays the source of truth, so a lost or duplicated message is harmless:
 * workers claim executions with a conditional UPDATE and also sweep the database.
 * Messages that keep failing are moved to the SQS dead-letter queue by its redrive policy.
 */
const { queueUrl } = config.sqs;
const client = queueUrl ? new SQSClient({ region: config.sqs.region, endpoint: config.sqs.endpoint }) : null;

export type QueueMessage = { executionId: string | null; receiptHandle: string };

export const isQueueEnabled = (): boolean => client !== null;

export const enqueueExecution = async (executionId: string): Promise<void> => {
  if (!client) return;
  await client.send(new SendMessageCommand({ QueueUrl: queueUrl!, MessageBody: JSON.stringify({ executionId }) }));
};

/** Long-polls for one message. `executionId` is null when the body is malformed. */
export const receiveExecution = async (visibilityTimeoutSeconds: number): Promise<QueueMessage | null> => {
  if (!client) return null;
  const result = await client.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl!,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: config.sqs.waitTimeSeconds,
    VisibilityTimeout: visibilityTimeoutSeconds,
  }));
  const message = result.Messages?.[0];
  if (!message?.ReceiptHandle) return null;
  let executionId: string | null = null;
  try {
    const body = JSON.parse(message.Body ?? '') as { executionId?: unknown };
    if (typeof body.executionId === 'string') executionId = body.executionId;
  } catch { /* malformed: left on the queue so the redrive policy dead-letters it */ }
  return { executionId, receiptHandle: message.ReceiptHandle };
};

export const deleteMessage = async (message: QueueMessage): Promise<void> => {
  await client?.send(new DeleteMessageCommand({ QueueUrl: queueUrl!, ReceiptHandle: message.receiptHandle }));
};

/** Hides the message for `seconds` more: used as a heartbeat and to delay redelivery until a retry is due. */
export const delayMessage = async (message: QueueMessage, seconds: number): Promise<void> => {
  await client?.send(new ChangeMessageVisibilityCommand({
    QueueUrl: queueUrl!,
    ReceiptHandle: message.receiptHandle,
    VisibilityTimeout: Math.min(43_200, Math.max(0, Math.ceil(seconds))),
  }));
};
