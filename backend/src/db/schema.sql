-- =====================================================================
-- Organization Controller — Core Schema
-- Postgres 14+ required (ltree extension, gen_random_uuid via pgcrypto)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS ltree;

-- ---------------------------------------------------------------------
-- Tenants: one row per institution (school, hospital, university, ...)
-- Every other table carries organization_id and every query must filter
-- by it. Row Level Security below enforces this even if app code forgets.
-- ---------------------------------------------------------------------
CREATE TABLE organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- People: the tree. Login identity + hierarchy position + profile live
-- on one row for simplicity; split into profile table if it grows.
-- ---------------------------------------------------------------------
CREATE TABLE people (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id        UUID REFERENCES people(id) ON DELETE RESTRICT,
  path             LTREE NOT NULL,        -- materialized ancestor path, id segments without dashes
  role_title       TEXT NOT NULL DEFAULT 'Member',
  name             TEXT NOT NULL,
  email            CITEXT,
  password_hash    TEXT NOT NULL,
  is_head          BOOLEAN NOT NULL DEFAULT false,   -- true only for the single root of each org
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- one root per organization
  CONSTRAINT people_email_org_unique UNIQUE (organization_id, email)
);

CREATE EXTENSION IF NOT EXISTS citext;

CREATE INDEX people_path_gist_idx ON people USING GIST (path);
CREATE INDEX people_org_idx        ON people (organization_id);
CREATE INDEX people_parent_idx     ON people (parent_id);

-- Enforce exactly one head per organization
CREATE UNIQUE INDEX one_head_per_org ON people (organization_id) WHERE is_head;

-- ---------------------------------------------------------------------
-- Profiles: qualifications / experience / free-form CV-derived data.
-- Kept separate from `people` so AI-import drafts don't touch login data.
-- ---------------------------------------------------------------------
CREATE TABLE profiles (
  person_id        UUID PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  qualifications   JSONB NOT NULL DEFAULT '[]',   -- [{degree, institution, year}]
  experience       JSONB NOT NULL DEFAULT '[]',   -- [{title, org, start, end, description}]
  bio              TEXT,
  phone            TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Documents: CVs and other files. Actual bytes live in S3-style storage;
-- this row is metadata + pointer.
-- ---------------------------------------------------------------------
CREATE TABLE documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id        UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'cv',   -- cv | certificate | contract | other
  storage_key       TEXT NOT NULL,               -- S3 object key
  original_filename TEXT NOT NULL,
  mime_type         TEXT,
  uploaded_by       UUID REFERENCES people(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX documents_person_idx ON documents (organization_id, person_id);

-- ---------------------------------------------------------------------
-- CV Import Drafts: raw Gemini extraction, held for human confirmation
-- before it ever touches the real profile table.
-- ---------------------------------------------------------------------
CREATE TABLE cv_import_drafts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id        UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  document_id      UUID REFERENCES documents(id) ON DELETE SET NULL,
  extracted_data   JSONB NOT NULL,   -- {name, qualifications:[...], experience:[...]}
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at      TIMESTAMPTZ,
  reviewed_by      UUID REFERENCES people(id)
);

CREATE INDEX cv_drafts_person_idx ON cv_import_drafts (organization_id, person_id, status);

-- ---------------------------------------------------------------------
-- Task / duty log entries. Timestamps are server-stamped, never client-set.
-- ---------------------------------------------------------------------
CREATE TABLE task_entries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id        UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  description      TEXT NOT NULL,           -- "Took Mathematics class, Grade 10"
  start_time       TIMESTAMPTZ NOT NULL,
  end_time         TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER GENERATED ALWAYS AS (
                     GREATEST(0, EXTRACT(EPOCH FROM (end_time - start_time)) / 60)::INTEGER
                   ) STORED,
  logged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- server stamp, immutable
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_time_order CHECK (end_time > start_time)
);

CREATE INDEX task_entries_person_time_idx ON task_entries (organization_id, person_id, start_time);

