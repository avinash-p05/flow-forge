ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS input JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS output JSONB;

ALTER TABLE job_executions
  ADD COLUMN IF NOT EXISTS input JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS output JSONB,
  ADD COLUMN IF NOT EXISTS error_code VARCHAR(40),
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE workflow_executions DROP CONSTRAINT IF EXISTS workflow_executions_status_check;
ALTER TABLE workflow_executions ADD CONSTRAINT workflow_executions_status_check
  CHECK (status IN ('PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED', 'BLOCKED'));
ALTER TABLE job_executions DROP CONSTRAINT IF EXISTS job_executions_status_check;
ALTER TABLE job_executions ADD CONSTRAINT job_executions_status_check
  CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED', 'BLOCKED', 'SKIPPED'));

CREATE TABLE IF NOT EXISTS job_attempts (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES job_executions(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT')),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error TEXT,
  error_code VARCHAR(40),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS job_attempts_job_id_idx ON job_attempts (job_id, attempt);
