-- ──────────────────────────────────────────────────────────────
-- 002 — Users
-- Roles: admin, central_logistics, facility_user, viewer
-- facility_id is nullable (admin/central users aren't tied to a facility).
-- ──────────────────────────────────────────────────────────────

CREATE TYPE user_role AS ENUM ('admin', 'central_logistics', 'facility_user', 'viewer');

CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  full_name       TEXT NOT NULL,
  role            user_role NOT NULL DEFAULT 'viewer',
  facility_id     INTEGER REFERENCES facilities(id) ON DELETE RESTRICT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_role        ON users (role);
CREATE INDEX idx_users_facility_id ON users (facility_id);
CREATE INDEX idx_users_active      ON users (is_active);

-- A facility_user MUST have a facility_id; other roles must NOT.
ALTER TABLE users ADD CONSTRAINT users_facility_role_check
  CHECK (
    (role = 'facility_user' AND facility_id IS NOT NULL)
    OR (role <> 'facility_user' AND facility_id IS NULL)
  );
