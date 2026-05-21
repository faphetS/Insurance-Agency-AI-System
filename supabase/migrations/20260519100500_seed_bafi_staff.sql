-- ============================================================
-- Migration: seed_bafi_staff
-- Description: Insert 8 BAFI agency staff members into the
--              staff table. The staff table has staff.id FK →
--              auth.users(id), so we insert placeholder rows
--              into auth.users first (email-confirmed, no
--              password — login disabled by design).
--              Idempotent: ON CONFLICT DO NOTHING on both tables.
-- ============================================================

DO $$
DECLARE
  v_didi   uuid := 'baf10001-0000-0000-0000-000000000001';
  v_yafa   uuid := 'baf10001-0000-0000-0000-000000000002';
  v_tzivia uuid := 'baf10001-0000-0000-0000-000000000003';
  v_ruth   uuid := 'baf10001-0000-0000-0000-000000000004';
  v_giti   uuid := 'baf10001-0000-0000-0000-000000000005';
  v_merav  uuid := 'baf10001-0000-0000-0000-000000000006';
  v_hodaya uuid := 'baf10001-0000-0000-0000-000000000007';
  v_rivka  uuid := 'baf10001-0000-0000-0000-000000000008';
BEGIN

  -- Insert placeholder auth.users rows so FK is satisfied.
  -- encrypted_password = '' (no login), email_confirmed_at = now().
  INSERT INTO auth.users (
    id, instance_id, aud, role,
    email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  ) VALUES
    (v_didi,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'didi@shaked-ins.com',   '', now(), now(), now(),
     '{"provider":"email","providers":["email"],"role":"agent"}'::jsonb, '{}'::jsonb),
    (v_yafa,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'yafa@shaked-ins.com',   '', now(), now(), now(),
     '{"provider":"email","providers":["email"],"role":"agent"}'::jsonb, '{}'::jsonb),
    (v_tzivia, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'tzivia@shaked-ins.com', '', now(), now(), now(),
     '{"provider":"email","providers":["email"],"role":"agent"}'::jsonb, '{}'::jsonb),
    (v_ruth,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'ruth@shaked-ins.com',   '', now(), now(), now(),
     '{"provider":"email","providers":["email"],"role":"agent"}'::jsonb, '{}'::jsonb),
    (v_giti,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'giti@shaked-ins.com',   '', now(), now(), now(),
     '{"provider":"email","providers":["email"],"role":"agent"}'::jsonb, '{}'::jsonb),
    (v_merav,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'merav@shaked-ins.com',  '', now(), now(), now(),
     '{"provider":"email","providers":["email"],"role":"agent"}'::jsonb, '{}'::jsonb),
    (v_hodaya, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'hodaya@shaked-ins.com', '', now(), now(), now(),
     '{"provider":"email","providers":["email"],"role":"agent"}'::jsonb, '{}'::jsonb),
    (v_rivka,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'rivka@shaked-ins.com',  '', now(), now(), now(),
     '{"provider":"email","providers":["email"],"role":"agent"}'::jsonb, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  -- Now insert into staff (FK satisfied by the auth.users rows above).
  INSERT INTO public.staff (id, full_name, email, role, is_active)
  VALUES
    (v_didi,   'Didi Friedlander',  'didi@shaked-ins.com',    'agent', true),
    (v_yafa,   'Yafa Neuman',       'yafa@shaked-ins.com',    'agent', true),
    (v_tzivia, 'Tzivia Horowitz',   'tzivia@shaked-ins.com',  'agent', true),
    (v_ruth,   'Ruth Kornfein',     'ruth@shaked-ins.com',    'agent', true),
    (v_giti,   'Giti Greenbaum',    'giti@shaked-ins.com',    'agent', true),
    (v_merav,  'Merav Sasson',      'merav@shaked-ins.com',   'agent', true),
    (v_hodaya, 'Hodaya Zarbiv',     'hodaya@shaked-ins.com',  'agent', true),
    (v_rivka,  'Rivka Katzir',      'rivka@shaked-ins.com',   'agent', true)
  ON CONFLICT (id) DO NOTHING;

END $$;
