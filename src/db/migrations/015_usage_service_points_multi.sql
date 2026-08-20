-- A usage entry can name several service points (checkboxes) plus a free-text
-- "Others". Store the human-readable list here; service_point_id still holds the
-- first selected known point for simple filtering/back-compat.
ALTER TABLE tool_usage
  ADD COLUMN IF NOT EXISTS service_points TEXT;
