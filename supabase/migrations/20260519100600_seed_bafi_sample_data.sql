-- ============================================================
-- Migration: seed_bafi_sample_data
-- Description: Seed realistic BAFI mirror data for end-to-end
--              testing. ALL rows are MOCK/SIMULATED data —
--              not real client or policy records.
--
-- Idempotent: uses DO $$ blocks with existence checks so
-- repeated runs do not create duplicates.
-- ============================================================

DO $$
DECLARE
  -- Insurance company IDs
  v_mgd  uuid := '11111111-0001-0001-0001-000000000001';
  v_mnr  uuid := '11111111-0001-0001-0001-000000000002';
  v_fnx  uuid := '11111111-0001-0001-0001-000000000003';
  v_xls  uuid := '11111111-0001-0001-0001-000000000004';
  v_ppc  uuid := '11111111-0001-0001-0001-000000000005';
  v_mtd  uuid := '11111111-0001-0001-0001-000000000006';

  -- BAFI staff UUID (Didi Friedlander — used as assigned_to for seeded clients)
  v_didi uuid := 'baf10001-0000-0000-0000-000000000001';

  -- Employer IDs
  v_emp1 uuid := '22222222-0001-0001-0001-000000000001';
  v_emp2 uuid := '22222222-0001-0001-0001-000000000002';
  v_emp3 uuid := '22222222-0001-0001-0001-000000000003';

  -- bafi_agent IDs
  v_agt1 uuid := '33333333-0001-0001-0001-000000000001';
  v_agt2 uuid := '33333333-0001-0001-0001-000000000002';

  -- Client IDs
  v_barko   uuid := '44444444-0001-0001-0001-000000000001';
  v_client2 uuid := '44444444-0001-0001-0001-000000000002';
  v_client3 uuid := '44444444-0001-0001-0001-000000000003';
  v_client4 uuid := '44444444-0001-0001-0001-000000000004';
  v_client5 uuid := '44444444-0001-0001-0001-000000000005';

  -- Policy IDs for Barko (9 policies)
  v_p1  uuid := '55555555-0001-0001-0001-000000000001';
  v_p2  uuid := '55555555-0001-0001-0001-000000000002';
  v_p3  uuid := '55555555-0001-0001-0001-000000000003';
  v_p4  uuid := '55555555-0001-0001-0001-000000000004';
  v_p5  uuid := '55555555-0001-0001-0001-000000000005';
  v_p6  uuid := '55555555-0001-0001-0001-000000000006';
  v_p7  uuid := '55555555-0001-0001-0001-000000000007';
  v_p8  uuid := '55555555-0001-0001-0001-000000000008';
  v_p9  uuid := '55555555-0001-0001-0001-000000000009';

  -- Policy IDs for other clients
  v_p10 uuid := '55555555-0001-0001-0001-000000000010';
  v_p11 uuid := '55555555-0001-0001-0001-000000000011';
  v_p12 uuid := '55555555-0001-0001-0001-000000000012';
  v_p13 uuid := '55555555-0001-0001-0001-000000000013';
  v_p14 uuid := '55555555-0001-0001-0001-000000000014';
  v_p15 uuid := '55555555-0001-0001-0001-000000000015';
  v_p16 uuid := '55555555-0001-0001-0001-000000000016';
  v_p17 uuid := '55555555-0001-0001-0001-000000000017';
  v_p18 uuid := '55555555-0001-0001-0001-000000000018';
  v_p19 uuid := '55555555-0001-0001-0001-000000000019';

BEGIN

-- ────────────────────────────────────────────────────────────
-- 1. INSURANCE COMPANIES
-- ────────────────────────────────────────────────────────────
INSERT INTO insurance_companies (id, name, short_code, active)
VALUES
  (v_mgd, 'מגדל',           'MGD', true),
  (v_mnr, 'מנורה',          'MNR', true),
  (v_fnx, 'פניקס',          'FNX', true),
  (v_xls, 'אקסלנס גמל',     'XLS', true),
  (v_ppc, 'פספורטכארד',     'PPC', true),
  (v_mtd, 'מיטב דש',        'MTD', true)
ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- 2. EMPLOYERS
-- ────────────────────────────────────────────────────────────
INSERT INTO employers (id, name, tax_id, address, contact_phone)
VALUES
  (v_emp1, 'טכנולוגיות מתקדמות בע"מ',  '514123456', 'רחוב הרצל 45, תל אביב',     '03-7654321'),
  (v_emp2, 'בניה ופיתוח שיא בע"מ',      '513987654', 'שדרות רוטשילד 12, ירושלים', '02-5551234'),
  (v_emp3, 'קבוצת הבריאות הכוללת',      '512345678', 'רחוב דיזנגוף 88, חיפה',     '04-8889999')
ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- 3. BAFI AGENTS
-- ────────────────────────────────────────────────────────────
INSERT INTO bafi_agents (id, agency_name, full_name, agent_number, phone, email)
VALUES
  (v_agt1, 'שקד סוכנות לביטוח', 'דידי פרידלנדר', 'AGT-1009667', '052-1234567', 'didi@shaked-ins.com'),
  (v_agt2, 'שקד סוכנות לביטוח', 'יפה נוימן',     'AGT-1009668', '052-9876543', 'yafa@shaked-ins.com')
ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- 4. CLIENTS
-- Barko Shay: last_service_date ~3 years ago → 'due' in service checker
-- Others: recent dates, mixed statuses
-- ────────────────────────────────────────────────────────────
INSERT INTO clients (id, full_name, phone, email, status, inquiry_type, source_channel,
                     assigned_to, bafi_file_number, id_number,
                     date_of_birth, gender, client_type, last_service_date, created_at, updated_at)
VALUES
  (v_barko,
   'ברקו שי',
   '054-1234567',
   'barko.shay@example.com',
   'active',
   'pension', 'wa',
   v_didi,
   '100001',
   '012345678',
   '1975-03-15',
   'male',
   'individual',
   (now() - interval '3 years 2 months')::date,
   now() - interval '3 years 2 months',
   now() - interval '3 years 2 months'),

  (v_client2,
   'שרה לוי',
   '052-2345678',
   'sara.levi@example.com',
   'active',
   'life', 'wa',
   v_didi,
   '100002',
   '023456789',
   '1980-07-22',
   'female',
   'individual',
   (now() - interval '8 months')::date,
   now() - interval '8 months',
   now() - interval '8 months'),

  (v_client3,
   'דוד כהן',
   '050-3456789',
   'david.cohen@example.com',
   'active',
   'pension', 'wa',
   v_didi,
   '100003',
   '034567890',
   '1965-11-10',
   'male',
   'individual',
   (now() - interval '14 months')::date,
   now() - interval '14 months',
   now() - interval '14 months'),

  (v_client4,
   'מרים גולדברג',
   '053-4567890',
   'miriam.goldberg@example.com',
   'active',
   'health', 'wa',
   v_didi,
   '100004',
   '045678901',
   '1990-02-28',
   'female',
   'individual',
   (now() - interval '3 months')::date,
   now() - interval '3 months',
   now() - interval '3 months'),

  (v_client5,
   'יוסף אברהם',
   '058-5678901',
   'yosef.avraham@example.com',
   'completed',
   'pension', 'wa',
   v_didi,
   '100005',
   '056789012',
   '1958-09-05',
   'male',
   'individual',
   (now() - interval '1 month')::date,
   now() - interval '1 month',
   now() - interval '1 month')
ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- 5. POLICIES
-- Barko: 9 policies matching reference (שוק הון, חיים, פנסיה, סיעודי, אלמנטרי)
-- Others: 2-3 each
-- ────────────────────────────────────────────────────────────

-- Barko's 9 policies
INSERT INTO policies (id, client_id, policy_number, policy_type, insurance_company_id,
                      start_date, end_date, status, product_name, plan_name,
                      fund_balance, fund_track, balance_as_of, created_at, updated_at)
