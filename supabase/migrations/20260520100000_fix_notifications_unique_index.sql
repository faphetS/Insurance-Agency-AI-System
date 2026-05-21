DROP INDEX IF EXISTS idx_notifications_reference_key;
CREATE UNIQUE INDEX idx_notifications_reference_key ON notifications (reference_key);
