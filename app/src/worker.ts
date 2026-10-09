import os from 'node:os';
import { config } from './infra/config.js';
import { pool, runMigrations } from './infra/db.js';
import { runWorkerSlot } from './engine/executor.js';
import { removeWorker } from './engine/job-store.js';
import { log } from './infra/log.js';
import { isQueueEnabled } from './infra/queue.js';

/**
 * Worker process. Runs WORKER_CONCURRENCY independent slots; each slot works on one execution at a time.
 * Scale out by running more processes/containers (e.g. 5 containers x 10 slots = 50 concurrent workers).
 */
let stopping = false;

const main = async (): Promise<void> => {
  await runMigrations();
  const ids = Array.from({ length: config.worker.concurrency }, (_, slot) => `${os.hostname()}-${process.pid}-${slot}`);
  log('worker.started', { slots: ids.length, queue: isQueueEnabled() ? 'sqs' : 'postgres-polling' });

  // On SIGTERM (ECS deploy, docker stop) finish in-flight work, then exit.
  // Anything not finished is picked up by another worker once its lease expires.
  const shutdown = () => {
    if (!stopping) log('worker.stopping');
    stopping = true;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await Promise.all(ids.map((id) => runWorkerSlot(id, () => stopping)));
  await Promise.all(ids.map((id) => removeWorker(id).catch(() => {})));
  await pool.end();
  log('worker.stopped');
};

main().catch((error: unknown) => {
  console.error('Worker crashed', error);
  process.exit(1);
});
