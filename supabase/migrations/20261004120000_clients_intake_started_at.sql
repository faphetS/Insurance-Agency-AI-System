-- Start of the lead's current intake run: stamped on client creation and on every
-- post-cooldown restart. The CRM-sheet mirror appends a NEW row when the lead's
-- newest sheet row predates it (one row per inquiry). NULL = pre-migration client;
-- code falls back to created_at.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS intake_started_at timestamptz;
