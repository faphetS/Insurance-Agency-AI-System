-- Backfill clients rows for WhatsApp conversations that have no client_id yet.
-- For each unlinked conversation, insert a clients row and update conversations.client_id.
-- Idempotent: the outer WHERE client_id IS NULL guard prevents double-inserts on re-run.

DO $$
DECLARE
  conv RECORD;
  new_client_id UUID;
  owner_staff_id UUID := '550df538-8f17-47d8-bf43-c83abb504953';
BEGIN
  FOR conv IN
    SELECT id, contact_name, contact_phone
    FROM public.conversations
    WHERE client_id IS NULL
  LOOP
    INSERT INTO public.clients (
      full_name,
      phone,
      status,
      pipeline_stage,
      source_channel,
      inquiry_type,
      id_validated,
      assigned_to
    )
    VALUES (
      COALESCE(NULLIF(TRIM(conv.contact_name), ''), conv.contact_phone),
      conv.contact_phone,
      'new',
      'new_lead',
      'wa',
      'general',
      false,
      owner_staff_id
    )
    RETURNING id INTO new_client_id;

    UPDATE public.conversations
    SET client_id = new_client_id
    WHERE id = conv.id
      AND client_id IS NULL; -- extra guard: only update if still unlinked
  END LOOP;
END;
$$;
