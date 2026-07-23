ALTER TABLE forecast_values
  ADD COLUMN IF NOT EXISTS relative_humidity_pct double precision,
  ADD COLUMN IF NOT EXISTS dew_point_c double precision,
  ADD COLUMN IF NOT EXISTS apparent_temperature_c double precision;
