-- ============================================================
-- Insurance Agency AI System — Consolidated Plain-Postgres Schema
-- Target: PostgreSQL 16 / 17 (no Supabase-specific features)
--
-- No RLS, no policies, no auth schema, no GRANTs to
-- anon/authenticated/service_role roles.
--
-- Source of truth: supabase/migrations/ (30 files).
-- BAFI migrations excluded entirely (see comment below).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. STAFF
--    Original: staff.id was FK to auth.users(id).
--    Plain-Postgres: standalone UUID PK with gen_random_uuid().
--    All FKs that point to staff(id) are preserved as-is.
-- ============================================================
CREATE TABLE public.staff (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text        NOT NULL,
  email       text        NOT NULL,
  phone       text,
  role        text        NOT NULL DEFAULT 'agent'
              CHECK (role IN ('owner', 'admin', 'agent')),
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. CLIENTS
--    Core columns from initial schema +
--    pipeline_stage          (20260415094240)
--    intake_state/slot/at    (20260415160457 + 20260429120000)
--    assigned_handler_id     (20260519100000 — KEPT per spec)
--    complexity              (20260531120000)
--
--    EXCLUDED BAFI columns (from 20260519100000_bafi_extend_clients):
--      bafi_file_number, id_number, date_of_birth, gender,
--      id_issue_date, passport_number, health_fund, poa_signed,
--      client_type, agency_group, address, workplace,
--      referring_party
-- ============================================================
CREATE TABLE public.clients (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name            text        NOT NULL,
  phone                text        NOT NULL,
  email                text,
  id_photo_url         text,
  id_validated         boolean     NOT NULL DEFAULT false,
  poa_doc_url          text,
  inquiry_type         text        NOT NULL
                       CHECK (inquiry_type IN (
                         -- legacy free-text classification keys (kept for old rows)
                         'life', 'health', 'property', 'vehicle',
                         'liability', 'business', 'pension', 'travel',
                         'mortgage', 'general',
                         -- new fixed button set (2026-06-26)
                         'home', 'life_health_pension', 'finance', 'other',
                         -- v4 menu routes (2026-07-09): button 8 callback, button 9 meeting
                         'callback', 'meeting'
                       )),
  status               text        NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new', 'active', 'completed')),
  assigned_to          uuid        NOT NULL REFERENCES public.staff(id),
  source_channel       text        NOT NULL
                       CHECK (source_channel IN ('wa', 'email')),
  last_service_date    date,
  last_service_reminder_at date,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Added by 20260415094240_messaging_and_pipeline
  pipeline_stage       text
                       CHECK (pipeline_stage IN (
                         'new_lead', 'docs_pending', 'meeting_scheduling',
                         'meeting_scheduled', 'awaiting_approval', 'forms',
                         'receipt', 'policy', 'deposit', 'completed'
                       )),

  -- Added by 20260415160457_client_intake_state
  -- Default amended to 'welcome' by 20260429120000_intake_welcome_slot
  intake_state         text        NOT NULL DEFAULT 'collecting'
                       CHECK (intake_state IN ('collecting', 'completed', 'skipped')),
  -- Slot list replaced by 20260709120000_intake_v4 (v4 9-button menu flow);
  -- 'email' slot added by 20260714120000_intake_email_slot (v4.1)
  intake_current_slot  text        DEFAULT 'welcome'
                       CHECK (intake_current_slot IN (
                         'welcome', 'menu', 'meeting_type', 'email', 'consent', 'id_photo', 'done'
                       )),
  intake_completed_at  timestamptz,
  mirrored_to_sheet_at timestamptz,                                    -- set once when the lead has been appended to the Google leads sheet (idempotency)

  -- Added by 20260709120000_intake_v4 — stall watcher for the consent/id_photo steps.
  -- consent_prompted_at set when the consent prompt is sent; stall_notified_at set
  -- after the 3h stall alert to Didi is attempted (at-most-once flag).
  consent_prompted_at  timestamptz,
  stall_notified_at    timestamptz,

  -- Added by 20260519100000_bafi_extend_clients — KEPT (staff routing)
  assigned_handler_id  uuid        REFERENCES public.staff(id) ON DELETE SET NULL,

  -- Added by 20260531120000_clients_complexity
  complexity           text,

  -- Added for email milestone matching: persisted when the LLM extracts a
  -- policy number from a milestone email with definitive/strong confidence.
  -- Allows subsequent scans to short-circuit by policy # instead of name.
  policy_number        text,

  -- Israeli national ID (תעודת זהות), auto-captured by OCR during intake.
  -- Enables definitive email-to-client matching without relying on name alone.
  id_number            text,

  -- New/Old client choice from the first intake button step; routes the lead
  -- to the matching Google Sheets tab (new → לידים חדשים, old → לקוח קיים).
  client_type          text        CHECK (client_type IN ('new', 'old')),

  -- Free-text issue description collected from existing clients before the
  -- representative/meeting choice. Stored in column I of the לקוח קיים sheet.
  issue_description    text
);

-- ============================================================
-- 3. MEETINGS
--    Core columns from initial schema +
--    conversation_id         (20260429140000)
--    type CHECK extended to include 'google_meet' (20260505120000)
--    timeless_meeting_id     (20260521090000)
--    staff_summary_notified_at, summary_edit_chat_id (20260521100000)
-- ============================================================
CREATE TABLE public.meetings (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                  uuid        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  type                       text        NOT NULL
                             CHECK (type IN ('zoom', 'phone', 'in_person', 'google_meet')),
  scheduled_at               timestamptz NOT NULL,
  calendar_event_id          text,
  recording_url              text,
  transcript                 text,
  summary_draft              text,
  summary_final              text,
  summary_status             text        NOT NULL DEFAULT 'draft'
                             CHECK (summary_status IN ('draft', 'approved', 'sent')),
  client_confirmed           boolean     NOT NULL DEFAULT false,
  status                     text        NOT NULL DEFAULT 'scheduled'
                             CHECK (status IN ('pending_booking', 'scheduled', 'confirmed', 'done', 'cancelled')),
  reminder_24h_sent          boolean     NOT NULL DEFAULT false,
  reminder_1h_sent           boolean     NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  -- Added by 20260429140000_meetings_conversation_id
  conversation_id            uuid,       -- FK added after conversations table; see FK below

  -- Added by 20260521090000_timeless_integration
  timeless_meeting_id        text        UNIQUE,

  -- Added by 20260521100000_meetings_summary_notify_columns
  staff_summary_notified_at  timestamptz,
  summary_edit_chat_id       text,

  -- Added by post-meeting-summary pipeline (staff-picker + client email)
  staff_picker_sent_at       timestamptz,
  client_summary_emailed_at  timestamptz
);

-- ============================================================
-- 4. DOCUMENTS
-- ============================================================
CREATE TABLE public.documents (
  id           uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid  NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  meeting_id   uuid  REFERENCES public.meetings(id) ON DELETE SET NULL,
  type         text  NOT NULL
               CHECK (type IN (
                 'id_photo', 'poa', 'policy', 'receipt',
                 'recording', 'form', 'other'
               )),
  file_url     text  NOT NULL,
  file_name    text,
  mime_type    text,
  uploaded_by  uuid  REFERENCES public.staff(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 5. AUDIT_LOGS
-- ============================================================
CREATE TABLE public.audit_logs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Principal identifier from the request (static "admin", or null for
  -- unauthenticated webhook/cron mutations). Plain text, no FK: the
  -- authenticated principal is not a row in staff.
  user_id      text,
  action       text        NOT NULL,
  status_code  int,
  ip_address   text,
  user_agent   text,
  request_id   text,
  timestamp    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 6. CONVERSATIONS
--    Added by 20260415094240_messaging_and_pipeline.
--    bot_paused_until added by 20260428160000.
-- ============================================================
CREATE TABLE public.conversations (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_chat_id      text        NOT NULL UNIQUE,
  client_id             uuid        REFERENCES public.clients(id) ON DELETE SET NULL,
  contact_name          text,
  contact_phone         text,
  last_message_at       timestamptz NOT NULL DEFAULT now(),
  bot_paused            boolean     NOT NULL DEFAULT false,
  status                text        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'closed')),
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Added by 20260428160000_add_bot_paused_until
  bot_paused_until      timestamptz,

  -- Added for CLIX gateway: tags the connected WhatsApp line that received the message
  whatsapp_instance_id  uuid        REFERENCES public.whatsapp_instances(id),

  -- Added by 20260714130000_add_conversations_channel: transport that received inbound
  channel               text        CHECK (channel IN ('greenapi', 'meta')),

  -- Added by 20260715090000_add_chatwoot_columns: Chatwoot mirror id cache
  chatwoot_contact_id       bigint,
  chatwoot_conversation_id  bigint
);

-- ============================================================
-- 7. MESSAGES
--    Added by 20260415094240_messaging_and_pipeline.
-- ============================================================
CREATE TABLE public.messages (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  direction            text        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body                 text,
  message_type         text        NOT NULL DEFAULT 'text'
                       CHECK (message_type IN ('text', 'image', 'audio', 'document')),
  whatsapp_message_id  text,
  sent_by              text        NOT NULL CHECK (sent_by IN ('bot', 'human', 'customer')),
  status               text        NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received', 'sent', 'delivered', 'read', 'failed')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 8. BOT_SETTINGS  (singleton row — id must always equal 1)
--    Added by 20260415094240_messaging_and_pipeline.
-- ============================================================
CREATE TABLE public.bot_settings (
  id            int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  system_prompt text        NOT NULL DEFAULT 'You are a friendly helpful assistant replying to WhatsApp messages. Keep replies concise and natural.',
  model_name    text        NOT NULL DEFAULT 'gemma-4-26b-a4b-it',
  enabled       boolean     NOT NULL DEFAULT true,
  auto_reply    boolean     NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 9. SYSTEM_SETTINGS
--     Added by 20260429150000_system_settings.
-- ============================================================
CREATE TABLE public.system_settings (
  key        text        PRIMARY KEY,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 11. WHATSAPP_INSTANCES
--     Added by 20260520110100_whatsapp_instances.
--     is_connected is a GENERATED ALWAYS AS ... STORED column —
--     standard SQL:2003 feature, supported in Postgres 12+.
--     Expression: non-NULL instance_id AND non-NULL token.
-- ============================================================
CREATE TABLE public.whatsapp_instances (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label                 text        NOT NULL,
  phone_number          text,
  role                  text        NOT NULL CHECK (role IN ('bot', 'staff')),
  staff_id              uuid        REFERENCES public.staff(id) ON DELETE SET NULL,
  green_api_instance_id text,
  green_api_token       text,
  green_api_url         text,
  -- Added for CLIX gateway: identifies the connected line by CLIX customerId
  gateway_customer_id   text        UNIQUE,
  -- 'conversational' = customer-facing bot; 'operational' = staff scan/monitoring line
  purpose               text        NOT NULL DEFAULT 'conversational'
                        CHECK (purpose IN ('conversational', 'operational')),
  is_active             boolean     NOT NULL DEFAULT true,
  is_connected          boolean     GENERATED ALWAYS AS (
                          green_api_instance_id IS NOT NULL
                          AND green_api_token IS NOT NULL
                        ) STORED,
  last_synced_at        timestamptz,
  last_unanswered_count integer     DEFAULT 0,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 12. TIMELESS_UNMATCHED_MEETINGS
--     Added by 20260521090000_timeless_integration.
--     candidate_meeting_ids is a uuid[] array column.
-- ============================================================
CREATE TABLE public.timeless_unmatched_meetings (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  timeless_meeting_id    text        UNIQUE NOT NULL,
  start_time             timestamptz NOT NULL,
  participants           jsonb       NOT NULL,
  host_email             text,
  candidate_meeting_ids  uuid[]      DEFAULT '{}',
  reason                 text        NOT NULL
                         CHECK (reason IN ('no_candidates', 'low_score', 'ambiguous')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz,
  resolved_to_meeting_id uuid        REFERENCES public.meetings(id) ON DELETE SET NULL
);

-- ============================================================
-- 13. COMMITMENTS
--     Tracks outgoing/incoming commitments extracted from WhatsApp
--     self-chat scans. fire_at drives the scheduled reminder job;
--     source_message_id enables idempotent dedup per GreenAPI message.
-- ============================================================
CREATE TABLE public.commitments (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id           text        NOT NULL,
  contact_name      text,
  direction         text        NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  source_message_id text,
  source_text       text        NOT NULL,
  commitment_text   text        NOT NULL,
  counterparty      text,
  due_date          date,
  due_time          time,
  kind              text        NOT NULL CHECK (kind IN ('timed', 'date_only', 'floating')),
  fire_at           timestamptz NOT NULL,
  status            text        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'cancelled')),
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- call_events — WhatsApp call webhooks for the operational bot.
--   One row per call, keyed by id_message (offer + outcome upsert).
--   status: ringing → accepted | declined (we rejected) | missed (caller cancelled).
--   Read for the daily 08:00 missed/declined reminder; pruned on a rolling window.
-- ============================================================
CREATE TABLE public.call_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  id_instance       text,
  id_message        text        UNIQUE,
  direction         text        NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  counterpart_phone text,
  status            text        NOT NULL CHECK (status IN ('ringing', 'accepted', 'declined', 'missed')),
  is_video          boolean     NOT NULL DEFAULT false,
  called_at         timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_events_called_at_idx   ON public.call_events (called_at);
CREATE INDEX call_events_dir_status_idx  ON public.call_events (direction, status, called_at);

-- ============================================================
-- email_staff_mentions — a staff member named/recipient in Didi's
--   SENT email. One row per (sent email × staff). Scanned daily from
--   Gmail (e-signature templates excluded); status drives the 08:00
--   per-staff email notification. Dedup via (gmail_message_id, staff_id).
--   staff_email is the canonical @shaked-ins.com delivery target,
--   regardless of which domain Didi actually addressed.
-- ============================================================
CREATE TABLE public.email_staff_mentions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id  text,
  sent_at           timestamptz,
  subject           text,
  recipients        text,
  staff_id          uuid        REFERENCES public.staff(id) ON DELETE CASCADE,
  staff_email       text        NOT NULL,
  staff_name        text,
  detected_via      text        NOT NULL CHECK (detected_via IN ('to_cc', 'body')),
  snippet           text,
  status            text        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'cancelled')),
  sent_notify_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_staff_mentions_msg_staff_uidx
  ON public.email_staff_mentions (gmail_message_id, staff_id)
  WHERE gmail_message_id IS NOT NULL;
CREATE INDEX email_staff_mentions_status_idx
  ON public.email_staff_mentions (status, sent_at);

-- ============================================================
-- wa_unanswered — tracks unanswered inbound messages on Didi's own
--   WhatsApp line (GreenAPI OP instance) so the operational bot can
--   auto-reply after 1h of silence and a follow-up the next morning.
--   One "active" row per chat_id at a time (partial unique index).
-- ============================================================
CREATE TABLE public.wa_unanswered (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id             text        NOT NULL,
  sender_name         text,
  first_unanswered_at timestamptz NOT NULL,
  auto_replied_at     timestamptz,
  followup_sent_at    timestamptz,
  state               text        NOT NULL DEFAULT 'watching'
                      CHECK (state IN (
                        'watching', 'awaiting_reply', 'pending_followup',
                        'resolved', 'skipped', 'expired'
                      )),
  resolved_at         timestamptz,
  blocks_rest_of_day  boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wa_unanswered_chat_id_active_uidx
  ON public.wa_unanswered (chat_id)
  WHERE state IN ('watching', 'awaiting_reply', 'pending_followup');
CREATE INDEX wa_unanswered_state_idx ON public.wa_unanswered (state);

-- ============================================================
-- DEFERRED FOREIGN KEY: meetings.conversation_id → conversations
-- Added after both tables exist (meetings refs conversations
-- which was created in the same migration batch, but meetings
-- was defined first here for FK-ordering with clients).
-- ============================================================
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_conversation_id_fkey
  FOREIGN KEY (conversation_id)
  REFERENCES public.conversations(id);

-- ============================================================
-- INDEXES
-- ============================================================

-- From initial schema (temp-files/migration.sql)
CREATE INDEX idx_clients_assigned_to      ON public.clients      (assigned_to);
CREATE INDEX idx_clients_status           ON public.clients      (status);
CREATE INDEX idx_clients_created_at       ON public.clients      (created_at DESC);
CREATE INDEX idx_meetings_client_id       ON public.meetings     (client_id);
CREATE INDEX idx_meetings_scheduled_at    ON public.meetings     (scheduled_at);
CREATE INDEX idx_meetings_status          ON public.meetings     (status);
CREATE INDEX idx_documents_client_id      ON public.documents    (client_id);
CREATE INDEX idx_documents_meeting_id     ON public.documents    (meeting_id);
CREATE INDEX idx_audit_logs_user_id       ON public.audit_logs   (user_id);
CREATE INDEX idx_audit_logs_timestamp     ON public.audit_logs   (timestamp DESC);

-- Partial indexes from initial schema
CREATE INDEX idx_meetings_pending_reminders
  ON public.meetings (scheduled_at)
  WHERE status = 'scheduled'
    AND (reminder_24h_sent = false OR reminder_1h_sent = false);

CREATE INDEX idx_clients_active
  ON public.clients (assigned_to, created_at DESC)
  WHERE status <> 'completed';

CREATE INDEX idx_clients_new
  ON public.clients (created_at DESC)
  WHERE status = 'new';

-- From 20260415094240_messaging_and_pipeline
CREATE INDEX idx_conversations_whatsapp_chat_id
  ON public.conversations (whatsapp_chat_id);

CREATE INDEX idx_messages_conversation_created
  ON public.messages (conversation_id, created_at DESC);

CREATE INDEX idx_conversations_last_message_at
  ON public.conversations (last_message_at DESC);

-- From 20260429130000_unique_whatsapp_message_id
CREATE UNIQUE INDEX idx_messages_whatsapp_message_id_unique
  ON public.messages (whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

-- From 20260429140000_meetings_conversation_id
CREATE INDEX idx_meetings_conversation_id
  ON public.meetings (conversation_id);

-- From 20260714120000_intake_email_slot — booking-sync thank-you dedupe:
-- at most one meetings row per Google Calendar event.
CREATE UNIQUE INDEX meetings_calendar_event_id_uidx
  ON public.meetings (calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;

-- From 20260519100000_bafi_extend_clients — only the handler index is kept
-- (bafi_file_number column is excluded, so its index is omitted)
CREATE INDEX idx_clients_assigned_handler
  ON public.clients (assigned_handler_id);

-- From 20260520110100_whatsapp_instances
CREATE INDEX idx_whatsapp_instances_active_role
  ON public.whatsapp_instances (is_active, role);

-- From 20260521090000_timeless_integration
CREATE INDEX idx_meetings_timeless_id
  ON public.meetings (timeless_meeting_id)
  WHERE timeless_meeting_id IS NOT NULL;

CREATE INDEX idx_timeless_unmatched_created
  ON public.timeless_unmatched_meetings (created_at DESC)
  WHERE resolved_at IS NULL;

-- Commitments table indexes
CREATE UNIQUE INDEX idx_commitments_source_message_id_unique
  ON public.commitments (source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE INDEX idx_commitments_status_fire_at
  ON public.commitments (status, fire_at);

-- ============================================================
-- TRIGGERS — handle_updated_at
-- Preserves the trigger from the initial schema on the tables
-- that had it, and extends to tables added later that have
-- updated_at columns (conversations, bot_settings, etc. do not
-- have an explicit trigger in the migrations but their
-- updated_at is managed by the application layer).
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.commitments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================
-- BOOTSTRAP DATA
-- Only singleton rows the application assumes exist at startup.
-- Idempotent (ON CONFLICT DO NOTHING).
-- Staff seed rows are NOT included — loaded separately.
-- ============================================================

-- bot_settings singleton (seeded in 20260415094240_messaging_and_pipeline)
INSERT INTO public.bot_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- CLIX bot line instance — placeholder phone, real customerId used for webhook routing
INSERT INTO public.whatsapp_instances (label, phone_number, role, gateway_customer_id, purpose, is_active)
VALUES ('CLIX bot line', '000000000', 'bot', 'didi-scan-bot', 'operational', false)
ON CONFLICT (gateway_customer_id) DO NOTHING;

-- Scanning bot = GreenAPI instance #2. Creds live in .env (GREENAPI_SCAN_*), NOT here.
-- Once provisioned, on the VPS:
--   UPDATE public.whatsapp_instances SET is_active=false WHERE gateway_customer_id='didi-scan-bot';
--   INSERT INTO public.whatsapp_instances (label, phone_number, role, purpose, is_active)
--   VALUES ('Scan line (GreenAPI #2)', '<scan phone>', 'bot', 'operational', true);

-- ============================================================
-- CLIX conversational line — seed template (DO NOT activate until customerId is known)
--
-- Milestone 1 (receive & store only, NO outbound replies):
--   purpose = 'operational'  ← the store-only webhook path; the router never calls the
--                               conversational reply pipeline for this purpose value.
--   is_active = true          ← lets the webhook handler recognise inbound messages.
--
-- Milestone 2 (full conversational bot, outbound Clix send built):
--   Flip purpose → 'conversational' via the runtime INSERT below.
--
-- Runtime INSERT — run on the VPS once the real customerId is available
-- (replace <CLIX_CUSTOMER_ID> and <CLIX_PHONE_NUMBER> with real values):
--
--   INSERT INTO public.whatsapp_instances
--     (label, phone_number, role, gateway_customer_id, purpose, is_active)
--   VALUES
--     ('Clix conversational line', '<CLIX_PHONE_NUMBER>', 'bot', '<CLIX_CUSTOMER_ID>', 'operational', true)
--   ON CONFLICT (gateway_customer_id)
--     DO UPDATE SET purpose   = EXCLUDED.purpose,
--                   is_active = EXCLUDED.is_active;
-- ============================================================

