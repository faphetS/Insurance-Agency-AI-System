ALTER TABLE public.meetings DROP CONSTRAINT meetings_type_check;
ALTER TABLE public.meetings ADD CONSTRAINT meetings_type_check
  CHECK (type IN ('zoom', 'phone', 'in_person', 'google_meet'));
