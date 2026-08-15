-- ──────────────────────────────────────────────────────────────
-- 013 — State-tier acknowledgement + distribution batch numbers
--
-- Part A: the state admin acknowledges HQ → state receipts (accept-only,
--         with the names of who physically received them). Mirrors the
--         facility acknowledgement, but simpler (no dispute path).
--
-- Part C: facility distributions done via CSV import are grouped under a
--         batch number so a per-facility gate-pass PDF can be printed.
-- ──────────────────────────────────────────────────────────────

-- Part A — acknowledgement columns on the HQ → state ledger.
CREATE TYPE state_ack_status AS ENUM ('PENDING_ACK', 'ACCEPTED');

ALTER TABLE state_movements
  ADD COLUMN IF NOT EXISTS ack_status     state_ack_status NOT NULL DEFAULT 'PENDING_ACK',
  ADD COLUMN IF NOT EXISTS ack_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ack_by         INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS receiver_names TEXT,
  ADD COLUMN IF NOT EXISTS ack_note       TEXT;

CREATE INDEX IF NOT EXISTS idx_state_movements_pending
  ON state_movements (state_id, performed_at DESC)
  WHERE ack_status = 'PENDING_ACK';

-- Part C — batch grouping for facility distributions created via import.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS batch_no TEXT;

CREATE INDEX IF NOT EXISTS idx_stock_movements_batch
  ON stock_movements (batch_no)
  WHERE batch_no IS NOT NULL;
