-- ============================================================
-- Migration: system_settings_rls
-- Description: Enable Row Level Security on system_settings. The
--              table holds sensitive values (e.g. the Timeless
--              webhook HMAC secret). With RLS enabled and NO
--              policies, only the service-role server (which
--              bypasses RLS) can read/write it; the public anon
--              key can no longer access it via the Data API.
-- ============================================================

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
