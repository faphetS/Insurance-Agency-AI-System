ALTER TABLE meetings ADD COLUMN conversation_id uuid REFERENCES conversations(id);
CREATE INDEX idx_meetings_conversation_id ON meetings(conversation_id);
