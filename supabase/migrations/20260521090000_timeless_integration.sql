-- ============================================================
-- Migration: timeless_integration
-- Description: Extend meetings table with a Timeless meeting ID
--              and create a holding table for Timeless meetings
--              that could not be auto-matched to a meetings row.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Extend meetings
-- ────────────────────────────────────────────────────────────
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS timeless_meeting_id text UNIQUE;

CREATE INDEX IF NOT EXISTS idx_meetings_timeless_id
  ON meetings (timeless_meeting_id)
  WHERE timeless_meeting_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 2. Unmatched-meetings holding table
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS timeless_unmatched_meetings (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  timeless_meeting_id    text        UNIQUE NOT NULL,
  start_time             timestamptz NOT NULL,
  participants           jsonb       NOT NULL,
  host_email             text,
  candidate_meeting_ids  uuid[]      DEFAULT '{}',
  reason                 text        NOT NULL CHECK (reason IN ('no_candidates', 'low_score', 'ambiguous')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz,
  resolved_to_meeting_id uuid        REFERENCES meetings(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_timeless_unmatched_created
  ON timeless_unmatched_meetings (created_at DESC)
  WHERE resolved_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- 3. Row Level Security — admin-only (mirrors gmail_integrations)
-- ────────────────────────────────────────────────────────────
ALTER TABLE timeless_unmatched_meetings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin select timeless_unmatched_meetings"
  ON timeless_unmatched_meetings FOR SELECT TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin insert timeless_unmatched_meetings"
  ON timeless_unmatched_meetings FOR INSERT TO authenticated
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin update timeless_unmatched_meetings"
  ON timeless_unmatched_meetings FOR UPDATE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin')
  WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

CREATE POLICY "admin delete timeless_unmatched_meetings"
  ON timeless_unmatched_meetings FOR DELETE TO authenticated
  USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');
