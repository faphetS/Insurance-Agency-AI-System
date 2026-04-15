-- ============================================================
-- Migration: admin_rls_lockdown
-- Description: Replace V1 open anon/authenticated policies with
--              admin-only policies that check app_metadata.role.
--
-- SECURITY MODEL:
--   - anon role: no access (all open anon policies dropped)
--   - authenticated role: access only when JWT contains
--       app_metadata.role = 'admin'
--   - service_role: always bypasses RLS — used by the Express
--     server (supabaseAdmin client) for webhook writes and all
--     server-side operations. These policies do NOT affect it.
--
-- HOW IT WORKS:
--   Supabase Auth embeds app_metadata into the JWT on sign-in.
--   app_metadata is set exclusively by admin (service_role) and
--   cannot be modified by the user themselves — safe for authz.
--   The check `auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'`
--   reads from the signed JWT, so it cannot be spoofed by the
--   browser client.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- CONVERSATIONS
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_authenticated select conversations" ON conversations;
DROP POLICY IF EXISTS "anon_authenticated update conversations" ON conversations;

CREATE POLICY "admin select conversations"
  ON conversations
  FOR SELECT
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

CREATE POLICY "admin update conversations"
  ON conversations
  FOR UPDATE
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  )
  WITH CHECK (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

-- ────────────────────────────────────────────────────────────
-- MESSAGES
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_authenticated select messages" ON messages;

CREATE POLICY "admin select messages"
  ON messages
  FOR SELECT
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

-- ────────────────────────────────────────────────────────────
-- BOT_SETTINGS
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_authenticated select bot_settings" ON bot_settings;
DROP POLICY IF EXISTS "anon_authenticated update bot_settings" ON bot_settings;

CREATE POLICY "admin select bot_settings"
  ON bot_settings
  FOR SELECT
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

CREATE POLICY "admin update bot_settings"
  ON bot_settings
  FOR UPDATE
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  )
  WITH CHECK (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

CREATE POLICY "admin insert bot_settings"
  ON bot_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

-- ────────────────────────────────────────────────────────────
-- CLIENTS
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_authenticated select clients" ON clients;
DROP POLICY IF EXISTS "anon_authenticated update clients" ON clients;

CREATE POLICY "admin select clients"
  ON clients
  FOR SELECT
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

CREATE POLICY "admin update clients"
  ON clients
  FOR UPDATE
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  )
  WITH CHECK (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

CREATE POLICY "admin insert clients"
  ON clients
  FOR INSERT
  TO authenticated
  WITH CHECK (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

-- ────────────────────────────────────────────────────────────
-- STAFF
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_authenticated select staff" ON staff;

CREATE POLICY "admin select staff"
  ON staff
  FOR SELECT
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

-- ────────────────────────────────────────────────────────────
-- MEETINGS
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_authenticated select meetings" ON meetings;

CREATE POLICY "admin select meetings"
  ON meetings
  FOR SELECT
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

-- ────────────────────────────────────────────────────────────
-- TASKS
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_authenticated select tasks" ON tasks;

CREATE POLICY "admin select tasks"
  ON tasks
  FOR SELECT
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

-- ────────────────────────────────────────────────────────────
-- DOCUMENTS
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_authenticated select documents" ON documents;

CREATE POLICY "admin select documents"
  ON documents
  FOR SELECT
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

-- ────────────────────────────────────────────────────────────
-- AUDIT_LOGS
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_authenticated select audit_logs" ON audit_logs;

CREATE POLICY "admin select audit_logs"
  ON audit_logs
  FOR SELECT
  TO authenticated
  USING (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );
