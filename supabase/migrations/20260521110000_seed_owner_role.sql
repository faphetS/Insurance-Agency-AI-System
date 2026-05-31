-- ============================================================
-- Migration: seed_owner_role
-- Description: Designate the agency principal (Didi Friedlander)
--              as the 'owner' so the daily digest / missed-inquiry
--              alerts can resolve the owner recipient. There is no
--              CHECK constraint on staff.role. This affects only
--              digest owner-resolution, NOT API authorization
--              (which reads the JWT app_metadata.role).
-- ============================================================

UPDATE public.staff
SET role       = 'owner',
    updated_at = now()
WHERE id = 'baf10001-0000-0000-0000-000000000001';  -- Didi Friedlander