VALUES
  (v_p1, v_barko, '7-926-663305-0', 'שוק הון', v_xls,
   '2010-01-01', NULL, 'פעיל', 'קרן השתלמות', 'אקסלנס גמל להשקעה',
   245300.00, 'מניות כללי', '2026-03-31', now(), now()),

  (v_p2, v_barko, '7-926-663306-1', 'שוק הון', v_mtd,
   '2012-06-01', NULL, 'פעיל', 'קופת גמל', 'מיטב פנסיה',
   182400.00, 'אג"ח ממשלתי', '2026-03-31', now(), now()),

  (v_p3, v_barko, '5-301-887210-3', 'פנסיה', v_mnr,
   '2008-03-01', NULL, 'פעיל', 'קרן פנסיה', 'מנורה מבטחים פנסיה',
   389500.00, 'מסלול כללי', '2026-03-31', now(), now()),

  (v_p4, v_barko, '5-301-887211-4', 'פנסיה', v_mtd,
   '2015-09-01', NULL, 'פעיל', 'קרן פנסיה', 'מיטב דש פנסיה',
   156700.00, 'מסלול מניות', '2026-03-31', now(), now()),

  (v_p5, v_barko, '3-201-554432-5', 'חיים', v_mgd,
   '2009-11-01', NULL, 'פעיל', 'פוליסת ביטוח חיים משולב חיסכון', 'מגדל חיים',
   NULL, NULL, NULL, now(), now()),

  (v_p6, v_barko, '3-201-554433-6', 'חיים', v_fnx,
   '2018-02-01', NULL, 'פעיל', 'פוליסת סיכון טהור', 'פניקס ריסק',
   NULL, NULL, NULL, now(), now()),

  (v_p7, v_barko, '9-501-223344-7', 'סיעודי', v_mgd,
   '2011-07-01', NULL, 'פעיל', 'ביטוח סיעודי ופרט', 'מגדל סיעוד פרט',
   NULL, NULL, NULL, now(), now()),

  (v_p8, v_barko, '8-401-112233-8', 'אלמנטרי', v_ppc,
   '2020-01-01', '2027-01-01', 'פעיל', 'ביטוח רכוש', 'פספורטכארד בית',
   NULL, NULL, NULL, now(), now()),

  (v_p9, v_barko, '7-926-663307-9', 'שוק הון', v_xls,
   '2019-04-01', NULL, 'פעיל', 'קופת גמל להשקעה', 'אקסלנס IRA',
   98200.00, 'מסלול כללי', '2026-03-31', now(), now())
ON CONFLICT (id) DO NOTHING;

-- Sara Levi — 3 policies
INSERT INTO policies (id, client_id, policy_number, policy_type, insurance_company_id,
                      start_date, status, product_name, plan_name,
                      fund_balance, balance_as_of, created_at, updated_at)
VALUES
  (v_p10, v_client2, '5-301-990011-0', 'פנסיה', v_mnr,
   '2014-05-01', 'פעיל', 'קרן פנסיה', 'מנורה מבטחים',
   210000.00, '2026-03-31', now(), now()),

  (v_p11, v_client2, '3-201-770022-1', 'חיים', v_mgd,
   '2016-08-01', 'פעיל', 'פוליסת סיכון טהור', 'מגדל ריסק',
   NULL, NULL, now(), now()),

  (v_p12, v_client2, '8-401-550033-2', 'אלמנטרי', v_ppc,
   '2022-01-01', 'פעיל', 'ביטוח רכוש', 'פספורטכארד רכב',
   NULL, NULL, now(), now())
ON CONFLICT (id) DO NOTHING;

-- David Cohen — 3 policies
INSERT INTO policies (id, client_id, policy_number, policy_type, insurance_company_id,
                      start_date, status, product_name, plan_name,
                      fund_balance, balance_as_of, created_at, updated_at)
VALUES
  (v_p13, v_client3, '7-926-441100-3', 'שוק הון', v_xls,
   '2005-01-01', 'פעיל', 'קרן השתלמות', 'אקסלנס השתלמות',
   520000.00, '2026-03-31', now(), now()),

  (v_p14, v_client3, '5-301-331122-4', 'פנסיה', v_mtd,
   '2005-06-01', 'פעיל', 'קרן פנסיה', 'מיטב פנסיה ותיקה',
   680000.00, '2026-03-31', now(), now()),

  (v_p15, v_client3, '9-501-221133-5', 'סיעודי', v_fnx,
   '2010-03-01', 'פעיל', 'ביטוח סיעודי', 'פניקס סיעוד',
   NULL, NULL, now(), now())
