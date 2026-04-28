-- Add 'welcome' to intake_current_slot CHECK constraint and set as new default
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_intake_current_slot_check;
ALTER TABLE clients ADD CONSTRAINT clients_intake_current_slot_check
  CHECK (intake_current_slot IN ('welcome', 'full_name', 'email', 'inquiry_type', 'id_photo', 'poa', 'done'));

ALTER TABLE clients ALTER COLUMN intake_current_slot SET DEFAULT 'welcome';
