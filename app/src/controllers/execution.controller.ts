import type { Request, Response } from 'express';
import {
  cancel as cancelExecution,
  findExecution,
  listAuditEvents,
  listJobs,
  submitExecution,
} from '../services/execution.service.js';

const param = (request: Request, name: string): string => {
  const value = request.params[name];
  if (typeof value !== 'string') throw new Error(`${name} must be a single value`);
  return value;
};

export const submit = async (request: Request, response: Response): Promise<void> => {
  const input = request.body?.input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    response.status(400).json({ error: 'Execution input must be an object' });
    return;
  }
  const execution = await submitExecution(
    param(request, 'workflowId'),
    request.user!.id,
    request.header('idempotency-key') ?? null,
    input as Record<string, unknown>,
  );
  if (!execution) {
    response.status(404).json({ error: 'Workflow not found' });
    return;
  }
  response.status(202).json(execution);
};

export const get = async (request: Request, response: Response): Promise<void> => {
  const execution = await findExecution(param(request, 'id'), request.user!.id);
  if (!execution) {
    response.status(404).json({ error: 'Execution not found' });
    return;
  }
  response.json(execution);
};

export const jobs = async (request: Request, response: Response): Promise<void> => {
  const result = await listJobs(param(request, 'id'), request.user!.id);
  if (!result) {
    response.status(404).json({ error: 'Execution not found' });
    return;
  }
  response.json(result);
};

export const cancel = async (request: Request, response: Response): Promise<void> => {
  const cancelled = await cancelExecution(param(request, 'id'), request.user!.id);
  if (!cancelled) {
    response.status(404).json({ error: 'Execution not found or cannot be cancelled' });
    return;
  }
  response.status(204).send();
};

export const history = async (request: Request, response: Response): Promise<void> => {
  const result = await listAuditEvents(param(request, 'id'), request.user!.id);
  if (!result) {
    response.status(404).json({ error: 'Execution not found' });
    return;
  }
  response.json(result);
};
