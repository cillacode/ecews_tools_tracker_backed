-- ──────────────────────────────────────────────────────────────
-- 011 — State-level low-stock thresholds
--
-- tool_thresholds gets a nullable state_id so each state admin
-- can set defaults that only apply within their state. Resolution
-- order in dashboard/low-stock query (most specific first):
--   1. facility-specific  (state_id NULL, facility_id set)
--   2. state-level        (state_id set, facility_id NULL)
--   3. global default     (both NULL)
--
-- Two new partial unique indexes prevent duplicate state-default
-- rows and complement the existing facility/global ones.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE tool_thresholds
  ADD COLUMN IF NOT EXISTS state_id INTEGER REFERENCES states(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_tool_thresholds_state_id ON tool_thresholds (state_id);

-- A given (tool, state) pair (facility-less) can only have one threshold.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tool_thresholds_state
  ON tool_thresholds (tool_id, state_id)
  WHERE state_id IS NOT NULL AND facility_id IS NULL;

-- Sanity check: a row cannot be BOTH facility-specific AND state-specific.
ALTER TABLE tool_thresholds DROP CONSTRAINT IF EXISTS tool_thresholds_scope_check;
ALTER TABLE tool_thresholds ADD CONSTRAINT tool_thresholds_scope_check
  CHECK (NOT (facility_id IS NOT NULL AND state_id IS NOT NULL));
