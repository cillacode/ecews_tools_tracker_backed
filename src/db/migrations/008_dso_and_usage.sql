-- ──────────────────────────────────────────────────────────────
-- 008 — DSO role + LGA-level scoping + weekly tool usage
--
-- Adds the Data Support Officer (DSO) role. A DSO is scoped to one
-- LGA and can read/report on every facility within that LGA — but
-- cannot record movements, manage users, or see other LGAs.
--
-- Also adds a tool_usage table: facility users record what tools were
-- used in a given week. Each (facility, tool, week) pair holds one
-- canonical row that's upserted on re-submission. The week's usage
-- decrements facility_stock (capped at 0) in the service layer.
-- ──────────────────────────────────────────────────────────────

-- 1. Extend the user_role enum.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'dso';

-- 2. Users now carry an optional lga_id (set for DSOs, NULL for everyone else).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS lga_id INTEGER REFERENCES lgas(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_users_lga_id ON users (lga_id);

-- 3. Replace the old facility_role check with a comprehensive scope check.
--    role::text comparison avoids the "new enum value not yet usable" rule
--    inside this transaction.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_facility_role_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_scope_check;

ALTER TABLE users ADD CONSTRAINT users_scope_check
  CHECK (
    CASE role::text
      WHEN 'facility_user' THEN facility_id IS NOT NULL AND lga_id IS NULL
      WHEN 'dso'           THEN lga_id      IS NOT NULL AND facility_id IS NULL
      ELSE                      facility_id IS NULL     AND lga_id      IS NULL
    END
  );

-- 4. Weekly tool usage. One canonical row per (facility, tool, week).
CREATE TABLE IF NOT EXISTS tool_usage (
  id              SERIAL PRIMARY KEY,
  facility_id     INTEGER NOT NULL REFERENCES facilities(id) ON DELETE RESTRICT,
  tool_id         INTEGER NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
  week_start_date DATE NOT NULL,
  usage_count     INTEGER NOT NULL CHECK (usage_count >= 0),
  note            TEXT,
  recorded_by     INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (facility_id, tool_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_tool_usage_facility   ON tool_usage (facility_id);
CREATE INDEX IF NOT EXISTS idx_tool_usage_tool       ON tool_usage (tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_usage_week_start ON tool_usage (week_start_date);
