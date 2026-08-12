import { Router } from 'express';
import { cancel, get, history, jobs, submit } from '../controllers/execution.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { rateLimit } from '../middleware/rate-limit.middleware.js';

export const executionRouter = Router();
executionRouter.use(requireAuth);
executionRouter.post('/workflows/:workflowId/executions', rateLimit, submit);
executionRouter.get('/executions/:id', get);
executionRouter.get('/executions/:id/jobs', jobs);
executionRouter.get('/executions/:id/history', history);
executionRouter.post('/executions/:id/cancel', cancel);
