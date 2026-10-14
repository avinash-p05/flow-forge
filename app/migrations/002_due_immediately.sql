-- New executions and jobs are due immediately, without comparing timestamps written by different
-- processes (their clocks can differ by ~100 ms, which made fresh work look "not due yet").
-- Only a scheduled retry stores a real time in next_attempt_at.
ALTER TABLE executions ALTER COLUMN next_attempt_at SET DEFAULT '-infinity';
ALTER TABLE jobs       ALTER COLUMN next_attempt_at SET DEFAULT '-infinity';
