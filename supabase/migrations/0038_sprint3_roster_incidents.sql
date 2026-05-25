-- Sprint 3 — Security-specific differentiators:
--   - Posts (deployment sites)
--   - Deployment Roster (planned employee assignments)
--   - Incidents (structured log with guard cross-refs)
--   - Attendance enhancements (half-day, late, overtime)

-- ---------------------------------------------------------------------------
-- 1. Posts (deployment sites)
-- A post is a guarded location belonging to a client. Distinct from a Branch
-- (internal company branch) and from a Location (legacy free-form label).
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  client_id        uuid not null references public.clients(id) on delete cascade,
  branch_id        uuid references public.branches(id) on delete set null,
  contract_id      uuid references public.contracts(id) on delete set null,
  name             text not null,
  address          text,
  required_guards  integer not null default 1,
  shift_pattern    contract_shift_pattern not null default 'day',
  active           boolean not null default true,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_posts_company on public.posts(company_id);
create index if not exists idx_posts_client on public.posts(client_id);
create index if not exists idx_posts_active on public.posts(active);

drop trigger if exists trg_aaa_posts_fill_company on public.posts;
create trigger trg_aaa_posts_fill_company
  before insert on public.posts
  for each row execute function public.fill_company_id();

drop trigger if exists trg_posts_updated_at on public.posts;
create trigger trg_posts_updated_at
  before update on public.posts
  for each row execute function public.touch_updated_at();

alter table public.posts enable row level security;
drop policy if exists "ssa_all" on public.posts;
create policy "ssa_all" on public.posts for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.posts;
create policy "company_members" on public.posts for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 2. Deployment Roster
-- One row per (employee, date) — the planned assignment. Distinct from
-- attendance_records (which is the "what actually happened" log).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'roster_status') then
    create type roster_status as enum (
      'assigned', 'confirmed', 'leave_requested', 'reliever_needed', 'unassigned'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'roster_shift') then
    create type roster_shift as enum ('day', 'night');
  end if;
end$$;

create table if not exists public.roster_assignments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  post_id         uuid references public.posts(id) on delete set null,
  client_id       uuid references public.clients(id) on delete set null,
  assignment_date date not null,
  shift           roster_shift not null default 'day',
  status          roster_status not null default 'assigned',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Spec: one assignment per employee per date per shift.
  unique (employee_id, assignment_date, shift)
);

create index if not exists idx_roster_company on public.roster_assignments(company_id);
create index if not exists idx_roster_date on public.roster_assignments(assignment_date);
create index if not exists idx_roster_employee on public.roster_assignments(employee_id);
create index if not exists idx_roster_post on public.roster_assignments(post_id);
create index if not exists idx_roster_status on public.roster_assignments(status);

drop trigger if exists trg_aaa_roster_fill_company on public.roster_assignments;
create trigger trg_aaa_roster_fill_company
  before insert on public.roster_assignments
  for each row execute function public.fill_company_id();

drop trigger if exists trg_roster_updated_at on public.roster_assignments;
create trigger trg_roster_updated_at
  before update on public.roster_assignments
  for each row execute function public.touch_updated_at();

alter table public.roster_assignments enable row level security;
drop policy if exists "ssa_all" on public.roster_assignments;
create policy "ssa_all" on public.roster_assignments for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.roster_assignments;
create policy "company_members" on public.roster_assignments for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 3. Incidents (spec section 4.2)
-- Structured log with multi-guard cross-ref via incident_guards.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'incident_severity') then
    create type incident_severity as enum ('low', 'medium', 'high', 'critical');
  end if;
  if not exists (select 1 from pg_type where typname = 'incident_category') then
    create type incident_category as enum (
      'theft', 'altercation', 'guard_injury', 'weapon_discharge',
      'no_show', 'asset_damage', 'client_complaint', 'other'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'incident_status') then
    create type incident_status as enum (
      'open', 'under_investigation', 'resolved', 'closed'
    );
  end if;
end$$;

alter table public.company_counters
  add column if not exists next_incident_seq integer not null default 1;

create table if not exists public.incidents (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  incident_code     text,
  occurred_at       timestamptz not null default now(),
  client_id         uuid references public.clients(id) on delete set null,
  post_id           uuid references public.posts(id) on delete set null,
  severity          incident_severity not null default 'medium',
  category          incident_category not null default 'other',
  description       text,
  client_notified   boolean not null default false,
  client_notified_at date,
  action_taken      text,
  status            incident_status not null default 'open',
  -- Single attachment (Drive). For multiple, normalize later.
  drive_file_id     text,
  drive_view_url    text,
  attachment_file_name text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_incidents_company on public.incidents(company_id);
create index if not exists idx_incidents_client on public.incidents(client_id);
create index if not exists idx_incidents_severity on public.incidents(severity);
create index if not exists idx_incidents_status on public.incidents(status);
create index if not exists idx_incidents_occurred on public.incidents(occurred_at);

create or replace function public.assign_incident_code()
returns trigger language plpgsql as $$
declare
  next_seq integer;
begin
  if new.incident_code is null or new.incident_code = '' then
    update public.company_counters
       set next_incident_seq = next_incident_seq + 1
     where company_id = new.company_id
     returning next_incident_seq - 1 into next_seq;
    if next_seq is null then
      insert into public.company_counters (company_id, next_incident_seq)
        values (new.company_id, 2)
        on conflict (company_id) do update set next_incident_seq = company_counters.next_incident_seq + 1
        returning next_incident_seq - 1 into next_seq;
    end if;
    new.incident_code := 'INC-' || lpad(next_seq::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_incidents_code on public.incidents;
create trigger trg_incidents_code
  before insert on public.incidents
  for each row execute function public.assign_incident_code();

drop trigger if exists trg_aaa_incidents_fill_company on public.incidents;
create trigger trg_aaa_incidents_fill_company
  before insert on public.incidents
  for each row execute function public.fill_company_id();

drop trigger if exists trg_incidents_updated_at on public.incidents;
create trigger trg_incidents_updated_at
  before update on public.incidents
  for each row execute function public.touch_updated_at();

alter table public.incidents enable row level security;
drop policy if exists "ssa_all" on public.incidents;
create policy "ssa_all" on public.incidents for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.incidents;
create policy "company_members" on public.incidents for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Incident <-> Guards junction (many-to-many)
create table if not exists public.incident_guards (
  incident_id  uuid not null references public.incidents(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  primary key (incident_id, employee_id)
);

create index if not exists idx_incident_guards_emp on public.incident_guards(employee_id);

alter table public.incident_guards enable row level security;
-- Visibility follows the parent incident's RLS via the FK + cascade.
drop policy if exists "ssa_all" on public.incident_guards;
create policy "ssa_all" on public.incident_guards for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "via_incident" on public.incident_guards;
create policy "via_incident" on public.incident_guards for all
  using (exists (
    select 1 from public.incidents i
    where i.id = incident_id
      and i.company_id = public.current_company_id()
  ))
  with check (exists (
    select 1 from public.incidents i
    where i.id = incident_id
      and i.company_id = public.current_company_id()
  ));

-- ---------------------------------------------------------------------------
-- 4. Attendance enhancements (spec section 3.4)
-- ---------------------------------------------------------------------------
alter table public.attendance_records
  add column if not exists half_day        boolean not null default false,
  add column if not exists late_arrival    boolean not null default false,
  add column if not exists hours_worked    numeric(5,2),
  add column if not exists overtime_hours  numeric(5,2) not null default 0;
