-- ============================================================
-- Migration: bafi_forms_collection
-- Description: Create bafi_forms, bafi_life_collection, and
--              bafi_elementary_collection tables mirroring
--              BAFI's טפסים, גבייה חיים, and גביה אלמנטרי tabs.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. BAFI_FORMS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bafi_forms (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  catalog_number        text,
  form_date             date,
  form_type             text
    CHECK (form_type IN ('תביעות', 'הצעות', 'הצטרפות', 'אחר')),
  domain                text
    CHECK (domain IN ('בריאות', 'חיים', 'נסיעות', 'רכב', 'אחר', 'פיננסים')),
  branch                text
    CHECK (branch IN ('סיכונים', 'רכוש', 'חיסכון')),
  insurance_company_id  uuid        REFERENCES insurance_companies(id) ON DELETE SET NULL,
  pages                 int,
  form_name             text,
  status                text        NOT NULL DEFAULT 'completed'
    CHECK (status IN ('sent', 'in_progress', 'completed')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bafi_forms_client_date
  ON bafi_forms (client_id, form_date DESC);

-- ────────────────────────────────────────────────────────────
-- 2. BAFI_LIFE_COLLECTION
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bafi_life_collection (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  policy_id             uuid        REFERENCES policies(id) ON DELETE SET NULL,
  employer_id           uuid        REFERENCES employers(id) ON DELETE SET NULL,
  policy_number         text,
  report_type           text,
  product_type          text,
  premium_month         date,
  -- Employer premium breakdown
  salary                numeric(12, 2),
  severance_pay         numeric(12, 2),
  benefits              numeric(12, 2),
  disability            numeric(12, 2),
  employer_misc         numeric(12, 2),
  employer_total        numeric(12, 2),
  -- Employee premium breakdown
  benefit_45            numeric(12, 2),
  benefit_47            numeric(12, 2),
  employee_disability   numeric(12, 2),
  employee_misc         numeric(12, 2),
  employee_total        numeric(12, 2),
  -- Summary
  total_pct             numeric(6, 4),
  total_to_pay          numeric(12, 2),
  -- Last deposit details
  last_deposit_date     date,
  last_deposit_amount   numeric(12, 2),
  last_deposit_notes    text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bafi_life_collection_client_deposit
  ON bafi_life_collection (client_id, last_deposit_date);

CREATE INDEX IF NOT EXISTS idx_bafi_life_collection_policy
  ON bafi_life_collection (policy_id);

-- ────────────────────────────────────────────────────────────
-- 3. BAFI_ELEMENTARY_COLLECTION
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bafi_elementary_collection (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  policy_id             uuid        REFERENCES policies(id) ON DELETE SET NULL,
  payment_date          date,
  doc_number            text,
  bafi_agent_id         uuid        REFERENCES bafi_agents(id) ON DELETE SET NULL,
  agent_number          text,
  insurance_company_id  uuid        REFERENCES insurance_companies(id) ON DELETE SET NULL,
  debit                 numeric(12, 2),
  credit                numeric(12, 2),
  balance               numeric(12, 2),
  payment_type          text,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bafi_elementary_client_payment
  ON bafi_elementary_collection (client_id, payment_date);

-- ────────────────────────────────────────────────────────────
-- 4. ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────
ALTER TABLE bafi_forms                ENABLE ROW LEVEL SECURITY;
ALTER TABLE bafi_life_collection      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bafi_elementary_collection ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin select bafi_forms"
  ON bafi_forms FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert bafi_forms"
  ON bafi_forms FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update bafi_forms"
  ON bafi_forms FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin select bafi_life_collection"
  ON bafi_life_collection FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert bafi_life_collection"
  ON bafi_life_collection FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update bafi_life_collection"
  ON bafi_life_collection FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin select bafi_elementary_collection"
  ON bafi_elementary_collection FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert bafi_elementary_collection"
  ON bafi_elementary_collection FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update bafi_elementary_collection"
  ON bafi_elementary_collection FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');
