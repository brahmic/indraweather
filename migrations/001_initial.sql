CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_points (
  id text PRIMARY KEY,
  name text NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  display_order integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('scheduled', 'manual')),
  scheduled_for timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  error text
);

CREATE TABLE IF NOT EXISTS forecast_values (
  run_id uuid NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
  point_id text NOT NULL REFERENCES control_points(id),
  model text NOT NULL CHECK (model IN ('ecmwf', 'gfs')),
  forecast_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  wind_speed_ms double precision,
  wind_gust_ms double precision,
  wind_direction_deg double precision,
  precipitation_mm double precision,
  precipitation_probability_pct double precision,
  visibility_km double precision,
  pressure_hpa double precision,
  temperature_c double precision,
  PRIMARY KEY (run_id, point_id, model, forecast_at)
);

CREATE INDEX IF NOT EXISTS forecast_values_lookup_idx
  ON forecast_values (point_id, model, forecast_at DESC);

CREATE TABLE IF NOT EXISTS tide_extremes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extreme_at timestamptz NOT NULL,
  type text NOT NULL CHECK (type IN ('high', 'low')),
  height_m double precision,
  source text NOT NULL,
  station_name text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, extreme_at, type)
);

CREATE TABLE IF NOT EXISTS official_warnings (
  fingerprint text PRIMARY KEY,
  source text NOT NULL,
  source_url text NOT NULL,
  raw_text text NOT NULL,
  published_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS bulletins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES collection_runs(id),
  kind text NOT NULL CHECK (kind IN ('scheduled', 'manual')),
  dedupe_key text NOT NULL UNIQUE,
  content text NOT NULL,
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscribers (
  chat_id bigint PRIMARY KEY,
  active boolean NOT NULL DEFAULT true,
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deliveries (
  bulletin_id uuid NOT NULL REFERENCES bulletins(id) ON DELETE CASCADE,
  chat_id bigint NOT NULL REFERENCES subscribers(chat_id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  telegram_message_id bigint,
  last_error text,
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bulletin_id, chat_id)
);
