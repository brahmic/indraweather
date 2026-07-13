CREATE TABLE manual_update_owners (
  channel text PRIMARY KEY CHECK (channel IN ('telegram', 'max')),
  recipient_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
