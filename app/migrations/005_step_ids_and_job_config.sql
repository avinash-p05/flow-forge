ALTER TABLE job_executions
  ADD COLUMN IF NOT EXISTS step_id VARCHAR(120);

ALTER TABLE job_executions
  ADD COLUMN IF NOT EXISTS step_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE job_executions
  ADD COLUMN IF NOT EXISTS depends_on TEXT[] NOT NULL DEFAULT '{}';

WITH ranked_steps AS (
  SELECT
    id,
    step_name,
    ROW_NUMBER() OVER (PARTITION BY execution_id, step_name ORDER BY id) AS duplicate_rank
  FROM job_executions
  WHERE step_id IS NULL
)
UPDATE job_executions AS jobs
SET step_id = CASE
  WHEN ranked.duplicate_rank = 1 THEN ranked.step_name
  ELSE ranked.step_name || '-' || ranked.id::text
END
FROM ranked_steps AS ranked
WHERE jobs.id = ranked.id;

ALTER TABLE job_executions
  ALTER COLUMN step_id SET NOT NULL;

ALTER TABLE job_executions
  DROP CONSTRAINT IF EXISTS job_executions_execution_id_step_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS job_executions_execution_id_step_id_key
  ON job_executions (execution_id, step_id);

CREATE INDEX IF NOT EXISTS job_executions_dependencies_idx
  ON job_executions (execution_id, step_id);
