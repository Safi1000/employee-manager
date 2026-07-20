-- KPI engine for salaried staff (spec section 14) + the parameter store that
-- also holds the D5/D6/D7 decisions as editable settings.
--
-- Scope: salaried head-office and regional staff only, never guards. Each
-- ENROLLED employee carries the KPIs of their SEAT (accounts / hr / compliance
-- / client management / regional admin). Some KPIs auto-compute from system
-- data; the rest the manager scores. Enrollment is an explicit, COO-approved,
-- date-stamped toggle so the bonus-pool denominator only ever contains people
-- deliberately put in the scheme.

-- ===========================================================================
-- 0. Parameter store — every tunable number Part IV needs, per company.
--    Defaults chosen here; all editable (this is where D5/D6/D7 live).
-- ===========================================================================

create table if not exists public.performance_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  -- D6: appreciation & appraisal
  appreciation_pct        numeric(6,3) not null default 10.000,
  rating_outstanding_min  numeric(3,2) not null default 4.50,
  rating_exceeds_min      numeric(3,2) not null default 3.50,
  rating_meets_min        numeric(3,2) not null default 2.50,
  -- Appraisal scorecard weights (spec §15; sum to 100)
  weight_job_kpi   numeric(5,2) not null default 35,
  weight_ownership numeric(5,2) not null default 20,
  weight_quality   numeric(5,2) not null default 20,
  weight_teamwork  numeric(5,2) not null default 15,
  weight_initiative numeric(5,2) not null default 10,
  -- §16 rating weights for the bonus split
  weight_rating_outstanding numeric(4,2) not null default 1.50,
  weight_rating_exceeds     numeric(4,2) not null default 1.20,
  weight_rating_meets       numeric(4,2) not null default 1.00,
  weight_rating_below       numeric(4,2) not null default 0.00,
  -- D7: bonus pools
  regional_pool_pct numeric(6,3) not null default 20.000,
  ho_pool_pct       numeric(6,3) not null default 15.000,
  -- D7: mid-year leaver — 'pro_rata' (accrued share) or 'forfeit'
  leaver_bonus_rule text not null default 'pro_rata'
    check (leaver_bonus_rule in ('pro_rata', 'forfeit')),
  updated_at timestamptz not null default now()
);

insert into public.performance_settings (company_id)
select id from public.companies
on conflict (company_id) do nothing;

alter table public.performance_settings enable row level security;
drop policy if exists "ssa_all" on public.performance_settings;
create policy "ssa_all" on public.performance_settings for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.performance_settings;
create policy "company_members" on public.performance_settings for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ===========================================================================
-- 1. Seats & enrollment
-- ===========================================================================

do $$ begin
  create type public.kpi_seat as enum
    ('accounts', 'hr', 'compliance', 'client_management', 'regional_admin');
exception when duplicate_object then null; end $$;

-- D5: nobody is in the scheme until deliberately enrolled. Trainees and office
-- support therefore sit outside by default — enrollment is opt-in, dated, and
-- gated on approval.
alter table public.employees
  add column if not exists kpi_seat              public.kpi_seat,
  add column if not exists performance_enrolled  boolean not null default false,
  add column if not exists performance_enrolled_on date,
  add column if not exists performance_enrolled_by uuid;

-- COO/approver gate, mirroring the payroll approver pattern.
create or replace function public.is_performance_approver()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    public.current_role()::text in ('super_super_admin', 'super_admin')
    or exists (select 1 from public.profiles
                where id = auth.uid() and 'performance.approve' = any(permissions)),
    false);
$$;

-- Toggle enrollment. Requires an approver, records the date (bonus pool
-- pro-rates from it), and refuses to enrol anyone who isn't salaried or lacks
-- a seat — the scheme is salaried-staff only.
create or replace function public.set_performance_enrollment(
  p_employee_id uuid,
  p_enrolled    boolean,
  p_seat        public.kpi_seat default null
)
returns void language plpgsql security definer set search_path = public as $$
declare e record;
begin
  if not coalesce(public.is_performance_approver(), false) then
    raise exception 'only a performance approver (COO) may change enrollment'
      using errcode = '42501';
  end if;

  select * into e from public.employees where id = p_employee_id;
  if not found then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  if p_enrolled then
    if e.category <> 'office_staff' then
      raise exception 'only salaried (office_staff) employees can be enrolled'
        using errcode = '23514';
    end if;
    if coalesce(p_seat, e.kpi_seat) is null then
      raise exception 'a KPI seat is required to enrol' using errcode = '23514';
    end if;
  end if;

  update public.employees set
    performance_enrolled = p_enrolled,
    performance_enrolled_on = case when p_enrolled then coalesce(performance_enrolled_on, current_date)
                                   else null end,
    performance_enrolled_by = case when p_enrolled then auth.uid() else null end,
    kpi_seat = coalesce(p_seat, kpi_seat),
    updated_at = now()
  where id = p_employee_id;
end;
$$;

-- ===========================================================================
-- 2. KPI catalogue — the 3–5 per seat the spec lists.
-- ===========================================================================

