CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  event_type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_execution_id_idx
  ON audit_logs (execution_id, created_at);
