//configure express and middleware in app.ts and export the app
import express from 'express';
import { authRouter } from './routes/auth.routes.js';
import { executionRouter } from './routes/execution.routes.js';
import { workflowRouter } from './routes/workflow.routes.js';
import { getMetrics } from './metrics.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const apiRouter = express.Router();

app.use(express.json({ limit: '256kb' }));
app.use((request, response, next) => {
  const requestId = request.header('x-request-id') ?? randomUUID();
  response.setHeader('x-request-id', requestId);
  const startedAt = Date.now();
  response.on('finish', () => {
    console.info(JSON.stringify({
      event: 'http.request',
      requestId,
      method: request.method,
      path: request.path,
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
    }));
  });
  next();
});
app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use('/api/v1', apiRouter);

apiRouter.get('/health', (_request, response) => {
  response.status(200).json({
    status: 'ok',
    service: 'flowforge-api',
  });
});

apiRouter.get('/metrics', (_request, response) => {
  response.json(getMetrics());
});

apiRouter.get('/metrics/prometheus', (_request, response) => {
  response.type('text/plain').send(
    Object.entries(getMetrics())
      .map(([name, value]) => `flowforge_${name.replace(/[^a-zA-Z0-9_]/g, '_')} ${value}`)
      .join('\n'),
  );
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/workflows', workflowRouter);
apiRouter.use('/', executionRouter);

//this path should be - static/client/public
const frontendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'static/client/public');
app.use(express.static(frontendDirectory));
app.use((request, response, next) => {
  if (request.method !== 'GET' || !request.accepts('html')) {
    next();
    return;
  }
  response.sendFile(path.join(frontendDirectory, 'index.html'), (error) => {
    if (error) next(error);
  });
});

app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
  console.error(error);
  if (response.headersSent) {
    next(error);
    return;
  }

  response.status(503).json({
    error: 'Service temporarily unavailable',
  });
});

export default app;