-- Field Control Loop (spec section 18).
--
-- The daily rhythm of running guarded sites, moved off WhatsApp voice notes
-- and into records that can be measured: a daily OK report per site, scheduled
-- supervisor/QA visits, no-show -> reliever events, a mobilisation checklist a
-- site launches from, and standing post orders. Everything hangs off a post
-- and inherits that post's region (§1), so it all rolls up to regional ops.

-- ===========================================================================
-- 0. A place for the field-ops cutoff (spec §18: "silent past a cutoff").
-- ===========================================================================

create table if not exists public.field_ops_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  -- After this local time, a site with no OK report today is flagged SILENT.
  daily_report_cutoff time not null default '10:00',
  -- No-shows within this many days count toward "repeat offender".
  repeat_no_show_window_days integer not null default 90,
  repeat_no_show_threshold   integer not null default 3,
  updated_at timestamptz not null default now()
);

insert into public.field_ops_settings (company_id)
select id from public.companies on conflict (company_id) do nothing;

alter table public.field_ops_settings enable row level security;
drop policy if exists "ssa_all" on public.field_ops_settings;
create policy "ssa_all" on public.field_ops_settings for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.field_ops_settings;
create policy "company_members" on public.field_ops_settings for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Region-from-post helper, reused by every table below.
create or replace function public.region_for_post(p_post_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select branch_id from public.posts where id = p_post_id;
$$;

-- ===========================================================================
-- 1. Daily OK report — per site per day.
-- ===========================================================================

create table if not exists public.daily_ok_reports (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  post_id           uuid not null references public.posts(id) on delete cascade,
  client_id         uuid references public.clients(id),
  branch_id         uuid references public.branches(id),
  report_date       date not null default current_date,
  strength_required integer,
  strength_present  integer,
  all_ok            boolean not null default true,
  exception_note    text,
  photo_url         text,
  drive_file_id     text,
  drive_view_url    text,
  submitted_by      uuid,
  submitted_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (post_id, report_date)
);

create index if not exists idx_dor_company_date on public.daily_ok_reports(company_id, report_date);
create index if not exists idx_dor_branch on public.daily_ok_reports(branch_id);

-- ===========================================================================
-- 2. Supervisor visit / QA log.
-- ===========================================================================

do $$ begin
  create type public.visit_status as enum ('scheduled', 'completed', 'missed', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.supervisor_visits (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  post_id               uuid not null references public.posts(id) on delete cascade,
  client_id             uuid references public.clients(id),
  branch_id             uuid references public.branches(id),
  supervisor_employee_id uuid references public.employees(id),
  scheduled_date        date,
  completed_at          timestamptz,
  geo_lat               numeric(9,6),
  geo_lng               numeric(9,6),
  photo_url             text,
  drive_file_id         text,
  drive_view_url        text,
  findings              text,
  corrective_actions    text,
  status                public.visit_status not null default 'scheduled',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_sv_company on public.supervisor_visits(company_id, scheduled_date);
create index if not exists idx_sv_branch on public.supervisor_visits(branch_id);

-- Completing a visit stamps the timestamp automatically.
create or replace function public.stamp_visit_completion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'completed' and new.completed_at is null then
    new.completed_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_visit_completion on public.supervisor_visits;
create trigger trg_visit_completion
  before insert or update of status on public.supervisor_visits
  for each row execute function public.stamp_visit_completion();

-- ===========================================================================
-- 3. No-show -> reliever event.
-- ===========================================================================

create table if not exists public.no_show_events (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id) on delete cascade,
  post_id              uuid references public.posts(id) on delete set null,
  client_id            uuid references public.clients(id),
  branch_id            uuid references public.branches(id),
  employee_id          uuid not null references public.employees(id),  -- the no-show
  shift                text,
  event_date           date not null default current_date,
  flagged_at           timestamptz not null default now(),
  reliever_employee_id uuid references public.employees(id),
  reliever_dispatched_at timestamptz,
  on_post_at           timestamptz,
  notes                text,
  created_at           timestamptz not null default now()
);

create index if not exists idx_nse_company on public.no_show_events(company_id, event_date);
create index if not exists idx_nse_employee on public.no_show_events(employee_id);

-- Reliever-response minutes (on-post minus flagged) and no-show counts, for
-- the KPIs the spec names.
create or replace function public.no_show_count(p_employee_id uuid, p_window_days integer)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::integer from public.no_show_events
   where employee_id = p_employee_id
     and event_date >= current_date - p_window_days;
$$;

-- Repeat offenders feed the disciplinary module: raise a warning from a
-- no-show, reusing §12's three-warning engine.
create or replace function public.warn_repeat_no_show(p_employee_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s        record;
  v_company uuid;
  v_count  integer;
  v_id     uuid;
begin
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;
  select * into s from public.field_ops_settings where company_id = v_company;

  v_count := public.no_show_count(p_employee_id, coalesce(s.repeat_no_show_window_days, 90));
  if v_count < coalesce(s.repeat_no_show_threshold, 3) then
    return null;  -- not yet a repeat offender
  end if;

  insert into public.disciplinary_warnings (company_id, employee_id, reason)
  values (v_company, p_employee_id,
          'Repeat no-shows: ' || v_count || ' in the last '
          || coalesce(s.repeat_no_show_window_days,90) || ' days')
  returning id into v_id;
  return v_id;
end;
$$;

-- ===========================================================================
-- 4. Standing post orders.
-- ===========================================================================

create table if not exists public.post_orders (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  post_id        uuid not null references public.posts(id) on delete cascade,
  branch_id      uuid references public.branches(id),
  version        integer not null default 1,
  title          text,
  body           text not null,
  effective_from date not null default current_date,
  active         boolean not null default true,
  created_by     uuid,
  created_at     timestamptz not null default now()
);

create index if not exists idx_po_post on public.post_orders(post_id) where active;

-- ===========================================================================
-- 5. New-contract mobilisation checklist — a site launches from it.
-- ===========================================================================

do $$ begin
  create type public.mobilisation_step as enum
    ('guards_assigned', 'vetting_cleared', 'kit_issued', 'post_orders_written', 'client_noc');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.mobilisation_status as enum
    ('pending', 'in_progress', 'launched', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.contract_mobilisations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  contract_id  uuid not null references public.contracts(id) on delete cascade,
  post_id      uuid references public.posts(id),
  branch_id    uuid references public.branches(id),
  status       public.mobilisation_status not null default 'pending',
  launched_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (contract_id)
);

create table if not exists public.contract_mobilisation_items (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  mobilisation_id  uuid not null references public.contract_mobilisations(id) on delete cascade,
  step             public.mobilisation_step not null,
  done             boolean not null default false,
  done_at          timestamptz,
  done_by          uuid,
  notes            text,
  unique (mobilisation_id, step)
);

create index if not exists idx_cm_company on public.contract_mobilisations(company_id);
create index if not exists idx_cmi_mob on public.contract_mobilisation_items(mobilisation_id);

-- Seed all five steps whenever a mobilisation is created (checklist semantics).
create or replace function public.seed_mobilisation_items()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.contract_mobilisation_items (company_id, mobilisation_id, step)
  select new.company_id, new.id, s
    from unnest(enum_range(null::public.mobilisation_step)) s
  on conflict (mobilisation_id, step) do nothing;
  return null;
end;
$$;

drop trigger if exists trg_cm_seed_items on public.contract_mobilisations;
create trigger trg_cm_seed_items
  after insert on public.contract_mobilisations
  for each row execute function public.seed_mobilisation_items();

-- Ticking an item stamps who/when.
create or replace function public.stamp_mobilisation_item()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.done and not old.done then
    new.done_at := now();
    new.done_by := auth.uid();
  elsif not new.done then
    new.done_at := null; new.done_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cmi_stamp on public.contract_mobilisation_items;
create trigger trg_cmi_stamp
  before update of done on public.contract_mobilisation_items
  for each row execute function public.stamp_mobilisation_item();

-- Launch gate: a site cannot go live until every checklist item is done.
create or replace function public.launch_site(p_mobilisation_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_open integer;
begin
  select count(*) into v_open
    from public.contract_mobilisation_items
   where mobilisation_id = p_mobilisation_id and not done;
  if v_open > 0 then
    raise exception 'cannot launch: % mobilisation step(s) still open', v_open
      using errcode = '23514',
            hint = 'Complete guards, vetting, kit, post orders and client NOC first.';
  end if;

  update public.contract_mobilisations
     set status = 'launched', launched_at = now(), updated_at = now()
   where id = p_mobilisation_id;
  if not found then
    raise exception 'mobilisation % not found', p_mobilisation_id using errcode = '23503';
  end if;
end;
$$;

-- ===========================================================================
-- 6. Incident additions (spec §18): link to the report/visit that surfaced
--    it, and a corrective-action follow-up with a due date.
-- ===========================================================================

do $$ begin
  create type public.corrective_action_status as enum ('open', 'in_progress', 'done');
exception when duplicate_object then null; end $$;

alter table public.incidents
  add column if not exists source_daily_report_id uuid references public.daily_ok_reports(id),
  add column if not exists source_visit_id        uuid references public.supervisor_visits(id),
  add column if not exists corrective_action_due_date date,
  add column if not exists corrective_action_status  public.corrective_action_status,
  add column if not exists corrective_action_owner    uuid;

-- ===========================================================================
-- 7. Plumbing: company autofill, RLS, and region-from-post for the new tables.
-- ===========================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'daily_ok_reports', 'supervisor_visits', 'no_show_events', 'post_orders',
    'contract_mobilisations', 'contract_mobilisation_items'
  ] loop
    execute format('drop trigger if exists trg_aaa_%1$s_fill_company on public.%1$s', t);
    execute format('create trigger trg_aaa_%1$s_fill_company before insert on public.%1$s
                      for each row execute function public.fill_company_id()', t);
    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists "ssa_all" on public.%1$s', t);
    execute format('create policy "ssa_all" on public.%1$s for all
                      using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped())', t);
    execute format('drop policy if exists "company_members" on public.%1$s', t);
    execute format('create policy "company_members" on public.%1$s for all
                      using (company_id = public.current_company_id())
                      with check (company_id = public.current_company_id())', t);
  end loop;
end$$;

-- Region inheritance from the post (or client) for the post-linked tables.
create or replace function public.inherit_region_from_post()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(
    public.region_for_post(new.post_id),
    public.region_for_client(new.client_id),
    public.head_office_region(new.company_id));
  return new;
end;
$$;

drop trigger if exists trg_bbb_dor_region on public.daily_ok_reports;
create trigger trg_bbb_dor_region
  before insert or update of post_id, client_id, company_id on public.daily_ok_reports
  for each row execute function public.inherit_region_from_post();

drop trigger if exists trg_bbb_sv_region on public.supervisor_visits;
create trigger trg_bbb_sv_region
  before insert or update of post_id, client_id, company_id on public.supervisor_visits
  for each row execute function public.inherit_region_from_post();

drop trigger if exists trg_bbb_nse_region on public.no_show_events;
create trigger trg_bbb_nse_region
  before insert or update of post_id, client_id, company_id on public.no_show_events
  for each row execute function public.inherit_region_from_post();

drop trigger if exists trg_bbb_po_region on public.post_orders;
create trigger trg_bbb_po_region
  before insert or update of post_id, company_id on public.post_orders
  for each row execute function public.inherit_region_from_post();

-- Mobilisation inherits from its post, else its contract's client.
create or replace function public.inherit_region_mobilisation()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_region uuid;
begin
  select coalesce(public.region_for_post(new.post_id),
                  (select cl.branch_id from public.contracts c
                     join public.clients cl on cl.id = c.client_id
                    where c.id = new.contract_id))
    into v_region;
  new.branch_id := coalesce(v_region, public.head_office_region(new.company_id));
  return new;
end;
$$;

drop trigger if exists trg_bbb_cm_region on public.contract_mobilisations;
create trigger trg_bbb_cm_region
  before insert or update of post_id, contract_id, company_id on public.contract_mobilisations
  for each row execute function public.inherit_region_mobilisation();

-- ===========================================================================
-- 8. Silent-sites dashboard: active posts vs whether they reported today.
--    Silence past the cutoff is the alert.
-- ===========================================================================

create or replace view public.daily_report_status
  with (security_invoker = true) as
  select p.company_id,
         p.id as post_id,
         p.name as post_name,
         p.client_id,
         p.branch_id,
         b.name as region_name,
         (r.id is not null) as reported_today,
         r.all_ok,
         r.strength_present,
         r.strength_required,
         r.submitted_at,
         fos.daily_report_cutoff,
         -- Silent = active post, no report today, and we are past the cutoff.
         (r.id is null
            and (current_time > fos.daily_report_cutoff)) as is_silent
    from public.posts p
    left join public.branches b on b.id = p.branch_id
    left join public.field_ops_settings fos on fos.company_id = p.company_id
    left join public.daily_ok_reports r
           on r.post_id = p.id and r.report_date = current_date
   where p.active;
