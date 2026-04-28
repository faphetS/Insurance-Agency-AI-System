ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_paused_until timestamptz;
