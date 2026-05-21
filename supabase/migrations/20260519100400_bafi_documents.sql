-- ============================================================
-- Migration: bafi_documents
-- Description: Create bafi_documents table for client document
--              storage metadata. Prefixed to avoid clash with
--              the existing operational `documents` table.
-- ============================================================

CREATE TABLE IF NOT EXISTS bafi_documents (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  policy_id      uuid        REFERENCES policies(id) ON DELETE SET NULL,
  document_type  text,
  file_name      text        NOT NULL,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  uploaded_by    uuid        REFERENCES staff(id) ON DELETE SET NULL,
  storage_path   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bafi_documents_client
  ON bafi_documents (client_id);

CREATE INDEX IF NOT EXISTS idx_bafi_documents_policy
  ON bafi_documents (policy_id);

-- ────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────
ALTER TABLE bafi_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin select bafi_documents"
  ON bafi_documents FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert bafi_documents"
  ON bafi_documents FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update bafi_documents"
  ON bafi_documents FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');
