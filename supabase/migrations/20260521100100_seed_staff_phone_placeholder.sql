-- ============================================================
-- Migration: seed_staff_phone_placeholder
-- Description: Sets a placeholder phone on every staff row so
--              the WhatsApp notification service can run in test
--              mode without crashing on NULL phone values.
--
-- IMPORTANT — PLACEHOLDER VALUE:
--   Replace <<TEST_PHONE_DIGITS>> with the real test number
--   (digits only, with country code, no "+", e.g. 9725XXXXXXXX)
--   before applying this migration to any live or staging DB.
--
--   The literal string "<<TEST_PHONE_DIGITS>>" is a deliberate
--   safe no-op: the app strips non-digits, producing an empty
--   string which the send logic skips entirely, so no WhatsApp
--   message will be dispatched even if applied as-is.
-- ============================================================

UPDATE public.staff
SET phone      = '09219909210',
    updated_at = now();
