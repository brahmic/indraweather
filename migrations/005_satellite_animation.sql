CREATE TABLE satellite_capture_jobs (
  scheduled_for timestamptz PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX satellite_capture_jobs_pending_idx
  ON satellite_capture_jobs (next_attempt_at, scheduled_for)
  WHERE status IN ('pending', 'failed');

CREATE TABLE satellite_animation_frames (
  observed_at timestamptz PRIMARY KEY,
  filename text NOT NULL UNIQUE,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  source text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX satellite_animation_frames_observed_idx
  ON satellite_animation_frames (observed_at DESC);