ON CONFLICT (id) DO NOTHING;

-- Miriam Goldberg — 2 policies
INSERT INTO policies (id, client_id, policy_number, policy_type, insurance_company_id,
                      start_date, status, product_name, plan_name,
                      fund_balance, balance_as_of, created_at, updated_at)
VALUES
  (v_p16, v_client4, '5-301-660044-6', 'פנסיה', v_mnr,
   '2018-03-01', 'פעיל', 'קרן פנסיה', 'מנורה מבטחים חדשה',
   85000.00, '2026-03-31', now(), now()),

  (v_p17, v_client4, '3-201-880055-7', 'חיים', v_mgd,
   '2019-11-01', 'פעיל', 'פוליסת סיכון טהור קולקטיב', 'מגדל קולקטיב',
   NULL, NULL, now(), now())
ON CONFLICT (id) DO NOTHING;

-- Yosef Avraham — 2 policies
INSERT INTO policies (id, client_id, policy_number, policy_type, insurance_company_id,
                      start_date, end_date, status, product_name, plan_name,
                      fund_balance, balance_as_of, created_at, updated_at)
VALUES
  (v_p18, v_client5, '5-301-770066-8', 'פנסיה', v_mtd,
   '1995-07-01', NULL, 'פעיל', 'קרן פנסיה', 'מיטב קשישים',
   920000.00, '2026-03-31', now(), now()),

  (v_p19, v_client5, '7-926-550077-9', 'שוק הון', v_xls,
   '2000-02-01', NULL, 'לא פעיל', 'קרן השתלמות', 'אקסלנס השתלמות',
   310000.00, '2026-03-31', now(), now())
ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- 6. BAFI_FORMS
-- 5-10 per active client, mix of form_types and dates
-- ────────────────────────────────────────────────────────────

-- Barko — 9 forms (matches reference: "13+ forms")
INSERT INTO bafi_forms (client_id, catalog_number, form_date, form_type, domain, branch,
                        insurance_company_id, pages, form_name, status)
VALUES
  (v_barko, '26027830114010916', '2023-09-01', 'הצטרפות',  'חיים',     'חיסכון', v_xls, 4, 'טופס הצטרפות קרן השתלמות',          'completed'),
  (v_barko, '26027830114010917', '2023-11-01', 'הצעות',    'חיים',     'חיסכון', v_mnr, 6, 'הצעה לפנסיה מנורה',                  'completed'),
  (v_barko, '26027830114010918', '2024-01-01', 'תביעות',   'בריאות',   'סיכונים', v_mgd, 3, 'תביעת ביטוח בריאות מגדל',           'completed'),
  (v_barko, '26027830114010919', '2024-03-01', 'הצטרפות',  'פיננסים',  'חיסכון', v_mtd, 5, 'הצטרפות קרן פנסיה מיטב דש',         'completed'),
  (v_barko, '26027830114010920', '2024-06-01', 'הצעות',    'חיים',     'סיכונים', v_fnx, 2, 'הצעת ביטוח חיים פניקס',             'completed'),
  (v_barko, '26027830114010921', '2024-08-01', 'הצטרפות',  'חיים',     'חיסכון', v_xls, 4, 'טופס הצטרפות קופת גמל IRA',          'completed'),
  (v_barko, '26027830114010922', '2024-10-01', 'אחר',      'רכב',      'רכוש',   v_ppc, 2, 'עדכון פרטי ביטוח רכב',               'completed'),
  (v_barko, '26027830114010923', '2025-01-01', 'תביעות',   'בריאות',   'סיכונים', v_mgd, 3, 'תביעת ניתוח',                       'completed'),
  (v_barko, '26027830114010924', '2025-04-01', 'הצעות',    'חיים',     'חיסכון', v_mnr, 5, 'הצעת חידוש פנסיה מנורה 2025',        'completed');

-- Sara Levi — 6 forms
INSERT INTO bafi_forms (client_id, catalog_number, form_date, form_type, domain, branch,
                        insurance_company_id, pages, form_name, status)
