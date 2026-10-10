import { app } from './app.js';
import { config } from './infra/config.js';
import { runMigrations } from './infra/db.js';
import { log } from './infra/log.js';
import { isQueueEnabled } from './infra/queue.js';

if (config.auth.secret.length < 32) throw new Error('AUTH_TOKEN_SECRET must be at least 32 characters');

await runMigrations();
const server = app.listen(config.port, () => {
  log('api.started', { port: config.port, queue: isQueueEnabled() ? 'sqs' : 'postgres-polling' });
});

process.on('SIGTERM', () => server.close());
