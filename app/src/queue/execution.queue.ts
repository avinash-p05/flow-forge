import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { getQueueConfig } from '../config/queue.config.js';

type ExecutionMessage = {
  executionId: string;
};

const config = getQueueConfig();
const client = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT_URL,
});

export const isSqsConfigured = (): boolean => Boolean(config.queueUrl);

export const enqueueExecution = async (executionId: string): Promise<void> => {
  if (!config.queueUrl) return;
  await client.send(new SendMessageCommand({
    QueueUrl: config.queueUrl,
    MessageBody: JSON.stringify({ executionId } satisfies ExecutionMessage),
  }));
};

export const receiveExecution = async (): Promise<{ message: Message; executionId: string } | null> => {
  if (!config.queueUrl) return null;
  const result = await client.send(new ReceiveMessageCommand({
    QueueUrl: config.queueUrl,
    MaxNumberOfMessages: config.maxMessages,
    WaitTimeSeconds: config.waitTimeSeconds,
    VisibilityTimeout: config.visibilityTimeoutSeconds,
  }));
  const message = result.Messages?.[0];
  if (!message?.Body) return null;

  try {
    const body = JSON.parse(message.Body) as Partial<ExecutionMessage>;
    if (typeof body.executionId !== 'string' || !message.ReceiptHandle) return null;
    return { message, executionId: body.executionId };
  } catch {
    return null;
  }
};

export const deleteExecutionMessage = async (message: Message): Promise<void> => {
  if (!config.queueUrl || !message.ReceiptHandle) return;
  await client.send(new DeleteMessageCommand({
    QueueUrl: config.queueUrl,
    ReceiptHandle: message.ReceiptHandle,
  }));
};

export const extendExecutionMessage = async (message: Message, timeoutSeconds: number): Promise<void> => {
  if (!config.queueUrl || !message.ReceiptHandle) return;
  await client.send(new ChangeMessageVisibilityCommand({
    QueueUrl: config.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: timeoutSeconds,
  }));
};