VALUES
  (v_client2, '27001110000000001', '2024-02-01', 'הצטרפות', 'חיים',    'חיסכון',  v_mnr, 5, 'הצטרפות פנסיה מנורה',          'completed'),
  (v_client2, '27001110000000002', '2024-04-01', 'הצעות',   'בריאות',  'סיכונים', v_mgd, 3, 'הצעת ביטוח בריאות מגדל',       'completed'),
  (v_client2, '27001110000000003', '2024-07-01', 'הצטרפות', 'פיננסים', 'חיסכון',  v_mgd, 4, 'הצטרפות ביטוח חיים מגדל',      'completed'),
  (v_client2, '27001110000000004', '2025-01-01', 'אחר',     'רכב',     'רכוש',    v_ppc, 2, 'חידוש ביטוח רכב',               'completed'),
  (v_client2, '27001110000000005', '2025-03-01', 'הצעות',   'חיים',    'סיכונים', v_fnx, 4, 'הצעה לביטוח חיים פניקס',        'in_progress'),
  (v_client2, '27001110000000006', '2025-05-01', 'הצטרפות', 'פיננסים', 'חיסכון',  v_mnr, 6, 'הצטרפות קרן פנסיה חדשה',        'sent');

-- David Cohen — 7 forms
INSERT INTO bafi_forms (client_id, catalog_number, form_date, form_type, domain, branch,
                        insurance_company_id, pages, form_name, status)
VALUES
  (v_client3, '28001110000000001', '2022-05-01', 'הצטרפות', 'פיננסים', 'חיסכון',  v_xls, 4, 'הצטרפות קרן השתלמות אקסלנס',   'completed'),
  (v_client3, '28001110000000002', '2022-09-01', 'הצעות',   'חיים',    'סיכונים', v_fnx, 3, 'הצעת סיעוד פניקס',             'completed'),
  (v_client3, '28001110000000003', '2023-01-01', 'תביעות',  'בריאות',  'סיכונים', v_mtd, 2, 'תביעת ביטוח',                   'completed'),
  (v_client3, '28001110000000004', '2023-06-01', 'הצטרפות', 'פיננסים', 'חיסכון',  v_mtd, 5, 'הצטרפות פנסיה מיטב',           'completed'),
  (v_client3, '28001110000000005', '2024-02-01', 'אחר',     'אחר',     'סיכונים', v_mgd, 1, 'עדכון פרטים אישיים',            'completed'),
  (v_client3, '28001110000000006', '2024-11-01', 'הצעות',   'חיים',    'חיסכון',  v_mnr, 4, 'הצעה לחידוש פוליסת חיים',      'completed'),
  (v_client3, '28001110000000007', '2025-02-01', 'הצטרפות', 'בריאות',  'סיכונים', v_fnx, 3, 'הצטרפות ביטוח סיעוד פניקס',   'completed');

-- Miriam Goldberg — 5 forms
INSERT INTO bafi_forms (client_id, catalog_number, form_date, form_type, domain, branch,
                        insurance_company_id, pages, form_name, status)
VALUES
  (v_client4, '29001110000000001', '2024-04-01', 'הצטרפות', 'פיננסים', 'חיסכון',  v_mnr, 5, 'הצטרפות פנסיה מנורה',          'completed'),
  (v_client4, '29001110000000002', '2024-06-01', 'הצעות',   'חיים',    'סיכונים', v_mgd, 4, 'הצעת ביטוח חיים מגדל',         'completed'),
  (v_client4, '29001110000000003', '2024-09-01', 'הצטרפות', 'חיים',    'סיכונים', v_mgd, 3, 'הצטרפות ביטוח קולקטיב',        'completed'),
  (v_client4, '29001110000000004', '2025-01-01', 'הצעות',   'פיננסים', 'חיסכון',  v_mnr, 4, 'הצעה לחיסכון נוסף',            'in_progress'),
  (v_client4, '29001110000000005', '2025-04-01', 'אחר',     'אחר',     'סיכונים', v_mgd, 1, 'עדכון מוטבים',                  'sent');

-- Yosef Avraham — 5 forms
INSERT INTO bafi_forms (client_id, catalog_number, form_date, form_type, domain, branch,
                        insurance_company_id, pages, form_name, status)
