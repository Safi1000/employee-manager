-- Compliance Process Engine (spec section 19).
--
-- Every licence / renewal / NOC becomes a CASE that moves through stages, with
-- a visit log recording each government trip. Cases are tracked per
-- jurisdiction (ICT and Punjab chains run separately, each with its own
-- renewals and lead times). A statutory filing tracker covers EOBI / social
-- security / withholding — due, filed, paid, evidence. The existing compliance
-- calendar and licence watch-lists stay; a couple of views sit on top.

-- ===========================================================================
-- 1. Cases
-- ===========================================================================

do $$ begin
  create type public.compliance_jurisdiction as enum
    ('ict', 'punjab', 'federal', 'sindh', 'kpk', 'balochistan', 'ajk', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.compliance_case_type as enum
    ('licence', 'renewal', 'noc', 'registration', 'other');
exception when duplicate_object then null; end $$;

-- The stage machine the spec lists.
do $$ begin
  create type public.compliance_stage as enum
    ('not_started', 'submitted', 'verification', 'follow_up', 'issued');
exception when duplicate_object then null; end $$;

create table if not exists public.compliance_cases (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  branch_id     uuid references public.branches(id),
  case_type     public.compliance_case_type not null,
  jurisdiction  public.compliance_jurisdiction not null,
  title         text not null,
  authority     text,
  stage         public.compliance_stage not null default 'not_started',
  owner_id      uuid,                 -- profile responsible
  target_date   date,
  lead_time_days integer,             -- typical processing time for this chain
  submitted_date date,
  issued_date    date,
  reference_no   text,
  -- Renewal chain link: a renewal points at the case it renews, so a licence's
  -- history is one thread rather than scattered rows.
  renews_case_id uuid references public.compliance_cases(id),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_cc_company on public.compliance_cases(company_id, stage);
create index if not exists idx_cc_jurisdiction on public.compliance_cases(company_id, jurisdiction);
create index if not exists idx_cc_target on public.compliance_cases(company_id, target_date);

-- Stamp stage dates as the case advances.
create or replace function public.stamp_compliance_stage()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.stage = 'submitted' and new.submitted_date is null then
    new.submitted_date := current_date;
  end if;
  if new.stage = 'issued' and new.issued_date is null then
    new.issued_date := current_date;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_cc_stage on public.compliance_cases;
create trigger trg_cc_stage
  before insert or update of stage on public.compliance_cases
  for each row execute function public.stamp_compliance_stage();

-- ===========================================================================
-- 2. Visit log — one row per government trip.
-- ===========================================================================

create table if not exists public.compliance_case_visits (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  case_id          uuid not null references public.compliance_cases(id) on delete cascade,
  visit_date       date not null default current_date,
  outcome          text,
  next_action      text,
  next_action_date date,
  logged_by        uuid,
  created_at       timestamptz not null default now()
);

create index if not exists idx_ccv_case on public.compliance_case_visits(case_id, visit_date);

-- ===========================================================================
-- 3. Statutory filing tracker.
-- ===========================================================================

do $$ begin
  create type public.statutory_filing_type as enum
    ('eobi', 'social_security', 'withholding_tax', 'income_tax', 'other');
exception when duplicate_object then null; end $$;

create table if not exists public.statutory_filings (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  branch_id     uuid references public.branches(id),
  filing_type   public.statutory_filing_type not null,
  period_month  date not null,
  due_date      date not null,
  filed_date    date,
  paid_date     date,
  amount        numeric(16,2),
  reference_no  text,
  evidence_drive_file_id text,
  evidence_drive_view_url text,
  owner_id      uuid,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_sf_company on public.statutory_filings(company_id, due_date);

-- One filing per company/type/period/region (expression uniqueness needs an
-- index; a table UNIQUE can't hold coalesce). Null branch treated as a sentinel.
create unique index if not exists idx_sf_unique
  on public.statutory_filings (company_id, filing_type, period_month,
                               coalesce(branch_id, '00000000-0000-0000-0000-000000000000'));

-- Derived status: paid > filed > (overdue if past due) > pending.
create or replace function public.statutory_filing_status(
  p_filed date, p_paid date, p_due date)
returns text language sql immutable set search_path = public as $$
  select case
    when p_paid is not null then 'paid'
    when p_filed is not null then 'filed'
    when p_due < current_date then 'overdue'
    else 'pending'
  end;
$$;

-- ===========================================================================
-- 4. Plumbing: company autofill + RLS
-- ===========================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'compliance_cases', 'compliance_case_visits', 'statutory_filings'
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

-- Compliance is a head-office function (§2): default a case with no region to
-- head office rather than leaving it untagged.
create or replace function public.inherit_region_compliance()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(new.branch_id, public.head_office_region(new.company_id));
  return new;
end;
$$;

drop trigger if exists trg_bbb_cc_region on public.compliance_cases;
create trigger trg_bbb_cc_region
  before insert or update of company_id on public.compliance_cases
  for each row execute function public.inherit_region_compliance();

drop trigger if exists trg_bbb_sf_region on public.statutory_filings;
create trigger trg_bbb_sf_region
  before insert or update of company_id on public.statutory_filings
  for each row execute function public.inherit_region_compliance();

-- ===========================================================================
-- 5. Views on top: weekly review, dual-jurisdiction register, unified upcoming
--    compliance calendar (cases + filings + licence expiries).
-- ===========================================================================

-- Weekly review: open cases with their latest visit and how they stand.
create or replace view public.compliance_weekly_review
  with (security_invoker = true) as
  select c.id as case_id,
         c.company_id,
         c.branch_id,
         c.jurisdiction,
         c.case_type,
         c.title,
         c.authority,
         c.stage,
         c.owner_id,
         c.target_date,
         (c.target_date is not null and c.target_date < current_date and c.stage <> 'issued') as overdue,
         lv.visit_date  as last_visit_date,
         lv.outcome     as last_outcome,
         lv.next_action,
         lv.next_action_date
    from public.compliance_cases c
    left join lateral (
      select v.* from public.compliance_case_visits v
       where v.case_id = c.id
       order by v.visit_date desc, v.created_at desc
       limit 1
    ) lv on true
   where c.stage <> 'issued';

-- Dual-jurisdiction register: case counts and next deadline per jurisdiction.
create or replace view public.compliance_jurisdiction_register
  with (security_invoker = true) as
  select company_id,
         jurisdiction,
         count(*)                                            as total_cases,
         count(*) filter (where stage <> 'issued')           as open_cases,
         count(*) filter (where target_date < current_date
                            and stage <> 'issued')            as overdue_cases,
         min(target_date) filter (where stage <> 'issued')   as next_target_date
    from public.compliance_cases
   group by company_id, jurisdiction;

-- One upcoming-deadline feed the calendar can render: open compliance cases,
-- unpaid/unfiled statutory filings, and staff licence expiries.
create or replace view public.compliance_upcoming
  with (security_invoker = true) as
  select company_id, branch_id, 'case'::text as kind, id as ref_id,
         title as label, target_date as due_date
    from public.compliance_cases
   where stage <> 'issued' and target_date is not null
  union all
  select company_id, branch_id, 'statutory_filing', id,
         filing_type::text, due_date
    from public.statutory_filings
   where paid_date is null
  union all
  select company_id, branch_id, 'weapon_licence', id,
         'Weapon licence — ' || full_name, weapon_licence_expiry
    from public.employees
   where weapon_licence_expiry is not null and lifecycle_state = 'active'
  union all
  select company_id, branch_id, 'guard_licence', id,
         'Guard service licence — ' || full_name, guard_service_licence_expiry
    from public.employees
   where guard_service_licence_expiry is not null and lifecycle_state = 'active';
