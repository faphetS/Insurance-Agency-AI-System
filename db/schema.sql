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
                         'life', 'health', 'property', 'vehicle',
                         'liability', 'business', 'pension', 'travel',
                         'mortgage', 'general'
                       )),
  status               text        NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new', 'active', 'completed')),
  assigned_to          uuid        NOT NULL REFERENCES public.staff(id),
  source_channel       text        NOT NULL
                       CHECK (source_channel IN ('wa', 'email')),
  last_service_date    date,
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
  intake_current_slot  text        DEFAULT 'welcome'
                       CHECK (intake_current_slot IN (
                         'welcome', 'full_name', 'email', 'inquiry_type',
                         'id_photo', 'poa', 'done'
                       )),
  intake_completed_at  timestamptz,
  mirrored_to_sheet_at timestamptz,                                    -- set once when the lead has been appended to the Google leads sheet (idempotency)

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
  id_number            text
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
-- 4. TASKS
--    Core columns from initial schema.
--    status values: initial CHECK was ('pending','done','overdue')
--    but the view and application logic reference 'completed' and
--    'cancelled' as valid statuses, so the full accepted set is
--    captured here.
-- ============================================================
CREATE TABLE public.tasks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  meeting_id      uuid        REFERENCES public.meetings(id) ON DELETE SET NULL,
  type            text        NOT NULL
                  CHECK (type IN (
                    'forms_check', 'receipt_check', 'policy_check',
                    'deposit_check', 'cross_check', 'service_meeting',
                    'summary_approval', 'general'
                  )),
  description     text        NOT NULL,
  assigned_to     uuid        NOT NULL REFERENCES public.staff(id),
  due_at          timestamptz NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN (
                    'pending', 'in_progress', 'completed', 'cancelled',
                    'done', 'overdue'
                  )),
  reminder_sent   boolean     NOT NULL DEFAULT false,
  parent_task_id  uuid        REFERENCES public.tasks(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 5. DOCUMENTS
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
-- 6. AUDIT_LOGS
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
-- 7. CONVERSATIONS
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
  whatsapp_instance_id  uuid        REFERENCES public.whatsapp_instances(id)
);

