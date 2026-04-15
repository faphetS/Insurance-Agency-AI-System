-- ============================================================
-- Migration: frontend_read_policies
-- Description: Add permissive SELECT (and limited UPDATE) policies
--              for the anon and authenticated roles so the React
--              frontend can read data via the Supabase anon key.
--
-- SECURITY NOTE (V1 — intentionally open):
--   These policies allow any holder of the anon key to read and
--   partially update data. This is acceptable for V1 because there
--   is no frontend login yet and the data is not sensitive in this
--   early stage.
--
--   BEFORE going to production / adding real user auth, tighten
--   these policies:
--     - Remove anon access entirely.
--     - Restrict authenticated access to rows owned by / assigned
--       to the current user (e.g. auth.uid() = staff_id).
--     - Add role-based checks (e.g. only 'admin' can read audit_logs).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- Helper: The six original tables already have RLS enabled.
-- The three new tables (conversations, messages, bot_settings)
-- had RLS enabled in the previous migration but no permissive
-- policies — so every Data API call returned [].
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- CONVERSATIONS — SELECT + UPDATE
-- ────────────────────────────────────────────────────────────
CREATE POLICY "anon_authenticated select conversations"
  ON conversations
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "anon_authenticated update conversations"
  ON conversations
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ────────────────────────────────────────────────────────────
-- MESSAGES — SELECT only
-- ────────────────────────────────────────────────────────────
CREATE POLICY "anon_authenticated select messages"
  ON messages
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ────────────────────────────────────────────────────────────
-- BOT_SETTINGS — SELECT + UPDATE
-- ────────────────────────────────────────────────────────────
CREATE POLICY "anon_authenticated select bot_settings"
  ON bot_settings
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "anon_authenticated update bot_settings"
  ON bot_settings
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ────────────────────────────────────────────────────────────
-- CLIENTS — SELECT + UPDATE
-- (RLS was already enabled; adding policies that were missing)
-- ────────────────────────────────────────────────────────────
CREATE POLICY "anon_authenticated select clients"
  ON clients
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "anon_authenticated update clients"
  ON clients
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ────────────────────────────────────────────────────────────
-- STAFF — SELECT only
-- ────────────────────────────────────────────────────────────
CREATE POLICY "anon_authenticated select staff"
  ON staff
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ────────────────────────────────────────────────────────────
-- MEETINGS — SELECT only
-- ────────────────────────────────────────────────────────────
CREATE POLICY "anon_authenticated select meetings"
  ON meetings
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ────────────────────────────────────────────────────────────
-- TASKS — SELECT only
-- ────────────────────────────────────────────────────────────
CREATE POLICY "anon_authenticated select tasks"
  ON tasks
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ────────────────────────────────────────────────────────────
-- DOCUMENTS — SELECT only
-- ────────────────────────────────────────────────────────────
CREATE POLICY "anon_authenticated select documents"
  ON documents
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ────────────────────────────────────────────────────────────
-- AUDIT_LOGS — SELECT only
-- ────────────────────────────────────────────────────────────
CREATE POLICY "anon_authenticated select audit_logs"
  ON audit_logs
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ────────────────────────────────────────────────────────────
-- v_client_pipeline VIEW
--
-- Views don't have RLS; they inherit it from underlying tables.
-- Making clients, meetings, and tasks readable above is sufficient
-- to unblock SELECT on this view for anon/authenticated callers.
--
-- The view was created WITHOUT security_invoker (default), so it
-- runs as the calling role. Now that those roles have SELECT on
-- the underlying tables, the view will return rows correctly.
-- ────────────────────────────────────────────────────────────
-- (no additional SQL needed for the view itself)