VALUES
  (v_client5, '30001110000000001', '2023-07-01', 'הצטרפות', 'פיננסים', 'חיסכון',  v_mtd, 5, 'הצטרפות לחיסכון פנסיוני',      'completed'),
  (v_client5, '30001110000000002', '2023-10-01', 'הצעות',   'חיים',    'חיסכון',  v_xls, 3, 'הצעה לקרן השתלמות',            'completed'),
  (v_client5, '30001110000000003', '2024-03-01', 'תביעות',  'בריאות',  'סיכונים', v_mnr, 2, 'תביעת ביטוח בריאות',           'completed'),
  (v_client5, '30001110000000004', '2024-08-01', 'הצטרפות', 'פיננסים', 'חיסכון',  v_mtd, 4, 'חידוש קרן פנסיה',              'completed'),
  (v_client5, '30001110000000005', '2025-02-01', 'אחר',     'אחר',     'חיסכון',  v_mtd, 1, 'עדכון סטטוס פנסיה',             'completed');

-- ────────────────────────────────────────────────────────────
-- 7. BAFI_LIFE_COLLECTION
-- ~20 rows for Barko — realistic premium breakdowns.
-- Some last_deposit_date NULL, some recent → checker sees mix.
-- A few rows for other clients too.
-- ────────────────────────────────────────────────────────────

