-- ──────────────────────────────────────────────────────────────
-- 004 — Stock balances and movement ledger
-- facility_stock holds current on-hand quantities (denormalized for fast reads).
-- stock_movements is the immutable audit ledger — both tables are kept in sync
-- transactionally inside the movement service.
-- ──────────────────────────────────────────────────────────────

CREATE TYPE movement_type AS ENUM (
  'RECEIPT',                -- admin recorded stock arriving at a facility (+balance)
  'TRANSFER_OUT',           -- facility A sent to facility B  (-source balance)
  'TRANSFER_IN',            -- paired counterpart of TRANSFER_OUT (+dest balance)
  'ADJUSTMENT_INCREASE',    -- correction up (found, returned, etc.)
  'ADJUSTMENT_DECREASE'     -- correction down (damaged, lost, used)
);

-- Current on-hand stock at each facility (denormalized).
CREATE TABLE facility_stock (
  id                  SERIAL PRIMARY KEY,
  facility_id         INTEGER NOT NULL REFERENCES facilities(id) ON DELETE RESTRICT,
  tool_id             INTEGER NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
  quantity            INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  last_movement_at    TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (facility_id, tool_id)
);

CREATE INDEX idx_facility_stock_facility ON facility_stock (facility_id);
CREATE INDEX idx_facility_stock_tool     ON facility_stock (tool_id);

-- Append-only ledger. Every state change to facility_stock is a row here.
CREATE TABLE stock_movements (
  id                    SERIAL PRIMARY KEY,
  movement_type         movement_type NOT NULL,
  facility_id           INTEGER NOT NULL REFERENCES facilities(id) ON DELETE RESTRICT,
  tool_id               INTEGER NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  related_facility_id   INTEGER REFERENCES facilities(id) ON DELETE RESTRICT,
  related_movement_id   INTEGER REFERENCES stock_movements(id) ON DELETE RESTRICT,
  reference_no          TEXT,
  reason                TEXT,
  note                  TEXT,
  performed_by          INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  performed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_movements_facility       ON stock_movements (facility_id);
CREATE INDEX idx_movements_tool           ON stock_movements (tool_id);
CREATE INDEX idx_movements_type           ON stock_movements (movement_type);
CREATE INDEX idx_movements_performed_at   ON stock_movements (performed_at DESC);
CREATE INDEX idx_movements_performed_by   ON stock_movements (performed_by);
CREATE INDEX idx_movements_related        ON stock_movements (related_movement_id);

-- Transfer rows must reference a related facility; non-transfer rows must not.
ALTER TABLE stock_movements ADD CONSTRAINT movements_transfer_pairs_check
  CHECK (
    (movement_type IN ('TRANSFER_OUT', 'TRANSFER_IN') AND related_facility_id IS NOT NULL)
    OR (movement_type NOT IN ('TRANSFER_OUT', 'TRANSFER_IN') AND related_facility_id IS NULL)
  );
