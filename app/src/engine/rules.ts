import { handlerTypes } from './handlers.js';

export type WorkflowStep = {
  id: string;
  type: string;
  config: Record<string, unknown>;
  dependsOn: string[];
};

export type WorkflowDefinition = { steps: WorkflowStep[] };

export class ValidationError extends Error {}

const MAX_STEPS = 50;

/**
 * Validates a workflow definition and returns a normalised copy.
 * Rejects unknown step types, duplicate ids, unknown dependencies and cycles,
 * so a stored workflow is always a runnable DAG.
 */
export const validateDefinition = (raw: unknown): WorkflowDefinition => {
  const steps = (raw as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new ValidationError('definition.steps must be a non-empty array');
  if (steps.length > MAX_STEPS) throw new ValidationError(`A workflow can have at most ${MAX_STEPS} steps`);

  const normalised: WorkflowStep[] = steps.map((step: Record<string, unknown>, index) => {
    if (typeof step?.id !== 'string' || !step.id.trim()) throw new ValidationError(`Step ${index + 1} needs an id`);
    if (typeof step.type !== 'string' || !handlerTypes.includes(step.type)) {
      throw new ValidationError(`Step ${step.id} has unknown type; expected one of ${handlerTypes.join(', ')}`);
    }
    const dependsOn = step.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((dep) => typeof dep !== 'string')) {
      throw new ValidationError(`Step ${step.id} dependsOn must be an array of step ids`);
    }
    const stepConfig = step.config ?? {};
    if (typeof stepConfig !== 'object' || Array.isArray(stepConfig)) throw new ValidationError(`Step ${step.id} config must be an object`);
    return { id: step.id.trim(), type: step.type, config: stepConfig as Record<string, unknown>, dependsOn: dependsOn as string[] };
  });

  const byId = new Map(normalised.map((step) => [step.id, step]));
  if (byId.size !== normalised.length) throw new ValidationError('Step ids must be unique');
  for (const step of normalised) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) throw new ValidationError(`Step ${step.id} depends on unknown step ${dep}`);
    }
  }

  // Depth-first search: reaching a step that is still "in progress" means there is a cycle.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new ValidationError(`Workflow has a dependency cycle at step ${id}`);
    state.set(id, 'visiting');
    byId.get(id)!.dependsOn.forEach(visit);
    state.set(id, 'done');
  };
  normalised.forEach((step) => visit(step.id));

  return { steps: normalised };
};

/**
 * Exponential backoff with jitter: base * 2^(attempt-1), capped, plus up to 20% random jitter
 * so many failing jobs do not all retry at the same instant.
 */
export const retryDelayMs = (attempt: number, baseMs: number, maxMs: number, random = Math.random): number => {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential + exponential * 0.2 * random());
};
