-- Service delivery points (GOPD, ANC, ART Clinic, …). DB-driven so the list can
-- grow without a code change. Referenced by tool_usage entries.
CREATE TABLE IF NOT EXISTS service_points (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Starter list — expand this table as the full list is confirmed.
INSERT INTO service_points (name, sort_order) VALUES
  ('GOPD',       1),
  ('ANC',        2),
  ('ART Clinic', 3)
ON CONFLICT (name) DO NOTHING;

-- Capture, per usage entry: which service point the tools were given to, and
-- the physically counted balance recorded at entry time (validation audit).
ALTER TABLE tool_usage
  ADD COLUMN IF NOT EXISTS service_point_id INTEGER REFERENCES service_points(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS physical_balance INTEGER;
