-- ──────────────────────────────────────────────────────────────
-- 005 — Phase 2 reservation: low-stock thresholds
-- A row with facility_id = NULL acts as the global default for that tool.
-- A row with facility_id set overrides the default for that facility.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE tool_thresholds (
  id            SERIAL PRIMARY KEY,
  tool_id       INTEGER NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
  facility_id   INTEGER REFERENCES facilities(id) ON DELETE RESTRICT,
  min_quantity  INTEGER NOT NULL CHECK (min_quantity >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A given (tool, facility) pair can only have one threshold.
-- Two partial unique indexes — one for the global default, one for facility overrides —
-- because NULL is not equal to NULL in a normal UNIQUE constraint.
CREATE UNIQUE INDEX uniq_tool_thresholds_global
  ON tool_thresholds (tool_id) WHERE facility_id IS NULL;

CREATE UNIQUE INDEX uniq_tool_thresholds_facility
  ON tool_thresholds (tool_id, facility_id) WHERE facility_id IS NOT NULL;
