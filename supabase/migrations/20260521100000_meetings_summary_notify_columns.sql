-- ============================================================
-- Migration: meetings_summary_notify_columns
-- Description: Add two nullable columns to the meetings table
--              to support the post-meeting WhatsApp summary
--              notification flow (service-role only).
--
--   staff_summary_notified_at — idempotency stamp; set once the
--     staff WhatsApp summary message has been sent, preventing
--     duplicate sends on repeated job runs.
--
--   summary_edit_chat_id — WhatsApp chat ID of the staff member
--     currently being asked to send an edited/confirmed summary;
--     cleared once their reply is received.
--
-- No index or RLS change required — access is service-role only.
-- ============================================================

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS staff_summary_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS summary_edit_chat_id      text;