do $$ begin
  create type public.kpi_direction as enum ('higher_better', 'lower_better');
exception when duplicate_object then null; end $$;

create table if not exists public.kpi_definitions (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  seat           public.kpi_seat not null,
  kpi_key        text not null,
  name           text not null,
  unit           text,
  direction      public.kpi_direction not null,
  target         numeric,
  green_threshold numeric,   -- meets/beats this => green (direction-aware)
  amber_threshold numeric,   -- meets/beats this => amber, else red
  -- Non-null names a computation the engine knows how to run; null = manual.
  auto_source    text,
  active         boolean not null default true,
  unique (company_id, seat, kpi_key)
);

create index if not exists idx_kpi_def_company on public.kpi_definitions(company_id, seat);

alter table public.kpi_definitions enable row level security;
drop policy if exists "ssa_all" on public.kpi_definitions;
create policy "ssa_all" on public.kpi_definitions for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.kpi_definitions;
create policy "company_members" on public.kpi_definitions for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Seed the catalogue for every company.
insert into public.kpi_definitions
  (company_id, seat, kpi_key, name, unit, direction, target, green_threshold, amber_threshold, auto_source)
select c.id, v.seat::public.kpi_seat, v.kpi_key, v.name, v.unit,
       v.direction::public.kpi_direction, v.target, v.green_t, v.amber_t, v.auto_source
  from public.companies c
  cross join (values
    -- accounts
    ('accounts','days_to_invoice','Days to invoice','days','lower_better',3,3,5,'days_to_invoice'),
    ('accounts','payroll_accuracy','Payroll accuracy','%','higher_better',99,99,97,null),
    ('accounts','close_days','Month-end close days','days','lower_better',5,5,8,null),
    -- hr
    ('hr','time_to_deploy','Time to deploy','days','lower_better',7,7,14,null),
    ('hr','records_completeness','Records completeness','%','higher_better',95,95,85,'records_completeness'),
    ('hr','vetting_pct','Vetting cleared','%','higher_better',90,90,75,'vetting_pct'),
    -- compliance
    ('compliance','zero_lapses','Compliance lapses','count','lower_better',0,0,1,null),
    ('compliance','cases_on_target','Cases resolved on target','%','higher_better',90,90,75,null),
    ('compliance','filings_on_time','Filings on time','%','higher_better',100,100,90,null),
    -- client management
    ('client_management','renewal_rate','Contract renewal rate','%','higher_better',85,85,70,'renewal_rate'),
    ('client_management','cadence_executed','Client cadence executed','%','higher_better',90,90,75,null),
    ('client_management','reviews_done','Service reviews done','%','higher_better',90,90,75,null),
    -- regional admin
    ('regional_admin','report_collection_rate','Daily report collection','%','higher_better',95,95,85,null),
    ('regional_admin','kit_records','Kit records accuracy','%','higher_better',95,95,85,null),
    ('regional_admin','filings','Regional filings on time','%','higher_better',100,100,90,null)
  ) as v(seat, kpi_key, name, unit, direction, target, green_t, amber_t, auto_source)
 where not exists (
   select 1 from public.kpi_definitions d
    where d.company_id = c.id and d.seat = v.seat::public.kpi_seat and d.kpi_key = v.kpi_key
 );

-- ===========================================================================
-- 3. Scored values, with RAG
-- ===========================================================================

do $$ begin
  create type public.rag_status as enum ('green', 'amber', 'red');
exception when duplicate_object then null; end $$;

create table if not exists public.kpi_values (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  employee_id       uuid not null references public.employees(id) on delete cascade,
  kpi_definition_id uuid not null references public.kpi_definitions(id) on delete cascade,
  period_month      date not null,
  value             numeric,
  rag               public.rag_status,
  is_auto           boolean not null default false,
  scored_by         uuid,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (employee_id, kpi_definition_id, period_month)
);

create index if not exists idx_kpi_values_emp on public.kpi_values(employee_id, period_month);

drop trigger if exists trg_aaa_kpi_values_fill_company on public.kpi_values;
create trigger trg_aaa_kpi_values_fill_company
  before insert on public.kpi_values
  for each row execute function public.fill_company_id();

alter table public.kpi_values enable row level security;
drop policy if exists "ssa_all" on public.kpi_values;
create policy "ssa_all" on public.kpi_values for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.kpi_values;
create policy "company_members" on public.kpi_values for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Direction-aware RAG.
create or replace function public.kpi_rag(
  p_value numeric, p_direction public.kpi_direction, p_green numeric, p_amber numeric)
returns public.rag_status language sql immutable set search_path = public as $$
  select case
    when p_value is null then null
    when p_direction = 'higher_better' then
      case when p_value >= p_green then 'green'
           when p_value >= p_amber then 'amber' else 'red' end
    else
      case when p_value <= p_green then 'green'
           when p_value <= p_amber then 'amber' else 'red' end
  end::public.rag_status;
$$;

