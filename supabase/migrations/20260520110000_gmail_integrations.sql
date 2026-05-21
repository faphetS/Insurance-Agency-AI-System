-- ============================================================
-- Migration: gmail_integrations
-- Description: Store per-staff Google OAuth tokens and sync
--              state for the Gmail polling integration.
-- ============================================================

CREATE TABLE IF NOT EXISTS gmail_integrations (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id                uuid        NOT NULL UNIQUE REFERENCES staff(id) ON DELETE CASCADE,
  email                   text        NOT NULL,
  refresh_token           text        NOT NULL,
  access_token            text,
  access_token_expires_at timestamptz,
  scope                   text        NOT NULL,
  connected_at            timestamptz NOT NULL DEFAULT now(),
  last_synced_at          timestamptz,
  last_unread_count       integer     DEFAULT 0,
  last_error              text,
  is_active               boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gmail_integrations_active_synced
  ON gmail_integrations (is_active, last_synced_at);

-- ────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────
ALTER TABLE gmail_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin select gmail_integrations"
  ON gmail_integrations FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert gmail_integrations"
  ON gmail_integrations FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update gmail_integrations"
  ON gmail_integrations FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin delete gmail_integrations"
  ON gmail_integrations FOR DELETE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');
