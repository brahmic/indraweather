ALTER TABLE tide_extremes
  ADD COLUMN IF NOT EXISTS point_id text REFERENCES control_points(id),
  ADD COLUMN IF NOT EXISTS station_distance_km double precision;

UPDATE tide_extremes
SET point_id = 'kandalaksha-roadstead'
WHERE point_id IS NULL;

ALTER TABLE tide_extremes
  ALTER COLUMN point_id SET NOT NULL;

ALTER TABLE tide_extremes
  DROP CONSTRAINT IF EXISTS tide_extremes_source_extreme_at_type_key;

ALTER TABLE tide_extremes
  ADD CONSTRAINT tide_extremes_point_source_extreme_at_type_key
  UNIQUE (point_id, source, extreme_at, type);

CREATE INDEX IF NOT EXISTS tide_extremes_point_lookup_idx
  ON tide_extremes (point_id, extreme_at);
