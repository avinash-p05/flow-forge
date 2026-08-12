import { randomUUID } from 'node:crypto';
import {
  createWorkflow,
  deleteWorkflow,
  findWorkflowDefinition,
  findWorkflowById,
  listWorkflows,
  updateWorkflow,
} from '../repositories/workflow.repository.js';
import type { WorkflowDefinition, WorkflowStep } from '../types/workflow.types.js';
import {
  cacheWorkflowDefinition,
  getCachedWorkflowDefinition,
  invalidateWorkflowDefinition,
} from './workflow-cache.service.js';

export class WorkflowValidationError extends Error {}

export const validateWorkflow = (body: unknown): { name: string; definition: WorkflowDefinition } => {
  if (!body || typeof body !== 'object') throw new WorkflowValidationError('Request body must be an object');
  const input = body as { name?: unknown; definition?: unknown };
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new WorkflowValidationError('Workflow name is required');
  }
  if (!input.definition || typeof input.definition !== 'object' ||
      !Array.isArray((input.definition as { steps?: unknown }).steps)) {
    throw new WorkflowValidationError('Workflow definition must contain valid steps');
  }

  const rawSteps = (input.definition as { steps: unknown[] }).steps;
  const ids = new Set<string>();
  const steps: WorkflowStep[] = rawSteps.map((rawStep, index) => {
    if (!rawStep || typeof rawStep !== 'object') {
      throw new WorkflowValidationError(`Step ${index + 1} must be an object`);
    }
    const step = rawStep as {
      id?: unknown;
      name?: unknown;
      type?: unknown;
      config?: unknown;
      dependsOn?: unknown;
    };
    const id = typeof step.id === 'string' && step.id.trim().length > 0
      ? step.id.trim()
      : randomUUID();
    if (ids.has(id)) throw new WorkflowValidationError(`Duplicate step id: ${id}`);
    if (typeof step.name !== 'string' || step.name.trim().length === 0) {
      throw new WorkflowValidationError(`Step ${id} requires a name`);
    }
    if (typeof step.type !== 'string' || step.type.trim().length === 0) {
      throw new WorkflowValidationError(`Step ${id} requires a type`);
    }
    if (step.config !== undefined &&
        (!step.config || typeof step.config !== 'object' || Array.isArray(step.config))) {
      throw new WorkflowValidationError(`Step ${id} config must be an object`);
    }
    if (step.dependsOn !== undefined &&
        (!Array.isArray(step.dependsOn) || step.dependsOn.some((dependency) => typeof dependency !== 'string'))) {
      throw new WorkflowValidationError(`Step ${id} dependsOn must contain step ids`);
    }
    ids.add(id);
    return {
      id,
      name: step.name.trim(),
      type: step.type.trim(),
      config: (step.config ?? {}) as Record<string, unknown>,
      dependsOn: (step.dependsOn ?? []) as string[],
    };
  });

  const stepIds = new Set(steps.map((step) => step.id));
  const dependenciesById = new Map(steps.map((step) => [step.id, step.dependsOn]));
  for (const step of steps) {
    if (step.dependsOn.includes(step.id)) {
      throw new WorkflowValidationError(`Step ${step.id} cannot depend on itself`);
    }
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        throw new WorkflowValidationError(`Step ${step.id} depends on unknown step: ${dependency}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) throw new WorkflowValidationError(`Workflow contains a dependency cycle at step: ${stepId}`);
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const dependency of dependenciesById.get(stepId) ?? []) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.id);

  return { name: input.name.trim(), definition: { steps } };
};

export const getWorkflowDefinition = async (
  id: string,
  userId: string,
): Promise<WorkflowDefinition | null> => {
  const cached = await getCachedWorkflowDefinition(id, userId);
  if (cached) return cached;

  const definition = await findWorkflowDefinition(id, userId);
  if (definition) await cacheWorkflowDefinition(id, userId, definition);
  return definition;
};

export const create = async (
  name: string,
  definition: WorkflowDefinition,
  userId: string,
) => {
  const workflow = await createWorkflow(name, definition, userId);
  await cacheWorkflowDefinition(workflow.id, userId, definition);
  return workflow;
};

export const update = async (
  id: string,
  name: string,
  definition: WorkflowDefinition,
  userId: string,
) => {
  const workflow = await updateWorkflow(id, name, definition, userId);
  if (workflow) await cacheWorkflowDefinition(id, userId, definition);
  return workflow;
};

export const remove = async (id: string, userId: string): Promise<boolean> => {
  const deleted = await deleteWorkflow(id, userId);
  if (deleted) await invalidateWorkflowDefinition(id, userId);
  return deleted;
};

export { findWorkflowById, listWorkflows };
