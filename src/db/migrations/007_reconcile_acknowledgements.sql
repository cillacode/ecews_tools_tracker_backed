-- ──────────────────────────────────────────────────────────────
-- 007 — Reconcile acknowledgement schema
--
-- An earlier 006_ack_disputes.sql migration installed a partial schema
-- (different enum values, TEXT dispute_reason, no ack_at / ack_by /
-- disputed_quantity / dispute_note / dispute_resolution_movement_id).
-- The application code was rewritten against the canonical workflow.
-- This migration realigns the database with the canonical schema, in
-- a way that's safe for both:
--   (a) existing deployments that ran 006_ack_disputes.sql
--   (b) fresh deployments running migrations from scratch
--
-- Existing RECEIPT and TRANSFER_IN rows are backfilled with PENDING_ACK
-- so facility users can acknowledge stock recorded prior to this change.
-- ──────────────────────────────────────────────────────────────

-- 1. Drop legacy indexes (they reference columns we're about to drop).
DROP INDEX IF EXISTS idx_movements_ack_status;
DROP INDEX IF EXISTS idx_movements_dispute_resolved;

-- 2. Drop legacy CHECK constraints if present (so column drops succeed).
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS movements_ack_type_check;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS movements_dispute_consistency_check;

-- 3. Drop columns from the old schema that we don't want.
ALTER TABLE stock_movements
  DROP COLUMN IF EXISTS dispute_resolved_by,
  DROP COLUMN IF EXISTS dispute_resolution_note;

-- 4. Drop columns we'll re-add with different types.
ALTER TABLE stock_movements
  DROP COLUMN IF EXISTS ack_status,
  DROP COLUMN IF EXISTS dispute_reason;

-- 5. Drop the legacy enum type (now that no column references it).
DROP TYPE IF EXISTS ack_status;

-- 6. Create the canonical enums (idempotent — skip if already created).
DO $$ BEGIN
  CREATE TYPE acknowledgement_status AS ENUM ('PENDING_ACK', 'ACCEPTED', 'DISPUTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dispute_reason_code AS ENUM ('INCOMPLETE', 'DAMAGED', 'WRONG_TOOL', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 7. Add the columns the application expects. IF NOT EXISTS keeps this
--    safe for fresh setups where dispute_resolved_at was never created.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS ack_status                     acknowledgement_status,
  ADD COLUMN IF NOT EXISTS ack_at                         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ack_by                         INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS dispute_reason                 dispute_reason_code,
  ADD COLUMN IF NOT EXISTS disputed_quantity              INTEGER CHECK (disputed_quantity >= 0),
  ADD COLUMN IF NOT EXISTS dispute_note                   TEXT,
  ADD COLUMN IF NOT EXISTS dispute_resolved_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispute_resolution_movement_id INTEGER REFERENCES stock_movements(id) ON DELETE RESTRICT;

-- 8. Backfill: every existing RECEIPT and TRANSFER_IN gets PENDING_ACK
--    so it shows up on /incoming under the new workflow.
UPDATE stock_movements
SET ack_status = 'PENDING_ACK'
WHERE movement_type IN ('RECEIPT', 'TRANSFER_IN')
  AND ack_status IS NULL;

-- 9. Indexes for the two hot queries.
CREATE INDEX IF NOT EXISTS idx_movements_pending_ack
  ON stock_movements (facility_id, performed_at DESC)
  WHERE ack_status = 'PENDING_ACK';

CREATE INDEX IF NOT EXISTS idx_movements_open_disputes
  ON stock_movements (ack_at DESC)
  WHERE ack_status = 'DISPUTED' AND dispute_resolved_at IS NULL;

-- 10. CHECK constraints — re-add fresh.
ALTER TABLE stock_movements ADD CONSTRAINT movements_ack_type_check
  CHECK (
    (ack_status IS NULL)
    OR (movement_type IN ('RECEIPT', 'TRANSFER_IN'))
  );

ALTER TABLE stock_movements ADD CONSTRAINT movements_dispute_consistency_check
  CHECK (
    ack_status IS DISTINCT FROM 'DISPUTED'
    OR (dispute_reason IS NOT NULL AND disputed_quantity IS NOT NULL)
  );
