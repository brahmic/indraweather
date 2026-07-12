CREATE TABLE map_viewports (
  channel text NOT NULL,
  recipient_id text NOT NULL,
  west double precision NOT NULL,
  south double precision NOT NULL,
  east double precision NOT NULL,
  north double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, recipient_id),
  CHECK (west >= -180 AND east <= 180 AND west < east),
  CHECK (south >= -84 AND north <= 84 AND south < north)
);
