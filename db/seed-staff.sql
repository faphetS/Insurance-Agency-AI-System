-- ============================================================================
-- Seed: agency staff (Shaked Insurance).
-- PLACEHOLDER phone = the testing number (639219909210) for ALL staff until the
-- real per-staff WhatsApp numbers are provided. This makes the conversational bot
-- recognize these numbers as staff (isStaffChat) and exclude them from the lead
-- intake flow, and lets the staff-picker + handoff reach them.
-- Idempotent: fixed UUIDs + ON CONFLICT (id) DO UPDATE.
-- Apply on the VPS:  psql -U app -d insurance -f db/seed-staff.sql
-- ============================================================================

INSERT INTO public.staff (id, full_name, email, phone, role, is_active) VALUES
  ('baf10001-0000-0000-0000-000000000001', 'דידי פרידלנדר',  'didi@shaked-ins.com',   '639219909210', 'owner', true),  -- Didi Friedlander (owner)
  ('baf10001-0000-0000-0000-000000000002', 'יפה נוימן',       'yafa@shaked-ins.com',   '639219909210', 'agent', true),  -- Yafa Neuman
  ('baf10001-0000-0000-0000-000000000003', 'צביה הורביץ',     'tzivia@shaked-ins.com', '639219909210', 'agent', true),  -- Tzivia Horowitz
  ('baf10001-0000-0000-0000-000000000004', 'רות קורנפיין',    'ruth@shaked-ins.com',   '639219909210', 'agent', true),  -- Ruth Kornfein
  ('baf10001-0000-0000-0000-000000000005', 'גיטי גרינבוימס',  'giti@shaked-ins.com',   '639219909210', 'agent', true),  -- Giti Greenbaum
  ('baf10001-0000-0000-0000-000000000006', 'מירב ששון',       'merav@shaked-ins.com',  '639219909210', 'agent', true),  -- Merav Sasson
  ('baf10001-0000-0000-0000-000000000007', 'הודיה זרביב',     'hodaya@shaked-ins.com', '639219909210', 'agent', true),  -- Hodaya Zarbiv
  ('baf10001-0000-0000-0000-000000000008', 'רבקה קציר',       'rivka@shaked-ins.com',  '639219909210', 'agent', true)   -- Rivka Katzir
ON CONFLICT (id) DO UPDATE SET
  full_name  = EXCLUDED.full_name,
  email      = EXCLUDED.email,
  phone      = EXCLUDED.phone,
  role       = EXCLUDED.role,
  is_active  = EXCLUDED.is_active,
  updated_at = now();
