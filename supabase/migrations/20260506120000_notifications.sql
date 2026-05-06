-- ============================================================
-- Migration: notifications
-- Description: Add notifications table for system alerts and
--              activity notifications with RLS enabled.
-- ============================================================

CREATE TABLE notifications (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text        NOT NULL,
  title         text        NOT NULL,
  message       text        NOT NULL,
  severity      text        NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'urgent')),
  client_id     uuid        REFERENCES clients(id) ON DELETE SET NULL,
  meeting_id    uuid        REFERENCES meetings(id) ON DELETE SET NULL,
  task_id       uuid        REFERENCES tasks(id) ON DELETE SET NULL,
  reference_key text,
  is_read       boolean     NOT NULL DEFAULT false,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_notifications_reference_key ON notifications (reference_key) WHERE reference_key IS NOT NULL;
CREATE INDEX idx_notifications_created_at ON notifications (created_at DESC);
CREATE INDEX idx_notifications_is_read ON notifications (is_read) WHERE is_read = false;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
