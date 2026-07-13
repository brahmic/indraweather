CREATE TABLE IF NOT EXISTS marine_forecast_values (
  run_id uuid NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
  point_id text NOT NULL REFERENCES control_points(id),
  forecast_at timestamptz NOT NULL,
  wave_height_m double precision,
  wave_direction_deg double precision,
  wave_period_seconds double precision,
  wind_wave_height_m double precision,
  swell_height_m double precision,
  current_speed_kmh double precision,
  current_direction_deg double precision,
  sea_surface_temperature_c double precision,
  PRIMARY KEY (run_id, point_id, forecast_at)
);

CREATE INDEX IF NOT EXISTS marine_forecast_values_lookup_idx
  ON marine_forecast_values (run_id, point_id, forecast_at);