-- Keep RAG in step with value/definition on every write.
create or replace function public.sync_kpi_rag()
returns trigger language plpgsql security definer set search_path = public as $$
declare d record;
begin
  select direction, green_threshold, amber_threshold into d
    from public.kpi_definitions where id = new.kpi_definition_id;
  new.rag := public.kpi_rag(new.value, d.direction, d.green_threshold, d.amber_threshold);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_kpi_values_rag on public.kpi_values;
create trigger trg_kpi_values_rag
  before insert or update of value, kpi_definition_id on public.kpi_values
  for each row execute function public.sync_kpi_rag();

-- ===========================================================================
-- 4. Auto-computation. A dispatcher on kpi_key; implemented for the metrics
--    whose data already exists, null (=> manager scores it) for the rest.
--    Auto KPIs are regional metrics attributed to the seat-holder for that
--    region.
-- ===========================================================================

create or replace function public.compute_kpi_value(
  p_employee_id uuid, p_kpi_definition_id uuid, p_period date)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  d        record;
  e        record;
  v_start  date := date_trunc('month', p_period)::date;
  v_end    date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_val    numeric;
begin
  select * into d from public.kpi_definitions where id = p_kpi_definition_id;
  select * into e from public.employees where id = p_employee_id;
  if d.auto_source is null then return null; end if;

  if d.kpi_key = 'vetting_pct' then
    -- % of the employee's region's active guards fully vetted
    select case when count(*) = 0 then null
                else round(100.0 * count(*) filter (
                       where police_verification_status = 'cleared'
                         and nadra_verisys_status = 'cleared') / count(*), 1) end
      into v_val
      from public.employees g
     where g.company_id = e.company_id
       and (e.branch_id is null or g.branch_id = e.branch_id)
       and g.category in ('client','reliever')
       and g.lifecycle_state in ('active','on_leave');

  elsif d.kpi_key = 'records_completeness' then
    -- % of checklist items received across the region's employees
    select case when count(*) = 0 then null
                else round(100.0 * count(*) filter (where dc.received) / count(*), 1) end
      into v_val
      from public.employee_document_checklist dc
      join public.employees g on g.id = dc.employee_id
     where g.company_id = e.company_id
       and (e.branch_id is null or g.branch_id = e.branch_id);

  elsif d.kpi_key = 'days_to_invoice' then
    -- avg days from period end to invoice date for the region's invoices
    select round(avg(greatest(i.invoice_date - i.period_end, 0)), 1)
      into v_val
      from public.invoices i
     where i.company_id = e.company_id
       and (e.branch_id is null or i.branch_id = e.branch_id)
       and i.invoice_date between v_start and v_end
       and i.period_end is not null;

  elsif d.kpi_key = 'renewal_rate' then
    -- % of contracts ending in the period that have an active successor
    select case when count(*) = 0 then null
                else round(100.0 * count(*) filter (where c.status = 'active') / count(*), 1) end
      into v_val
      from public.contracts c
      join public.clients cl on cl.id = c.client_id
     where c.company_id = e.company_id
       and (e.branch_id is null or cl.branch_id = e.branch_id);
  end if;

  return v_val;
end;
$$;

-- Batch: compute every auto KPI for every enrolled employee for a period.
create or replace function public.run_kpi_computation(p_company_id uuid, p_period date)
returns integer language plpgsql security definer set search_path = public as $$
declare
  r       record;
  v_val   numeric;
  v_month date := date_trunc('month', p_period)::date;
  v_count integer := 0;
begin
  for r in
    select e.id as employee_id, d.id as kpi_definition_id
      from public.employees e
      join public.kpi_definitions d
        on d.company_id = e.company_id and d.seat = e.kpi_seat and d.active
     where e.company_id = p_company_id
       and e.performance_enrolled
       and d.auto_source is not null
  loop
    v_val := public.compute_kpi_value(r.employee_id, r.kpi_definition_id, v_month);

    insert into public.kpi_values
      (company_id, employee_id, kpi_definition_id, period_month, value, is_auto)
    values (p_company_id, r.employee_id, r.kpi_definition_id, v_month, v_val, true)
    on conflict (employee_id, kpi_definition_id, period_month) do update set
      value = excluded.value, is_auto = true, updated_at = now();

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ===========================================================================
-- 5. Per-employee KPI dashboard (targets + RAG).
-- ===========================================================================

create or replace view public.kpi_dashboard
  with (security_invoker = true) as
  select e.id as employee_id,
         e.company_id,
         e.full_name,
         e.kpi_seat,
         e.branch_id,
         d.id as kpi_definition_id,
         d.kpi_key, d.name, d.unit, d.direction, d.target,
         (d.auto_source is not null) as is_auto_kpi,
         kv.period_month,
         kv.value,
         kv.rag,
         kv.is_auto
    from public.employees e
    join public.kpi_definitions d
      on d.company_id = e.company_id and d.seat = e.kpi_seat and d.active
    left join public.kpi_values kv
      on kv.employee_id = e.id and kv.kpi_definition_id = d.id
   where e.performance_enrolled;
