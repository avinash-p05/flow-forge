import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { authRouter } from './api/auth.js';
import { executionRouter } from './api/executions.js';
import { opsRouter } from './api/metrics.js';
import { workflowRouter } from './api/workflows.js';
import { log } from './infra/log.js';

export const app = express();

app.use(express.json({ limit: '256kb' }));

// Request log with a correlation id (echoed back as x-request-id).
app.use((request, response, next) => {
  const requestId = request.header('x-request-id') ?? randomUUID();
  const startedAt = Date.now();
  response.setHeader('x-request-id', requestId);
  response.on('finish', () => log('http.request', {
    requestId, method: request.method, path: request.originalUrl, status: response.statusCode, ms: Date.now() - startedAt,
  }));
  next();
});

app.use('/', opsRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/workflows', workflowRouter);
app.use('/api/v1', executionRouter);

app.use((_request, response) => {
  response.status(404).json({ error: 'Not found' });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  log('http.error', { error: error instanceof Error ? error.stack : String(error) });
  response.status(500).json({ error: 'Internal server error' });
});
