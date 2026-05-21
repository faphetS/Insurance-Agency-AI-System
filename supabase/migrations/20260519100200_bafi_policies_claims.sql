-- ============================================================
-- Migration: bafi_policies_claims
-- Description: Create policies and claims tables mirroring
--              BAFI's פוליסות ותוכניות and תביעות tabs.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. POLICIES
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policies (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  policy_number         text        NOT NULL UNIQUE,
  policy_type           text        NOT NULL
    CHECK (policy_type IN ('חיים', 'שוק הון', 'פנסיה', 'סיעודי', 'משכנתא', 'אלמנטרי', 'ביטוח אישי')),
  insurance_company_id  uuid        REFERENCES insurance_companies(id) ON DELETE SET NULL,
  start_date            date,
  end_date              date,
  status                text        NOT NULL DEFAULT 'פעיל'
    CHECK (status IN ('פעיל', 'לא פעיל', 'ממתין')),
  product_number        text,
  product_name          text,
  opening_amount        numeric(15, 2),
  plan_name             text,
  fund_status           text,
  fund_balance          numeric(15, 2),
  fund_track            text,
  balance_as_of         date,
  managed_by            uuid        REFERENCES staff(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policies_client_status
  ON policies (client_id, status);

CREATE INDEX IF NOT EXISTS idx_policies_insurance_company
  ON policies (insurance_company_id);

-- ────────────────────────────────────────────────────────────
-- 2. CLAIMS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS claims (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  policy_id     uuid        REFERENCES policies(id) ON DELETE SET NULL,
  claim_number  text,
  opened_at     date,
  status        text        NOT NULL DEFAULT 'פתוח'
    CHECK (status IN ('פתוח', 'בטיפול', 'סגור', 'נדחה')),
  claim_type    text,
  amount        numeric(15, 2),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claims_client_status
  ON claims (client_id, status);

CREATE INDEX IF NOT EXISTS idx_claims_policy
  ON claims (policy_id);

-- ────────────────────────────────────────────────────────────
-- 3. ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin select policies"
  ON policies FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert policies"
  ON policies FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update policies"
  ON policies FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin select claims"
  ON claims FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert claims"
  ON claims FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update claims"
  ON claims FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');
