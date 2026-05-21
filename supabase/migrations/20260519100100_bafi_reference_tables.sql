-- ============================================================
-- Migration: bafi_reference_tables
-- Description: Create BAFI reference / lookup tables:
--              insurance_companies, employers, bafi_agents, contacts
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. INSURANCE_COMPANIES
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insurance_companies (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  short_code  text,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────
-- 2. EMPLOYERS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employers (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  tax_id        text,
  address       text,
  contact_phone text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────
-- 3. BAFI_AGENTS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bafi_agents (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_name   text,
  full_name     text        NOT NULL,
  agent_number  text,
  phone         text,
  email         text,
  address       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────
-- 4. CONTACTS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  full_name   text        NOT NULL,
  relation    text,
  phone       text,
  email       text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_client_id
  ON contacts (client_id);

-- ────────────────────────────────────────────────────────────
-- 5. ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────
ALTER TABLE insurance_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE employers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE bafi_agents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts            ENABLE ROW LEVEL SECURITY;

-- Admin-only policies (matches existing pattern from admin_rls_lockdown)
CREATE POLICY "admin select insurance_companies"
  ON insurance_companies FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert insurance_companies"
  ON insurance_companies FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update insurance_companies"
  ON insurance_companies FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin select employers"
  ON employers FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert employers"
  ON employers FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update employers"
  ON employers FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin select bafi_agents"
  ON bafi_agents FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert bafi_agents"
  ON bafi_agents FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update bafi_agents"
  ON bafi_agents FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin select contacts"
  ON contacts FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert contacts"
  ON contacts FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update contacts"
  ON contacts FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');
