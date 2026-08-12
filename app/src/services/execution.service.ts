import {
  cancelExecution,
  createExecution,
  findExecution,
  listJobs,
} from '../repositories/execution.repository.js';
import { listAuditEvents } from '../repositories/audit.repository.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import { incrementMetric } from '../metrics.js';
import { getWorkflowDefinition } from './workflow.service.js';
import { enqueueExecution } from '../queue/execution.queue.js';

export class ExecutionValidationError extends Error {}

export const submitExecution = async (
  workflowId: string,
  userId: string,
  idempotencyKey: string | null,
  input: Record<string, unknown> = {},
) => {
  const definition = await getWorkflowDefinition(workflowId, userId);
  if (!definition) return null;
  const execution = await createExecution(workflowId, userId, definition, idempotencyKey, input);
  await recordAuditEvent(execution.id, 'EXECUTION_QUEUED', { workflowId, idempotencyKey });
  await enqueueExecution(execution.id);
  incrementMetric('executions.queued');
  return execution;
};

export const cancel = async (id: string, userId: string): Promise<boolean> => {
  const cancelled = await cancelExecution(id, userId);
  if (cancelled) {
    await recordAuditEvent(id, 'EXECUTION_CANCELLED', {});
    incrementMetric('executions.cancelled');
  }
  return cancelled;
};

export { findExecution, listAuditEvents, listJobs };
