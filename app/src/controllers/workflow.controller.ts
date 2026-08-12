import type { Request, Response } from 'express';
import {
  findWorkflowById,
  listWorkflows,
  create as createWorkflow,
  remove as removeWorkflow,
  update as updateWorkflow,
  validateWorkflow,
  WorkflowValidationError,
} from '../services/workflow.service.js';

const workflowId = (request: Request): string => {
  const id = request.params.id;
  if (typeof id !== 'string') {
    throw new Error('Workflow id must be a single value');
  }
  return id;
};

export const list = async (request: Request, response: Response): Promise<void> => {
  response.json(await listWorkflows(request.user!.id));
};

export const getById = async (request: Request, response: Response): Promise<void> => {
  const workflow = await findWorkflowById(workflowId(request), request.user!.id);
  if (!workflow) {
    response.status(404).json({ error: 'Workflow not found' });
    return;
  }
  response.json(workflow);
};

export const create = async (request: Request, response: Response): Promise<void> => {
  try {
    const { name, definition } = validateWorkflow(request.body);
    response.status(201).json(await createWorkflow(name, definition, request.user!.id));
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      response.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
};

export const update = async (request: Request, response: Response): Promise<void> => {
  try {
    const { name, definition } = validateWorkflow(request.body);
    const workflow = await updateWorkflow(workflowId(request), name, definition, request.user!.id);
    if (!workflow) {
      response.status(404).json({ error: 'Workflow not found' });
      return;
    }
    response.json(workflow);
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      response.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
};

export const remove = async (request: Request, response: Response): Promise<void> => {
  if (!(await removeWorkflow(workflowId(request), request.user!.id))) {
    response.status(404).json({ error: 'Workflow not found' });
    return;
  }
  response.status(204).send();
};
