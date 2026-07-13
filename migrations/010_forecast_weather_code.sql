ALTER TABLE forecast_values
  ADD COLUMN IF NOT EXISTS weather_code integer;
