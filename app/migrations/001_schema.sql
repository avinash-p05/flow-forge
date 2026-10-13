-- Users who own workflows and executions.
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY,
  email         VARCHAR(320) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A workflow is a reusable DAG definition: { steps: [{ id, type, config, dependsOn }] }.
CREATE TABLE IF NOT EXISTS workflows (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(120) NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workflows_user_idx ON workflows (user_id, created_at DESC);

-- One row per run of a workflow.
--   QUEUED    waiting to be picked up (next_attempt_at says when it is due)
--   RUNNING   leased by one worker until locked_until
--   COMPLETED / FAILED / CANCELLED are terminal
CREATE TABLE IF NOT EXISTS executions (
  id              UUID PRIMARY KEY,
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          VARCHAR(20) NOT NULL
                  CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  idempotency_key VARCHAR(255),
  input           JSONB NOT NULL DEFAULT '{}'::jsonb,
  output          JSONB,
  error           TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by       TEXT,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS executions_due_idx   ON executions (next_attempt_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS executions_lease_idx ON executions (locked_until)    WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS executions_workflow_idx ON executions (workflow_id, status);

-- One row per step of an execution (the unit of work a worker runs).
CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY,
  execution_id    UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  step_id         VARCHAR(120) NOT NULL,
  step_type       VARCHAR(50) NOT NULL,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  depends_on      TEXT[] NOT NULL DEFAULT '{}',
  step_order      INTEGER NOT NULL,
  status          VARCHAR(20) NOT NULL
                  CHECK (status IN ('PENDING', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  claim_id        UUID,
  output          JSONB,
  error           TEXT,
  error_code      VARCHAR(40),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  UNIQUE (execution_id, step_id)
);
CREATE INDEX IF NOT EXISTS jobs_execution_idx ON jobs (execution_id, status);

-- Every attempt of every job, so retries and worker crashes are visible after the fact.
CREATE TABLE IF NOT EXISTS job_attempts (
  id          UUID PRIMARY KEY,
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt     INTEGER NOT NULL,
  worker_id   TEXT NOT NULL,
  status      VARCHAR(20) NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'LOST')),
  error       TEXT,
  error_code  VARCHAR(40),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS job_attempts_job_idx ON job_attempts (job_id, attempt);
CREATE INDEX IF NOT EXISTS job_attempts_finished_idx ON job_attempts (finished_at);

-- Jobs that exhausted their retries (or failed with a non-retryable error).
CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  job_id       UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  error        TEXT NOT NULL,
  error_code   VARCHAR(40),
  attempts     INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replayed_at  TIMESTAMPTZ
);

-- Worker slots report a heartbeat so /metrics can show how many are alive and busy.
CREATE TABLE IF NOT EXISTS workers (
  id                TEXT PRIMARY KEY,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_execution UUID
);
