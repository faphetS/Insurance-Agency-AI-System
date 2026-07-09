BEGIN;

-- 1. Fresh start for everyone (owner-approved; DB data is test-only).
--    MUST run before the CHECK swap so no row holds a removed slot name.
UPDATE public.clients
   SET intake_state = 'collecting',
       intake_current_slot = 'welcome',
       intake_completed_at = NULL;

-- 2. v4 slot machine
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_intake_current_slot_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_intake_current_slot_check
  CHECK (intake_current_slot IN ('welcome','menu','meeting_type','consent','id_photo','done'));

-- 3. inquiry_type gains callback/meeting. VERIFY the real constraint name + value list
--    against db/schema.sql AND live pg_constraint first:
--    SELECT conname FROM pg_constraint WHERE conrelid='public.clients'::regclass AND conname ILIKE '%inquiry%';
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_inquiry_type_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_inquiry_type_check
  CHECK (inquiry_type IN (
    'life','health','property','vehicle','liability','business','pension','travel','mortgage','general',
    'home','life_health_pension','finance','other',
    'callback','meeting'));

-- 4. Stall-watcher columns
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS consent_prompted_at timestamptz,
  ADD COLUMN IF NOT EXISTS stall_notified_at  timestamptz;

-- 5. Unpause everything (fresh start)
UPDATE public.conversations SET bot_paused = false, bot_paused_until = NULL;

COMMIT;
