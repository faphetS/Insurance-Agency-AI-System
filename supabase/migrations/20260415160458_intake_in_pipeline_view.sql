-- Migration: intake_in_pipeline_view
-- Re-creates v_client_pipeline to expose intake_state and intake_current_slot

create or replace view public.v_client_pipeline as
 SELECT id,
    full_name,
    phone,
    email,
    id_photo_url,
    id_validated,
    poa_doc_url,
    inquiry_type,
    status,
    assigned_to,
    source_channel,
    last_service_date,
    notes,
    created_at,
    updated_at,
    pipeline_stage,
    ( SELECT m.scheduled_at
           FROM meetings m
          WHERE (m.client_id = c.id)
          ORDER BY m.scheduled_at DESC
         LIMIT 1) AS latest_meeting_start_at,
    ( SELECT (count(*))::integer AS count
           FROM tasks t
          WHERE ((t.client_id = c.id) AND (t.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])))) AS open_tasks_count,
        CASE
            WHEN (pipeline_stage IS NOT NULL) THEN pipeline_stage
            WHEN (status = 'completed'::text) THEN 'completed'::text
            WHEN (status = 'new'::text) THEN 'new_lead'::text
            WHEN ((status = 'active'::text) AND (( SELECT count(*) AS count
               FROM meetings m
              WHERE ((m.client_id = c.id) AND (m.status = ANY (ARRAY['scheduled'::text, 'confirmed'::text])))) > 0)) THEN 'meeting_scheduled'::text
            WHEN ((status = 'active'::text) AND (( SELECT count(*) AS count
               FROM meetings m
              WHERE (m.client_id = c.id)) = 0)) THEN 'meeting_scheduling'::text
            WHEN ((status = 'active'::text) AND (( SELECT count(*) AS count
               FROM tasks t
              WHERE ((t.client_id = c.id) AND (t.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])))) > 0)) THEN 'docs_pending'::text
            ELSE 'active'::text
        END AS derived_stage,
    (EXTRACT(epoch FROM (now() - updated_at)) / 3600.0) AS time_in_stage_hours,
        CASE
            WHEN ((COALESCE(pipeline_stage, 'new_lead'::text) = 'awaiting_approval'::text) AND ((EXTRACT(epoch FROM (now() - updated_at)) / 3600.0) > (24)::numeric)) THEN true
            WHEN ((COALESCE(pipeline_stage,
            CASE
                WHEN (( SELECT count(*) AS count
                   FROM meetings m
                  WHERE ((m.client_id = c.id) AND (m.status = ANY (ARRAY['scheduled'::text, 'confirmed'::text])))) > 0) THEN 'meeting_scheduled'::text
                ELSE NULL::text
            END) = 'meeting_scheduled'::text) AND (( SELECT count(*) AS count
               FROM meetings m
              WHERE ((m.client_id = c.id) AND (m.client_confirmed = true))) = 0) AND ((EXTRACT(epoch FROM (now() - updated_at)) / 3600.0) > (4)::numeric)) THEN true
            ELSE false
        END AS sla_breached,
    -- New intake columns
    c.intake_state,
    c.intake_current_slot
   FROM clients c;
