-- Migration: client_intake_state
-- Adds intake workflow columns to the clients table

alter table public.clients
  add column intake_state text not null default 'collecting'
    check (intake_state in ('collecting','completed','skipped')),
  add column intake_current_slot text
    check (intake_current_slot in
      ('full_name','email','inquiry_type','id_photo','poa','done')),
  add column intake_completed_at timestamptz;

-- Backfilled rows should be treated as done so the bot doesn't re-ask them
update public.clients
set intake_state = 'completed',
    intake_current_slot = 'done',
    intake_completed_at = now()
where intake_state = 'collecting';

-- Fresh leads start at the first question
alter table public.clients
  alter column intake_current_slot set default 'full_name';
