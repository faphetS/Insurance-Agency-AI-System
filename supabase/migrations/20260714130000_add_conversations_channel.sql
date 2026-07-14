-- Meta transport swap (Phase A): tag each conversation with the transport that
-- received its inbound messages, so the same process can answer GreenAPI chats
-- via GreenAPI and Meta Cloud API chats via Meta during the dual-run test phase.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS channel text CHECK (channel IN ('greenapi', 'meta'));
