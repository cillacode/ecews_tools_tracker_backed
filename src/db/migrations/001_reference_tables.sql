-- ──────────────────────────────────────────────────────────────
-- 001 — Reference data tables
-- States, LGAs, Facilities, and Thematic Areas
-- ──────────────────────────────────────────────────────────────

-- Enable trigram fuzzy-search support (used for facility & tool name lookup).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE thematic_areas (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  code        TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE states (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE lgas (
  id          SERIAL PRIMARY KEY,
  state_id    INTEGER NOT NULL REFERENCES states(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (state_id, name)
);

CREATE INDEX idx_lgas_state_id ON lgas (state_id);

CREATE TABLE facilities (
  id          SERIAL PRIMARY KEY,
  lga_id      INTEGER NOT NULL REFERENCES lgas(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  code        TEXT UNIQUE,                       -- optional code (e.g. DATIM ID); nullable for now
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lga_id, name)
);

CREATE INDEX idx_facilities_lga_id     ON facilities (lga_id);
CREATE INDEX idx_facilities_active     ON facilities (is_active);
CREATE INDEX idx_facilities_name_trgm  ON facilities USING gin (name gin_trgm_ops);
