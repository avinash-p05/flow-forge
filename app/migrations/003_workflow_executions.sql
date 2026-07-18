CREATE TABLE IF NOT EXISTS workflow_executions (
  id UUID PRIMARY KEY,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED')),
  idempotency_key VARCHAR(255),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS workflow_executions_user_id_idx
  ON workflow_executions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_executions_status_idx
  ON workflow_executions (status, created_at);

CREATE TABLE IF NOT EXISTS job_executions (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  step_id VARCHAR(120) NOT NULL,
  step_name VARCHAR(120) NOT NULL,
  step_type VARCHAR(50) NOT NULL,
  step_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  step_order INTEGER NOT NULL CHECK (step_order >= 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (execution_id, step_id)
);

CREATE INDEX IF NOT EXISTS job_executions_execution_id_idx
  ON job_executions (execution_id, step_order);
