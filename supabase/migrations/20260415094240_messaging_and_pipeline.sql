-- ============================================================
-- Migration: messaging_and_pipeline
-- Description: Add conversations, messages, bot_settings tables
--              and pipeline_stage to clients. Add v_client_pipeline view.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. CONVERSATIONS
-- ────────────────────────────────────────────────────────────
CREATE TABLE conversations (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_chat_id   text        NOT NULL UNIQUE,   -- format: {phone}@c.us
  client_id          uuid        REFERENCES clients(id) ON DELETE SET NULL,
  contact_name       text,
  contact_phone      text,
  last_message_at    timestamptz NOT NULL DEFAULT now(),
  bot_paused         boolean     NOT NULL DEFAULT false,
  status             text        NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'closed')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────
-- 2. MESSAGES
-- ────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
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

-- ────────────────────────────────────────────────────────────
-- 3. BOT_SETTINGS  (singleton — id must always equal 1)
-- ────────────────────────────────────────────────────────────
CREATE TABLE bot_settings (
  id            int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  system_prompt text        NOT NULL DEFAULT 'You are a friendly helpful assistant replying to WhatsApp messages. Keep replies concise and natural.',
  model_name    text        NOT NULL DEFAULT 'gemma-4-26b-a4b-it',
  enabled       boolean     NOT NULL DEFAULT true,
  auto_reply    boolean     NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed the single settings row
INSERT INTO bot_settings (id) VALUES (1);

-- ────────────────────────────────────────────────────────────
-- 4. EXTEND clients TABLE — add pipeline_stage
-- ────────────────────────────────────────────────────────────
-- clients.status check constraint already exists: ('new','active','completed') ✓
-- Add nullable pipeline_stage column with its own check constraint.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS pipeline_stage text
    CHECK (pipeline_stage IN (
      'new_lead',
      'docs_pending',
      'meeting_scheduling',
      'meeting_scheduled',
      'awaiting_approval',
      'forms',
      'receipt',
      'policy',
      'deposit',
      'completed'
    ));

-- ────────────────────────────────────────────────────────────
-- 5. INDEXES
-- ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_chat_id
  ON conversations (whatsapp_chat_id);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clients_status
  ON clients (status);

CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
  ON conversations (last_message_at DESC);

-- ────────────────────────────────────────────────────────────
-- 6. VIEW: v_client_pipeline
--
-- Security note: This view is created WITHOUT security_invoker
-- because the Express server always accesses it via supabaseAdmin
-- (service role), which bypasses RLS entirely. The view lives in
-- the public schema but is protected by the RLS policies on the
-- underlying tables. If direct anon/authenticated access is ever
-- needed, recreate with security_invoker = true and add policies.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_client_pipeline AS
SELECT
  c.*,

  -- Latest meeting scheduled_at for this client
  (
    SELECT m.scheduled_at
    FROM   meetings m
    WHERE  m.client_id = c.id
    ORDER  BY m.scheduled_at DESC
    LIMIT  1
  ) AS latest_meeting_start_at,

  -- Count of open (non-completed) tasks for this client
  (
    SELECT COUNT(*)::int
    FROM   tasks t
    WHERE  t.client_id = c.id
      AND  t.status NOT IN ('completed', 'cancelled')
  ) AS open_tasks_count,

  -- Derived pipeline stage: explicit value takes precedence;
  -- otherwise computed from status + meeting presence + open tasks.
  CASE
    WHEN c.pipeline_stage IS NOT NULL
      THEN c.pipeline_stage
    WHEN c.status = 'completed'
      THEN 'completed'
    WHEN c.status = 'new'
      THEN 'new_lead'
    -- active client with a future/recent meeting
    WHEN c.status = 'active'
      AND (
        SELECT COUNT(*) FROM meetings m
        WHERE m.client_id = c.id
          AND m.status IN ('scheduled', 'confirmed')
      ) > 0
      THEN 'meeting_scheduled'
    WHEN c.status = 'active'
      AND (
        SELECT COUNT(*) FROM meetings m
        WHERE m.client_id = c.id
      ) = 0
      THEN 'meeting_scheduling'
    WHEN c.status = 'active'
      AND (
        SELECT COUNT(*) FROM tasks t
        WHERE t.client_id = c.id
          AND t.status NOT IN ('completed', 'cancelled')
      ) > 0
      THEN 'docs_pending'
    ELSE 'active'
  END AS derived_stage,

  -- Hours since last status/stage change (updated_at tracks mutations)
  EXTRACT(EPOCH FROM (now() - c.updated_at)) / 3600.0 AS time_in_stage_hours,

  -- SLA breach flags:
  --   • awaiting_approval stage > 24 h
  --   • meeting_scheduled without client confirmation > 4 h
  CASE
    WHEN (
      -- Explicit or derived stage is awaiting_approval and > 24 h old
      COALESCE(c.pipeline_stage, 'new_lead') = 'awaiting_approval'
      AND EXTRACT(EPOCH FROM (now() - c.updated_at)) / 3600.0 > 24
    ) THEN true
    WHEN (
      -- meeting_scheduled (derived) without any confirmed meeting and > 4 h
      COALESCE(
        c.pipeline_stage,
        CASE
          WHEN (SELECT COUNT(*) FROM meetings m
                WHERE m.client_id = c.id
                  AND m.status IN ('scheduled', 'confirmed')) > 0
          THEN 'meeting_scheduled' ELSE NULL END
      ) = 'meeting_scheduled'
      AND (
        SELECT COUNT(*) FROM meetings m
        WHERE m.client_id = c.id
          AND m.client_confirmed = true
      ) = 0
      AND EXTRACT(EPOCH FROM (now() - c.updated_at)) / 3600.0 > 4
    ) THEN true
    ELSE false
  END AS sla_breached

FROM clients c;

-- ────────────────────────────────────────────────────────────
-- 7. ROW LEVEL SECURITY
--
-- TODO: When staff/admin JWT-based auth is wired to Supabase Auth,
--       add role-specific policies (e.g., staff can read their own
--       clients' conversations, admins can read all).
--       For now, all access goes through Express + supabaseAdmin
--       (service role), which bypasses RLS — so these tables are
--       effectively locked to service_role only from the Data API.
-- ────────────────────────────────────────────────────────────
ALTER TABLE conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_settings    ENABLE ROW LEVEL SECURITY;

-- Deny all access by default (no permissive policies for anon/authenticated).
-- The service_role key bypasses RLS automatically — no explicit policy needed.
-- If you want to be explicit, the following commented-out block shows the pattern:
--
-- CREATE POLICY "service_role full access on conversations"
--   ON conversations
--   TO service_role
--   USING (true)
--   WITH CHECK (true);
