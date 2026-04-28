-- Enforce uniqueness on whatsapp_message_id to prevent race condition duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_whatsapp_message_id_unique
ON messages (whatsapp_message_id)
WHERE whatsapp_message_id IS NOT NULL;
