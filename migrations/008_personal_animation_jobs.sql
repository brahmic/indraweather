CREATE TABLE personal_animation_jobs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel text NOT NULL,
  recipient_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('satellite', 'clouds')),
  viewport_key text NOT NULL,
  animation_context text NOT NULL,
  west double precision NOT NULL,
  south double precision NOT NULL,
  east double precision NOT NULL,
  north double precision NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  output_filename text,
  source text,
  started_at timestamptz,
  ended_at timestamptz,
  frame_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE UNIQUE INDEX personal_animation_jobs_active_idx
  ON personal_animation_jobs (channel, recipient_id, kind, viewport_key, animation_context)
  WHERE status IN ('pending', 'processing');

CREATE INDEX personal_animation_jobs_pending_idx
  ON personal_animation_jobs (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX personal_animation_jobs_cached_idx
  ON personal_animation_jobs (channel, recipient_id, kind, viewport_key, animation_context, processed_at DESC)
  WHERE status = 'completed';