-- ============================================================
-- 8. MESSAGES
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
-- 9. BOT_SETTINGS  (singleton row — id must always equal 1)
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
-- 10. SYSTEM_SETTINGS
--     Added by 20260429150000_system_settings.
-- ============================================================
CREATE TABLE public.system_settings (
  key        text        PRIMARY KEY,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 11. NOTIFICATIONS
--     Added by 20260506120000_notifications.
--     reference_key unique index: final form is NOT partial
--     (20260520100000_fix_notifications_unique_index dropped the
--     partial WHERE clause and recreated without it).
-- ============================================================
CREATE TABLE public.notifications (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text        NOT NULL,
  title          text        NOT NULL,
  message        text        NOT NULL,
  severity       text        NOT NULL DEFAULT 'info'
                 CHECK (severity IN ('info', 'warning', 'urgent')),
  client_id      uuid        REFERENCES public.clients(id) ON DELETE SET NULL,
  meeting_id     uuid        REFERENCES public.meetings(id) ON DELETE SET NULL,
  task_id        uuid        REFERENCES public.tasks(id) ON DELETE SET NULL,
  reference_key  text,
  is_read        boolean     NOT NULL DEFAULT false,
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 12. GMAIL_INTEGRATIONS
--     Added by 20260520110000_gmail_integrations.
-- ============================================================
CREATE TABLE public.gmail_integrations (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id                uuid        NOT NULL UNIQUE REFERENCES public.staff(id) ON DELETE CASCADE,
  email                   text        NOT NULL,
  refresh_token           text        NOT NULL,
  access_token            text,
  access_token_expires_at timestamptz,
  scope                   text        NOT NULL,
  connected_at            timestamptz NOT NULL DEFAULT now(),
  last_synced_at          timestamptz,
  last_unread_count       integer     DEFAULT 0,
  last_error              text,
  is_active               boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 13. WHATSAPP_INSTANCES
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
-- 14. TIMELESS_UNMATCHED_MEETINGS
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
-- DEFERRED FOREIGN KEY: meetings.conversation_id → conversations
-- Added after both tables exist (meetings refs conversations
-- which was created in the same migration batch, but meetings
-- was defined first here for FK-ordering with clients/tasks).
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
CREATE INDEX idx_tasks_client_id          ON public.tasks        (client_id);
CREATE INDEX idx_tasks_meeting_id         ON public.tasks        (meeting_id);
CREATE INDEX idx_tasks_assigned_to        ON public.tasks        (assigned_to);
CREATE INDEX idx_tasks_parent_task_id     ON public.tasks        (parent_task_id);
CREATE INDEX idx_tasks_status             ON public.tasks        (status);
CREATE INDEX idx_tasks_due_at             ON public.tasks        (due_at);
CREATE INDEX idx_documents_client_id      ON public.documents    (client_id);
CREATE INDEX idx_documents_meeting_id     ON public.documents    (meeting_id);
CREATE INDEX idx_audit_logs_user_id       ON public.audit_logs   (user_id);
CREATE INDEX idx_audit_logs_timestamp     ON public.audit_logs   (timestamp DESC);

-- Partial indexes from initial schema
CREATE INDEX idx_tasks_pending
  ON public.tasks (due_at)
  WHERE status IN ('pending', 'overdue');

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

-- From 20260506120000_notifications
-- Note: 20260520100000_fix_notifications_unique_index dropped the
-- partial (WHERE reference_key IS NOT NULL) version and replaced
-- with a plain unique index — reproduced here in final form.
CREATE UNIQUE INDEX idx_notifications_reference_key
  ON public.notifications (reference_key);

CREATE INDEX idx_notifications_created_at
  ON public.notifications (created_at DESC);

CREATE INDEX idx_notifications_is_read
  ON public.notifications (is_read)
  WHERE is_read = false;

-- From 20260519100000_bafi_extend_clients — only the handler index is kept
-- (bafi_file_number column is excluded, so its index is omitted)
CREATE INDEX idx_clients_assigned_handler
  ON public.clients (assigned_handler_id);

-- From 20260520110000_gmail_integrations
CREATE INDEX idx_gmail_integrations_active_synced
  ON public.gmail_integrations (is_active, last_synced_at);

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
  BEFORE UPDATE ON public.tasks
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
-- VIEW: v_client_pipeline
-- Final form from 20260415160458_intake_in_pipeline_view.sql.
-- Earlier version (20260415094240) used SELECT c.* — replaced
-- by the explicit column list below which adds intake_state and
-- intake_current_slot, and uses the normalised Postgres form
-- of all subqueries.
-- ============================================================
CREATE OR REPLACE VIEW public.v_client_pipeline AS
SELECT
  c.id,
  c.full_name,
  c.phone,
  c.email,
  c.id_photo_url,
  c.id_validated,
  c.poa_doc_url,
  c.inquiry_type,
  c.status,
  c.assigned_to,
  c.source_channel,
  c.last_service_date,
  c.notes,
  c.created_at,
  c.updated_at,
  c.pipeline_stage,

  -- Latest meeting scheduled_at for this client
  (
    SELECT m.scheduled_at
    FROM   public.meetings m
    WHERE  m.client_id = c.id
    ORDER  BY m.scheduled_at DESC
    LIMIT  1
  ) AS latest_meeting_start_at,

  -- Count of open (non-completed) tasks for this client
  (
    SELECT COUNT(*)::integer
    FROM   public.tasks t
    WHERE  t.client_id = c.id
      AND  t.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
  ) AS open_tasks_count,

  -- Derived pipeline stage
  CASE
    WHEN (c.pipeline_stage IS NOT NULL)
      THEN c.pipeline_stage
    WHEN (c.status = 'completed')
      THEN 'completed'
    WHEN (c.status = 'new')
      THEN 'new_lead'
    WHEN (c.status = 'active'
      AND (
        SELECT COUNT(*)
        FROM   public.meetings m
        WHERE  m.client_id = c.id
          AND  m.status = ANY (ARRAY['scheduled'::text, 'confirmed'::text])
      ) > 0)
      THEN 'meeting_scheduled'
    WHEN (c.status = 'active'
      AND (
        SELECT COUNT(*)
        FROM   public.meetings m
        WHERE  m.client_id = c.id
      ) = 0)
      THEN 'meeting_scheduling'
    WHEN (c.status = 'active'
      AND (
        SELECT COUNT(*)
        FROM   public.tasks t
        WHERE  t.client_id = c.id
          AND  t.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
      ) > 0)
      THEN 'docs_pending'
    ELSE 'active'
  END AS derived_stage,

  -- Hours since last status/stage change
  (EXTRACT(EPOCH FROM (now() - c.updated_at)) / 3600.0) AS time_in_stage_hours,

  -- SLA breach flags
  CASE
    WHEN (
      COALESCE(c.pipeline_stage, 'new_lead') = 'awaiting_approval'
      AND (EXTRACT(EPOCH FROM (now() - c.updated_at)) / 3600.0) > 24
    ) THEN true
    WHEN (
      COALESCE(c.pipeline_stage,
        CASE
          WHEN (
            SELECT COUNT(*)
            FROM   public.meetings m
            WHERE  m.client_id = c.id
              AND  m.status = ANY (ARRAY['scheduled'::text, 'confirmed'::text])
          ) > 0
          THEN 'meeting_scheduled'
          ELSE NULL
        END
      ) = 'meeting_scheduled'
      AND (
        SELECT COUNT(*)
        FROM   public.meetings m
        WHERE  m.client_id = c.id
          AND  m.client_confirmed = true
      ) = 0
      AND (EXTRACT(EPOCH FROM (now() - c.updated_at)) / 3600.0) > 4
    ) THEN true
    ELSE false
  END AS sla_breached,

  -- Intake columns (added by 20260415160458_intake_in_pipeline_view)
  c.intake_state,
  c.intake_current_slot

FROM public.clients c;
