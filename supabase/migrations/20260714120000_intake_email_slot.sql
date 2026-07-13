-- Intake v4.1: add the 'email' slot (between meeting_type and consent) +
-- booking-sync re-enable hardening. Applied manually to the VPS DB before deploy.
BEGIN;

-- 1. Widen the slot CHECK — purely additive, existing values all stay valid.
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_intake_current_slot_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_intake_current_slot_check
  CHECK (intake_current_slot IN (
    'welcome', 'menu', 'meeting_type', 'email', 'consent', 'id_photo', 'done'
  ));

-- 2. Hard dedupe: at most one meetings row per Google Calendar event, so the
--    booking thank-you can never double-send even if two sync runs race past
--    the SELECT-then-skip check. Partial: legacy NULL rows unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS meetings_calendar_event_id_uidx
  ON public.meetings (calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;

COMMIT;