-- ---------------------------------------------------------------------
-- Pay rules: flexible, layered configuration.
-- A rule can apply org-wide (person_id and role_title both NULL),
-- to every person with a given role_title, or to one specific person.
-- Precedence when computing payroll: person-specific > role-specific > org default.
-- ---------------------------------------------------------------------
CREATE TABLE pay_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope            TEXT NOT NULL CHECK (scope IN ('organization','role','person')),
  role_title       TEXT,                         -- set when scope = 'role'
  person_id        UUID REFERENCES people(id) ON DELETE CASCADE,  -- set when scope = 'person'

  pay_type         TEXT NOT NULL CHECK (pay_type IN ('hourly','salary')),
  base_rate        NUMERIC(12,2) NOT NULL DEFAULT 0,  -- hourly rate OR monthly/annual salary
  salary_period     TEXT CHECK (salary_period IN ('monthly','annual')),  -- only for pay_type='salary'

  overtime_enabled       BOOLEAN NOT NULL DEFAULT false,
  overtime_threshold_hrs NUMERIC(6,2) DEFAULT 40,     -- weekly hours before overtime kicks in
  overtime_multiplier    NUMERIC(4,2) DEFAULT 1.5,

  bonus_rules      JSONB NOT NULL DEFAULT '[]',
  -- e.g. [{"type":"flat","amount":100,"condition":"monthly"},
  --       {"type":"per_hour_over","threshold":160,"amount":5}]

  effective_from   DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to     DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pay_rule_scope_shape CHECK (
    (scope = 'organization' AND role_title IS NULL AND person_id IS NULL) OR
    (scope = 'role' AND role_title IS NOT NULL AND person_id IS NULL) OR
    (scope = 'person' AND person_id IS NOT NULL)
  )
);

CREATE INDEX pay_rules_org_idx    ON pay_rules (organization_id, scope);
CREATE INDEX pay_rules_person_idx ON pay_rules (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX pay_rules_role_idx   ON pay_rules (organization_id, role_title) WHERE role_title IS NOT NULL;

-- ---------------------------------------------------------------------
-- Payroll runs: cached/computed results per person per period, so the
-- UI doesn't recompute from scratch and there's an auditable record.
-- ---------------------------------------------------------------------
CREATE TABLE payroll_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id        UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  regular_hours    NUMERIC(8,2) NOT NULL DEFAULT 0,
  overtime_hours   NUMERIC(8,2) NOT NULL DEFAULT 0,
  base_pay         NUMERIC(12,2) NOT NULL DEFAULT 0,
  overtime_pay     NUMERIC(12,2) NOT NULL DEFAULT 0,
  bonus_pay        NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_pay        NUMERIC(12,2) GENERATED ALWAYS AS (base_pay + overtime_pay + bonus_pay) STORED,
  pay_rule_id      UUID REFERENCES pay_rules(id),
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, person_id, period_start, period_end)
);

CREATE INDEX payroll_runs_person_idx ON payroll_runs (organization_id, person_id, period_start);

-- =====================================================================
-- Row Level Security — belt-and-braces multi-tenant isolation.
-- The app sets `app.current_org_id` (and `app.current_person_path` for
-- subtree checks) via SET LOCAL at the start of each transaction.
-- Even a buggy or injected query cannot cross tenant boundaries.
-- =====================================================================

ALTER TABLE people             ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cv_import_drafts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_entries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_rules          ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs       ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_people ON people
  USING (organization_id = current_setting('app.current_org_id', true)::UUID);

CREATE POLICY tenant_isolation_profiles ON profiles
  USING (organization_id = current_setting('app.current_org_id', true)::UUID);

CREATE POLICY tenant_isolation_documents ON documents
  USING (organization_id = current_setting('app.current_org_id', true)::UUID);

CREATE POLICY tenant_isolation_cv_drafts ON cv_import_drafts
  USING (organization_id = current_setting('app.current_org_id', true)::UUID);

CREATE POLICY tenant_isolation_tasks ON task_entries
  USING (organization_id = current_setting('app.current_org_id', true)::UUID);

CREATE POLICY tenant_isolation_pay_rules ON pay_rules
  USING (organization_id = current_setting('app.current_org_id', true)::UUID);

CREATE POLICY tenant_isolation_payroll ON payroll_runs
  USING (organization_id = current_setting('app.current_org_id', true)::UUID);

-- NOTE: RLS here guards tenant boundaries. Subtree (hierarchy) visibility
-- is enforced in the application query layer using `path <@ :requester_path`
-- (see src/utils/permissions.js) because it depends on *which* person is
-- asking, not just which org — a cheap, explicit WHERE clause is clearer
-- and easier to unit test than folding it into RLS policies.