INSERT INTO bafi_life_collection (
  client_id, policy_id, employer_id, policy_number, report_type, product_type,
  premium_month, salary, severance_pay, benefits, disability,
  employer_misc, employer_total, benefit_45, benefit_47,
  employee_disability, employee_misc, employee_total,
  total_pct, total_to_pay, last_deposit_date, last_deposit_amount, last_deposit_notes
)
VALUES
  -- Barko: pension fund (p3) — 6 monthly rows, all deposited
  (v_barko, v_p3, v_emp1, '5-301-887210-3', 'חודשי', 'קרן פנסיה',
   '2026-01-01', 12000, 800, 700, 120, 0, 1620, 700, 0, 120, 0, 820,
   0.1367, 2440, (now() - interval '25 days')::date, 2440, 'העברה בנקאית'),

  (v_barko, v_p3, v_emp1, '5-301-887210-3', 'חודשי', 'קרן פנסיה',
   '2025-12-01', 12000, 800, 700, 120, 0, 1620, 700, 0, 120, 0, 820,
   0.1367, 2440, (now() - interval '55 days')::date, 2440, 'העברה בנקאית'),

  (v_barko, v_p3, v_emp1, '5-301-887210-3', 'חודשי', 'קרן פנסיה',
   '2025-11-01', 12000, 800, 700, 120, 0, 1620, 700, 0, 120, 0, 820,
   0.1367, 2440, (now() - interval '85 days')::date, 2440, 'העברה בנקאית'),

  (v_barko, v_p3, v_emp1, '5-301-887210-3', 'חודשי', 'קרן פנסיה',
   '2025-10-01', 12000, 800, 700, 120, 0, 1620, 700, 0, 120, 0, 820,
   0.1367, 2440, (now() - interval '115 days')::date, 2440, 'העברה בנקאית'),

  (v_barko, v_p3, v_emp1, '5-301-887210-3', 'חודשי', 'קרן פנסיה',
   '2025-09-01', 12000, 800, 700, 120, 0, 1620, 700, 0, 120, 0, 820,
   0.1367, 2440, (now() - interval '145 days')::date, 2440, 'העברה בנקאית'),

  (v_barko, v_p3, v_emp1, '5-301-887210-3', 'חודשי', 'קרן פנסיה',
   '2025-08-01', 12000, 800, 700, 120, 0, 1620, 700, 0, 120, 0, 820,
   0.1367, 2440, (now() - interval '175 days')::date, 2440, 'העברה בנקאית'),

  -- Barko: provident fund (p1) — 4 rows, some no deposit (NULL)
  (v_barko, v_p1, v_emp1, '7-926-663305-0', 'חודשי', 'קרן השתלמות',
   '2026-01-01', 12000, 0, 700, 0, 0, 700, 0, 0, 0, 0, 0,
   0.0583, 700, (now() - interval '20 days')::date, 700, NULL),

  (v_barko, v_p1, v_emp1, '7-926-663305-0', 'חודשי', 'קרן השתלמות',
   '2025-12-01', 12000, 0, 700, 0, 0, 700, 0, 0, 0, 0, 0,
   0.0583, 700, NULL, NULL, 'ממתין לאישור'),

  (v_barko, v_p1, v_emp1, '7-926-663305-0', 'חודשי', 'קרן השתלמות',
   '2025-11-01', 12000, 0, 700, 0, 0, 700, 0, 0, 0, 0, 0,
   0.0583, 700, (now() - interval '80 days')::date, 700, NULL),

  (v_barko, v_p1, v_emp1, '7-926-663305-0', 'חודשי', 'קרן השתלמות',
   '2025-10-01', 12000, 0, 700, 0, 0, 700, 0, 0, 0, 0, 0,
   0.0583, 700, NULL, NULL, 'טרם הופקד'),

  -- Barko: second pension (p4) — 4 rows
  (v_barko, v_p4, v_emp2, '5-301-887211-4', 'חודשי', 'קרן פנסיה',
   '2026-01-01', 15000, 1000, 875, 150, 0, 2025, 875, 0, 150, 0, 1025,
   0.1367, 3050, (now() - interval '18 days')::date, 3050, 'העברה בנקאית'),

  (v_barko, v_p4, v_emp2, '5-301-887211-4', 'חודשי', 'קרן פנסיה',
   '2025-12-01', 15000, 1000, 875, 150, 0, 2025, 875, 0, 150, 0, 1025,
   0.1367, 3050, (now() - interval '48 days')::date, 3050, 'העברה בנקאית'),

  (v_barko, v_p4, v_emp2, '5-301-887211-4', 'חודשי', 'קרן פנסיה',
   '2025-11-01', 15000, 1000, 875, 150, 0, 2025, 875, 0, 150, 0, 1025,
   0.1367, 3050, NULL, NULL, 'בבדיקה'),

  (v_barko, v_p4, v_emp2, '5-301-887211-4', 'חודשי', 'קרן פנסיה',
   '2025-10-01', 15000, 1000, 875, 150, 0, 2025, 875, 0, 150, 0, 1025,
   0.1367, 3050, (now() - interval '108 days')::date, 3050, NULL),

  -- Barko: IRA provident (p9) — 3 rows
  (v_barko, v_p9, v_emp1, '7-926-663307-9', 'חודשי', 'קופת גמל להשקעה',
   '2026-01-01', 12000, 0, 500, 0, 0, 500, 0, 0, 0, 0, 0,
   0.0417, 500, (now() - interval '22 days')::date, 500, NULL),

  (v_barko, v_p9, v_emp1, '7-926-663307-9', 'חודשי', 'קופת גמל להשקעה',
   '2025-12-01', 12000, 0, 500, 0, 0, 500, 0, 0, 0, 0, 0,
   0.0417, 500, NULL, NULL, 'ממתין'),

  (v_barko, v_p9, v_emp1, '7-926-663307-9', 'חודשי', 'קופת גמל להשקעה',
   '2025-11-01', 12000, 0, 500, 0, 0, 500, 0, 0, 0, 0, 0,
   0.0417, 500, (now() - interval '78 days')::date, 500, NULL),

  -- Barko: life policy (p2) — 3 rows
  (v_barko, v_p2, v_emp1, '7-926-663306-1', 'חודשי', 'קופת גמל',
   '2026-01-01', 12000, 0, 600, 0, 0, 600, 0, 0, 0, 0, 0,
   0.0500, 600, (now() - interval '15 days')::date, 600, NULL),

  (v_barko, v_p2, v_emp1, '7-926-663306-1', 'חודשי', 'קופת גמל',
   '2025-12-01', 12000, 0, 600, 0, 0, 600, 0, 0, 0, 0, 0,
   0.0500, 600, (now() - interval '45 days')::date, 600, NULL),

  (v_barko, v_p2, v_emp1, '7-926-663306-1', 'חודשי', 'קופת גמל',
   '2025-11-01', 12000, 0, 600, 0, 0, 600, 0, 0, 0, 0, 0,
   0.0500, 600, NULL, NULL, 'טרם הופקד'),

  -- Sara Levi — 3 rows
  (v_client2, v_p10, v_emp2, '5-301-990011-0', 'חודשי', 'קרן פנסיה',
   '2026-01-01', 10000, 670, 583, 100, 0, 1353, 583, 0, 100, 0, 683,
   0.1367, 2036, (now() - interval '28 days')::date, 2036, NULL),

  (v_client2, v_p10, v_emp2, '5-301-990011-0', 'חודשי', 'קרן פנסיה',
   '2025-12-01', 10000, 670, 583, 100, 0, 1353, 583, 0, 100, 0, 683,
   0.1367, 2036, (now() - interval '58 days')::date, 2036, NULL),

  (v_client2, v_p10, v_emp2, '5-301-990011-0', 'חודשי', 'קרן פנסיה',
   '2025-11-01', 10000, 670, 583, 100, 0, 1353, 583, 0, 100, 0, 683,
   0.1367, 2036, NULL, NULL, 'ממתין'),

  -- David Cohen — 3 rows
  (v_client3, v_p13, v_emp3, '7-926-441100-3', 'חודשי', 'קרן השתלמות',
   '2026-01-01', 18000, 0, 1050, 0, 0, 1050, 0, 0, 0, 0, 0,
   0.0583, 1050, (now() - interval '12 days')::date, 1050, NULL),

  (v_client3, v_p14, v_emp3, '5-301-331122-4', 'חודשי', 'קרן פנסיה',
   '2026-01-01', 18000, 1200, 1050, 180, 0, 2430, 1050, 0, 180, 0, 1230,
   0.1367, 3660, (now() - interval '12 days')::date, 3660, NULL),

  (v_client3, v_p14, v_emp3, '5-301-331122-4', 'חודשי', 'קרן פנסיה',
   '2025-12-01', 18000, 1200, 1050, 180, 0, 2430, 1050, 0, 180, 0, 1230,
   0.1367, 3660, (now() - interval '42 days')::date, 3660, NULL);

