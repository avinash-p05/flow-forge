import { Router } from 'express';
import { create, getById, list, remove, update } from '../controllers/workflow.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

export const workflowRouter = Router();
workflowRouter.use(requireAuth);
workflowRouter.get('/', list);
workflowRouter.get('/:id', getById);
workflowRouter.post('/', create);
workflowRouter.put('/:id', update);
workflowRouter.delete('/:id', remove);
