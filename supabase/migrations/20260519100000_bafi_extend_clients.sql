-- ============================================================
-- Migration: bafi_extend_clients
-- Description: Add BAFI client-card fields to the existing
--              clients table. All new columns are nullable so
--              existing rows are unaffected.
-- ============================================================

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS bafi_file_number      text UNIQUE,
  ADD COLUMN IF NOT EXISTS id_number             text,
  ADD COLUMN IF NOT EXISTS date_of_birth         date,
  ADD COLUMN IF NOT EXISTS gender                text
    CHECK (gender IN ('male', 'female')),
  ADD COLUMN IF NOT EXISTS id_issue_date         date,
  ADD COLUMN IF NOT EXISTS passport_number       text,
  ADD COLUMN IF NOT EXISTS health_fund           text,
  ADD COLUMN IF NOT EXISTS poa_signed            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS client_type           text
    CHECK (client_type IN ('individual', 'company', 'employer')),
  ADD COLUMN IF NOT EXISTS agency_group          text,
  ADD COLUMN IF NOT EXISTS assigned_handler_id   uuid REFERENCES staff(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS address               text,
  ADD COLUMN IF NOT EXISTS workplace             text,
  ADD COLUMN IF NOT EXISTS referring_party       text;

CREATE INDEX IF NOT EXISTS idx_clients_bafi_file_number
  ON clients (bafi_file_number);

CREATE INDEX IF NOT EXISTS idx_clients_assigned_handler
  ON clients (assigned_handler_id);
