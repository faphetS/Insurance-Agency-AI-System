-- Seed one active staff row for the agency owner.
-- staff.id is a FK to auth.users(id), so we must use the existing auth user's UUID.
-- Idempotent: INSERT ... ON CONFLICT (id) DO NOTHING.

INSERT INTO public.staff (id, full_name, email, role, is_active)
VALUES (
  '550df538-8f17-47d8-bf43-c83abb504953', -- auth.users id for admin@gmail.com
  'Agency Owner',
  'admin@gmail.com',
  'admin',
  true
)
ON CONFLICT (id) DO NOTHING;
