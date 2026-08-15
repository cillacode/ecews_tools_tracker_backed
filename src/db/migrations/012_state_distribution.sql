-- ──────────────────────────────────────────────────────────────
-- 012 — HQ → State distribution tier
--
-- A new layer ABOVE facilities. Super-admin (HQ) records tools sent to
-- each STATE. This is intentionally independent of the facility ledger
-- (facility_stock / stock_movements) — the two tiers don't yet draw
-- down from each other. State admins continue to receive into facilities
-- exactly as before.
--
--   state_movements : append-only ledger of HQ → state distributions
--   state_stock     : denormalized per-(state, tool) balance
-- ──────────────────────────────────────────────────────────────

-- Per-state on-hand balance (denormalized, kept in sync transactionally).
CREATE TABLE IF NOT EXISTS state_stock (
  id               SERIAL PRIMARY KEY,
  state_id         INTEGER NOT NULL REFERENCES states(id) ON DELETE RESTRICT,
  tool_id          INTEGER NOT NULL REFERENCES tools(id)  ON DELETE RESTRICT,
  quantity         INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  last_movement_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (state_id, tool_id)
);

CREATE INDEX IF NOT EXISTS idx_state_stock_state ON state_stock (state_id);
CREATE INDEX IF NOT EXISTS idx_state_stock_tool  ON state_stock (tool_id);

-- Append-only ledger of HQ → state distributions. Only RECEIPT for now
-- (transfers/adjustments are not part of the HQ tier).
CREATE TABLE IF NOT EXISTS state_movements (
  id            SERIAL PRIMARY KEY,
  movement_type TEXT NOT NULL DEFAULT 'RECEIPT' CHECK (movement_type = 'RECEIPT'),
  state_id      INTEGER NOT NULL REFERENCES states(id) ON DELETE RESTRICT,
  tool_id       INTEGER NOT NULL REFERENCES tools(id)  ON DELETE RESTRICT,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  reference_no  TEXT,
  note          TEXT,
  performed_by  INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  performed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_state_movements_state        ON state_movements (state_id);
CREATE INDEX IF NOT EXISTS idx_state_movements_tool         ON state_movements (tool_id);
CREATE INDEX IF NOT EXISTS idx_state_movements_performed_at ON state_movements (performed_at DESC);