-- ────────────────────────────────────────────────────────────
-- 8. BAFI_ELEMENTARY_COLLECTION — 3 rows for Barko (property p8), 2 for Sara
-- ────────────────────────────────────────────────────────────
INSERT INTO bafi_elementary_collection (
  client_id, policy_id, payment_date, doc_number,
  bafi_agent_id, agent_number, insurance_company_id,
  debit, credit, balance, payment_type, notes
)
VALUES
  (v_barko,   v_p8, (now() - interval '3 months')::date,  'DOC-2025-8800',
   v_agt1, 'AGT-1009667', v_ppc,
   1800.00, 0, -1800.00, 'חיוב שנתי', 'חיוב שנתי ביטוח בית'),

  (v_barko,   v_p8, (now() - interval '15 months')::date, 'DOC-2025-7700',
   v_agt1, 'AGT-1009667', v_ppc,
   1750.00, 0, -1750.00, 'חיוב שנתי', 'חיוב שנתי ביטוח בית'),

  (v_barko,   v_p8, (now() - interval '27 months')::date, 'DOC-2023-6600',
   v_agt1, 'AGT-1009667', v_ppc,
   1700.00, 0, -1700.00, 'חיוב שנתי', 'חיוב שנתי ביטוח בית'),

  (v_client2, v_p12, (now() - interval '4 months')::date, 'DOC-2025-5500',
   v_agt2, 'AGT-1009668', v_ppc,
   2400.00, 0, -2400.00, 'חיוב שנתי', 'חיוב שנתי ביטוח רכב'),

  (v_client2, v_p12, (now() - interval '16 months')::date, 'DOC-2024-4400',
   v_agt2, 'AGT-1009668', v_ppc,
   2300.00, 0, -2300.00, 'חיוב שנתי', 'חיוב שנתי ביטוח רכב');

-- ────────────────────────────────────────────────────────────
-- 9. CLAIMS — 1 claim for Barko
-- ────────────────────────────────────────────────────────────
INSERT INTO claims (client_id, policy_id, claim_number, opened_at, status,
                    claim_type, amount, notes)
VALUES
  (v_barko, v_p5, 'CLM-2025-001234', '2025-03-10', 'בטיפול',
   'תביעת נכות', 15000.00, 'תביעה בגין תאונת עבודה — בטיפול חברת מגדל');

END $$;
