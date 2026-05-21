-- ============================================================
-- Migration: whatsapp_instances
-- Description: Track GreenAPI WhatsApp lines (bot + staff).
--              Seed 4 placeholder rows for the BAFI setup.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_instances (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label                 text        NOT NULL,
  phone_number          text,
  role                  text        NOT NULL CHECK (role IN ('bot', 'staff')),
  staff_id              uuid        REFERENCES staff(id) ON DELETE SET NULL,
  green_api_instance_id text,
  green_api_token       text,
  green_api_url         text,
  is_active             boolean     NOT NULL DEFAULT true,
  is_connected          boolean     GENERATED ALWAYS AS (
                          green_api_instance_id IS NOT NULL AND green_api_token IS NOT NULL
                        ) STORED,
  last_synced_at        timestamptz,
  last_unanswered_count integer     DEFAULT 0,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_active_role
  ON whatsapp_instances (is_active, role);

-- ────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────
ALTER TABLE whatsapp_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin select whatsapp_instances"
  ON whatsapp_instances FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert whatsapp_instances"
  ON whatsapp_instances FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update whatsapp_instances"
  ON whatsapp_instances FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin delete whatsapp_instances"
  ON whatsapp_instances FOR DELETE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

-- ────────────────────────────────────────────────────────────
-- SEED: 4 placeholder rows
-- Idempotent — skips rows whose label already exists.
-- ────────────────────────────────────────────────────────────
INSERT INTO whatsapp_instances (label, phone_number, role, staff_id,
  green_api_instance_id, green_api_token, green_api_url)
SELECT label, phone_number, role, staff_id,
       green_api_instance_id, green_api_token, green_api_url
FROM (VALUES
  ('Main bot line',      NULL, 'bot',   NULL::uuid,
   NULL, NULL, NULL),
  ('Didi''s WhatsApp',   NULL, 'staff', 'baf10001-0000-0000-0000-000000000001'::uuid,
   NULL, NULL, NULL),
  ('Yafa''s WhatsApp',   NULL, 'staff', 'baf10001-0000-0000-0000-000000000002'::uuid,
   NULL, NULL, NULL),
  ('Tzivia''s WhatsApp', NULL, 'staff', 'baf10001-0000-0000-0000-000000000003'::uuid,
   NULL, NULL, NULL)
) AS v(label, phone_number, role, staff_id,
       green_api_instance_id, green_api_token, green_api_url)
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_instances w WHERE w.label = v.label
);
