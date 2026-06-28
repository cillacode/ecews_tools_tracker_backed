-- ──────────────────────────────────────────────────────────────
-- 010 — Multi-state scaling
--
-- Adds the super_admin role for HQ-level accounts and a state_id
-- column on users so admin/central/viewer are bound to one state.
--
-- The check constraint now covers every role:
--   super_admin   : everything NULL (sees all states)
--   admin         : state_id NOT NULL, facility_id/lga_id NULL
--   central_logistics : state_id NOT NULL, facility_id/lga_id NULL
--   facility_user : facility_id NOT NULL, lga_id/state_id NULL
--   dso           : lga_id NOT NULL, facility_id/state_id NULL
--   viewer        : state_id NULL (HQ viewer) OR set (state viewer)
--
-- role::text comparisons sidestep the "new enum value not yet
-- usable" rule inside this same transaction.
-- ──────────────────────────────────────────────────────────────

-- 1. Add super_admin to the user_role enum.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'super_admin';

-- 2. New state_id column on users (nullable — only set for state-scoped roles).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS state_id INTEGER REFERENCES states(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_users_state_id ON users (state_id);

-- 3. Drop and replace the scope check. Old constraint only knew about
--    facility_user / dso; the new one is exhaustive.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_scope_check;

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
