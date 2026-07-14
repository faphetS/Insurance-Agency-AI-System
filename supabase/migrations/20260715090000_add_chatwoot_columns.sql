-- Chatwoot mirror (Phase B): per-chat cache of the Chatwoot contact +
-- conversation ids so the mirror creates each contact/conversation once and
-- then only posts messages. Cleared + rebuilt when Chatwoot returns 404
-- (conversation deleted on the Chatwoot side).
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS chatwoot_contact_id bigint;
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS chatwoot_conversation_id bigint;
