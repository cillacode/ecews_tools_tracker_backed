-- ──────────────────────────────────────────────────────────────
-- 006 — Phase 2: Movement acknowledgments and disputes
-- Adds acknowledgment status and dispute resolution tracking to stock_movements.
-- ──────────────────────────────────────────────────────────────

-- Add acknowledgment status enum
CREATE TYPE ack_status AS ENUM (
  'PENDING_ACK',    -- movement recorded, awaiting facility acknowledgment
  'ACKED',          -- facility has acknowledged receipt/transfer
  'DISPUTED'        -- facility disputes the movement (quantity, etc.)
);

-- Add acknowledgment and dispute columns to stock_movements
ALTER TABLE stock_movements
  ADD COLUMN ack_status ack_status NOT NULL DEFAULT 'PENDING_ACK',
  ADD COLUMN dispute_reason TEXT,
  ADD COLUMN dispute_resolved_at TIMESTAMPTZ,
  ADD COLUMN dispute_resolved_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN dispute_resolution_note TEXT;

-- Index for common queries
CREATE INDEX idx_movements_ack_status ON stock_movements (ack_status);
CREATE INDEX idx_movements_dispute_resolved ON stock_movements (dispute_resolved_at) WHERE dispute_resolved_at IS NOT NULL;