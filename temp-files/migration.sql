-- =============================================
-- Insurance Agency AI System - Initial Schema
-- =============================================

-- Section 1: Staff table
create table public.staff (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  email       text not null,
  phone       text,
  role        text not null default 'agent'
              check (role in ('owner', 'admin', 'agent')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.staff is 'Agency staff members (1:1 with auth.users)';

-- Section 2: Clients table
create table public.clients (
  id                uuid primary key default gen_random_uuid(),
  full_name         text not null,
  phone             text not null,
  email             text,
  id_photo_url      text,
  id_validated      boolean not null default false,
  poa_doc_url       text,
  inquiry_type      text not null
                    check (inquiry_type in (
                      'life','health','property','vehicle',
                      'liability','business','pension','travel',
                      'mortgage','general'
                    )),
  status            text not null default 'new'
                    check (status in ('new','active','completed')),
  assigned_to       uuid not null references public.staff(id),
  source_channel    text not null
                    check (source_channel in ('wa','email')),
  last_service_date date,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.clients is 'Insurance agency clients (leads and active)';

-- Section 3: Meetings table
create table public.meetings (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients(id) on delete cascade,
  type               text not null
                     check (type in ('zoom','phone','in_person')),
  scheduled_at       timestamptz not null,
  calendar_event_id  text,
  recording_url      text,
  transcript         text,
  summary_draft      text,
  summary_final      text,
  summary_status     text not null default 'draft'
                     check (summary_status in ('draft','approved','sent')),
  client_confirmed   boolean not null default false,
  status             text not null default 'scheduled'
                     check (status in ('scheduled','done','cancelled')),
  reminder_24h_sent  boolean not null default false,
  reminder_1h_sent   boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.meetings is 'Client meetings (zoom, phone, in-person)';

-- Section 4: Tasks table
create table public.tasks (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  meeting_id      uuid references public.meetings(id) on delete set null,
  type            text not null
                  check (type in (
                    'forms_check','receipt_check','policy_check',
                    'deposit_check','cross_check','service_meeting','general'
                  )),
  description     text not null,
  assigned_to     uuid not null references public.staff(id),
  due_at          timestamptz not null,
  status          text not null default 'pending'
                  check (status in ('pending','done','overdue')),
  reminder_sent   boolean not null default false,
  parent_task_id  uuid references public.tasks(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.tasks is 'Trackable tasks linked to clients and optionally meetings';

-- Section 5: Documents table
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  meeting_id    uuid references public.meetings(id) on delete set null,
  type          text not null
                check (type in ('id_photo','poa','policy','receipt','recording','form','other')),
  file_url      text not null,
  file_name     text,
  mime_type     text,
  uploaded_by   uuid references public.staff(id),
  created_at    timestamptz not null default now()
);

comment on table public.documents is 'File/document metadata linked to clients and meetings';

-- Section 6: Audit Logs table
create table public.audit_logs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.staff(id) on delete set null,
  action       text not null,
  status_code  int,
  ip_address   text,
  user_agent   text,
  request_id   text,
  timestamp    timestamptz not null default now()
);

comment on table public.audit_logs is 'HTTP mutation audit trail (written by Express middleware)';

-- Section 7: Indexes
create index idx_clients_assigned_to on public.clients (assigned_to);
create index idx_clients_status on public.clients (status);
create index idx_clients_created_at on public.clients (created_at desc);
create index idx_meetings_client_id on public.meetings (client_id);
create index idx_meetings_scheduled_at on public.meetings (scheduled_at);
create index idx_meetings_status on public.meetings (status);
create index idx_tasks_client_id on public.tasks (client_id);
create index idx_tasks_meeting_id on public.tasks (meeting_id);
create index idx_tasks_assigned_to on public.tasks (assigned_to);
create index idx_tasks_parent_task_id on public.tasks (parent_task_id);
create index idx_tasks_status on public.tasks (status);
create index idx_tasks_due_at on public.tasks (due_at);
create index idx_documents_client_id on public.documents (client_id);
create index idx_documents_meeting_id on public.documents (meeting_id);
create index idx_audit_logs_user_id on public.audit_logs (user_id);
create index idx_audit_logs_timestamp on public.audit_logs (timestamp desc);

-- Partial indexes for hot query paths
create index idx_tasks_pending on public.tasks (due_at) where status in ('pending','overdue');
create index idx_meetings_pending_reminders on public.meetings (scheduled_at) where status = 'scheduled' and (reminder_24h_sent = false or reminder_1h_sent = false);
create index idx_clients_active on public.clients (assigned_to, created_at desc) where status != 'completed';
create index idx_clients_new on public.clients (created_at desc) where status = 'new';

-- Section 8: updated_at trigger
create or replace function public.handle_updated_at()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at before update on public.staff
  for each row execute function public.handle_updated_at();
create trigger set_updated_at before update on public.clients
  for each row execute function public.handle_updated_at();
create trigger set_updated_at before update on public.meetings
  for each row execute function public.handle_updated_at();
create trigger set_updated_at before update on public.tasks
  for each row execute function public.handle_updated_at();

-- Section 9: RLS
alter table public.staff enable row level security;
alter table public.clients enable row level security;
alter table public.meetings enable row level security;
alter table public.tasks enable row level security;
alter table public.documents enable row level security;
alter table public.audit_logs enable row level security;

create policy "Staff read staff" on public.staff for select to authenticated using (true);
create policy "Staff read clients" on public.clients for select to authenticated using (true);
create policy "Staff insert clients" on public.clients for insert to authenticated with check (true);
create policy "Staff update assigned clients" on public.clients for update to authenticated using ((select auth.uid()) = assigned_to);
create policy "Staff read meetings" on public.meetings for select to authenticated using (true);
create policy "Staff manage meetings" on public.meetings for all to authenticated using (true);
create policy "Staff read tasks" on public.tasks for select to authenticated using (true);
create policy "Staff insert tasks" on public.tasks for insert to authenticated with check (true);
create policy "Staff update assigned tasks" on public.tasks for update to authenticated using ((select auth.uid()) = assigned_to);
create policy "Staff read documents" on public.documents for select to authenticated using (true);
create policy "Staff upload documents" on public.documents for insert to authenticated with check (true);
create policy "Staff read audit logs" on public.audit_logs for select to authenticated using (true);

-- Section 10: Storage buckets
insert into storage.buckets (id, name, public)
values ('client-documents', 'client-documents', false),
       ('meeting-recordings', 'meeting-recordings', false);
