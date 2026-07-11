ALTER TABLE bulletins
  ADD COLUMN content_format text NOT NULL DEFAULT 'telegram_html'
  CHECK (content_format IN ('plain', 'telegram_html'));

ALTER TABLE bulletins
  ALTER COLUMN content_format SET DEFAULT 'plain';
