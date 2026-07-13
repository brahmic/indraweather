ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS deliveries_retry_idx
  ON deliveries (channel, next_attempt_at, updated_at)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS collection_runs_completed_at_idx
  ON collection_runs (completed_at);
