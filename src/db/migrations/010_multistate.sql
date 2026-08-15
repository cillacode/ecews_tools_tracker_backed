-- ──────────────────────────────────────────────────────────────
-- 010 — Multi-state scaling
--
-- Adds the super_admin role for HQ-level accounts and a state_id
-- column on users so admin/central/viewer are bound to one state.
--
-- IMPORTANT: this migration includes a data backfill *between* the
-- schema change and the new check constraint. Without the backfill,
-- any pre-existing 'admin' / 'central_logistics' / 'viewer' rows
-- would violate the new constraint and ROLLBACK the migration.
--
-- Final role/scope shape:
--   super_admin       : everything NULL  (sees all states)
--   admin             : state_id NOT NULL
--   central_logistics : state_id NOT NULL
--   viewer            : state_id any (NULL = HQ viewer, set = state viewer)
--   facility_user     : facility_id NOT NULL (state derived via facility)
--   dso               : lga_id NOT NULL      (state derived via LGA)
-- ──────────────────────────────────────────────────────────────

-- 1. Add super_admin to the enum. (Used as a STRING LITERAL only in the
--    CHECK constraint below — never as an enum value in this transaction,
--    so the PG 12+ "new value cannot be used in same txn" rule doesn't bite.)
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'super_admin';

-- 2. Add the state_id column on users.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS state_id INTEGER REFERENCES states(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_users_state_id ON users (state_id);

-- 3. Drop the old (state-unaware) constraint before mutating data.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_scope_check;

-- 4. Backfill: every existing admin / central_logistics / viewer that
--    doesn't have a state yet → pin to Lagos. This puts existing rows
--    into a valid state BEFORE we re-add the check constraint.
--    If Lagos doesn't exist yet (fresh DB), the UPDATE is a no-op and
--    there are no existing rows to violate the constraint anyway.
DO $backfill$
DECLARE
  v_lagos_id INTEGER;
BEGIN
  SELECT id INTO v_lagos_id FROM states WHERE name = 'Lagos' LIMIT 1;

  IF v_lagos_id IS NOT NULL THEN
    UPDATE users
       SET state_id  = v_lagos_id,
           updated_at = NOW()
     WHERE role IN ('admin', 'central_logistics', 'viewer')
       AND state_id IS NULL;
  END IF;
END $backfill$;

-- 5. Install the comprehensive constraint. role::text comparisons sidestep
--    the "new enum value not yet usable inside same transaction" rule —
--    the CHECK never evaluates an enum literal, only a text one.
ALTER TABLE users ADD CONSTRAINT users_scope_check
  CHECK (
    CASE role::text
      WHEN 'super_admin'       THEN state_id IS NULL     AND lga_id IS NULL     AND facility_id IS NULL
      WHEN 'admin'             THEN state_id IS NOT NULL AND lga_id IS NULL     AND facility_id IS NULL
      WHEN 'central_logistics' THEN state_id IS NOT NULL AND lga_id IS NULL     AND facility_id IS NULL
      WHEN 'facility_user'     THEN facility_id IS NOT NULL AND lga_id IS NULL AND state_id IS NULL
      WHEN 'dso'               THEN lga_id IS NOT NULL  AND facility_id IS NULL AND state_id IS NULL
      WHEN 'viewer'            THEN facility_id IS NULL  AND lga_id IS NULL
      ELSE FALSE
    END
  );
