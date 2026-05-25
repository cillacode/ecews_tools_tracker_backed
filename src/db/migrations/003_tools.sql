-- ──────────────────────────────────────────────────────────────
-- 003 — Tools
-- The 47 MER tools, classified by thematic area.
-- status: NEW_MODIFIED vs RETAINED (matches the source slide).
-- is_new_indicator   — the [N] tag
-- is_ip_retained     — the [IP] tag
-- ──────────────────────────────────────────────────────────────

CREATE TYPE tool_status AS ENUM ('NEW_MODIFIED', 'RETAINED');

CREATE TABLE tools (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  thematic_area_id   INTEGER NOT NULL REFERENCES thematic_areas(id) ON DELETE RESTRICT,
  status             tool_status NOT NULL,
  is_new_indicator   BOOLEAN NOT NULL DEFAULT FALSE,
  is_ip_retained     BOOLEAN NOT NULL DEFAULT FALSE,
  description        TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, thematic_area_id)
);

CREATE INDEX idx_tools_thematic_area ON tools (thematic_area_id);
CREATE INDEX idx_tools_status        ON tools (status);
CREATE INDEX idx_tools_active        ON tools (is_active);
CREATE INDEX idx_tools_name_trgm     ON tools USING gin (name gin_trgm_ops);
