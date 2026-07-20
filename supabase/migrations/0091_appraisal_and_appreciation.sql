-- Appraisal & appreciation (spec section 15).
--
-- Appraisal: a weighted scorecard — job delivery & KPIs 35% (read off §14),
-- ownership 20%, quality 20%, teamwork 15%, initiative 10%. Each criterion
-- scored 1–5; the weighted total maps to a rating (Outstanding/Exceeds/Meets/
-- Below). Flow: manager rates -> HR moderates -> COO approves -> rating stored
-- on the employee.
--
-- Appreciation: one flat % applied annually to everyone in good standing
-- (Below excluded), effective-date driven, written to the salary history built
-- in §13 (so increments apply by date, never retroactively).

do $$ begin
  create type public.appraisal_status as enum
    ('draft', 'moderated', 'approved');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.appraisal_rating as enum
    ('below', 'meets', 'exceeds', 'outstanding');
exception when duplicate_object then null; end $$;

create table if not exists public.appraisals (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  period_year   integer not null,
  -- Five criteria, each 1–5.
  score_job_kpi    numeric(3,2) check (score_job_kpi between 1 and 5),
  score_ownership  numeric(3,2) check (score_ownership between 1 and 5),
  score_quality    numeric(3,2) check (score_quality between 1 and 5),
  score_teamwork   numeric(3,2) check (score_teamwork between 1 and 5),
  score_initiative numeric(3,2) check (score_initiative between 1 and 5),
  -- Weighted 1–5 total and its rating, filled by trigger from the settings
  -- weights + thresholds so they can never disagree with the inputs.
  weighted_score numeric(4,3),
  rating         public.appraisal_rating,
  status         public.appraisal_status not null default 'draft',
  rated_by       uuid,   -- manager (dept head / RMD)
  moderated_by   uuid,   -- HR
  approved_by    uuid,   -- COO
  approved_at    timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (employee_id, period_year)
);

create index if not exists idx_appraisals_company on public.appraisals(company_id, period_year);

drop trigger if exists trg_aaa_appraisals_fill_company on public.appraisals;
create trigger trg_aaa_appraisals_fill_company
  before insert on public.appraisals
  for each row execute function public.fill_company_id();

alter table public.appraisals enable row level security;
drop policy if exists "ssa_all" on public.appraisals;
create policy "ssa_all" on public.appraisals for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.appraisals;
create policy "company_members" on public.appraisals for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- The 35% "job delivery & KPIs" criterion can be auto-filled from §14: the
-- average of the employee's KPI values for the year, each normalised to 1–5
-- by its RAG (green=5, amber=3, red=1). Returns null when the employee has no
-- scored KPIs (then the manager supplies the score).
-- ---------------------------------------------------------------------------

create or replace function public.kpi_score_for_appraisal(p_employee_id uuid, p_year integer)
returns numeric language sql stable security definer set search_path = public as $$
  select round(avg(case kv.rag when 'green' then 5 when 'amber' then 3 when 'red' then 1 end), 2)
    from public.kpi_values kv
   where kv.employee_id = p_employee_id
     and extract(year from kv.period_month) = p_year
     and kv.rag is not null;
$$;

-- Weighted score + rating, from settings. Weights are treated as proportions
-- so they still work if a company retunes them to not sum to 100.
create or replace function public.sync_appraisal_rating()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s      record;
  w_sum  numeric;
  v_num  numeric;
begin
  select * into s from public.performance_settings where company_id = new.company_id;
  if s is null then return new; end if;

  w_sum := s.weight_job_kpi + s.weight_ownership + s.weight_quality
         + s.weight_teamwork + s.weight_initiative;

  if new.score_job_kpi is null or new.score_ownership is null or new.score_quality is null
     or new.score_teamwork is null or new.score_initiative is null or w_sum = 0 then
    new.weighted_score := null;
    new.rating := null;
    new.updated_at := now();
    return new;
  end if;

  v_num := new.score_job_kpi   * s.weight_job_kpi
         + new.score_ownership * s.weight_ownership
         + new.score_quality   * s.weight_quality
         + new.score_teamwork  * s.weight_teamwork
         + new.score_initiative* s.weight_initiative;
  new.weighted_score := round(v_num / w_sum, 3);

  new.rating := case
    when new.weighted_score >= s.rating_outstanding_min then 'outstanding'
    when new.weighted_score >= s.rating_exceeds_min     then 'exceeds'
    when new.weighted_score >= s.rating_meets_min       then 'meets'
    else 'below'
  end::public.appraisal_rating;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_appraisal_rating on public.appraisals;
create trigger trg_appraisal_rating
  before insert or update of score_job_kpi, score_ownership, score_quality,
                             score_teamwork, score_initiative on public.appraisals
  for each row execute function public.sync_appraisal_rating();

-- ---------------------------------------------------------------------------
-- Approval flow. moderate -> HR; approve -> COO and stamps the rating onto the
-- employee for the year (a lightweight column so downstream reads are cheap).
-- ---------------------------------------------------------------------------

alter table public.employees
  add column if not exists last_appraisal_rating public.appraisal_rating,
  add column if not exists last_appraisal_year   integer;

create or replace function public.transition_appraisal(
  p_appraisal_id uuid, p_to public.appraisal_status)
returns public.appraisal_status language plpgsql security definer set search_path = public as $$
declare a record; v_allowed boolean;
begin
  select * into a from public.appraisals where id = p_appraisal_id for update;
  if not found then
    raise exception 'appraisal % not found', p_appraisal_id using errcode = '23503';
  end if;

  v_allowed := (a.status, p_to) in
    (('draft','moderated'), ('moderated','draft'),
     ('moderated','approved'), ('approved','moderated'));
  if not v_allowed then
    raise exception 'illegal appraisal transition % -> %', a.status, p_to using errcode = '23514';
  end if;

  if p_to = 'approved' then
    if not coalesce(public.is_performance_approver(), false) then
      raise exception 'only a performance approver (COO) may approve an appraisal'
        using errcode = '42501';
    end if;
    if a.rating is null then
      raise exception 'appraisal has no rating; score all five criteria first'
        using errcode = '23514';
    end if;
  end if;

  update public.appraisals set
    status = p_to,
    moderated_by = case when p_to = 'moderated' then auth.uid() else moderated_by end,
    approved_by  = case when p_to = 'approved' then auth.uid() else approved_by end,
    approved_at  = case when p_to = 'approved' then now() else approved_at end,
    updated_at = now()
  where id = p_appraisal_id;

  if p_to = 'approved' then
    update public.employees
       set last_appraisal_rating = a.rating, last_appraisal_year = a.period_year, updated_at = now()
     where id = a.employee_id;
  end if;

  return p_to;
end;
$$;

-- ===========================================================================
-- Appreciation engine — the annual flat % raise.
--
-- Applies the company's appreciation_pct to every enrolled, in-good-standing
-- employee (rating <> 'below', and active), effective a given date, by calling
-- set_employee_salary — so it lands in the salary history and applies by date.
-- Idempotent per (employee, effective_date): re-running writes the same row.
-- ===========================================================================

create or replace function public.run_appreciation(
  p_company_id uuid, p_effective_date date, p_appraisal_year integer)
returns integer language plpgsql security definer set search_path = public as $$
declare
  s      record;
  e      record;
  v_new  numeric;
  v_count integer := 0;
begin
  select * into s from public.performance_settings where company_id = p_company_id;
  if s is null then
    raise exception 'no performance settings for company %', p_company_id using errcode = '23503';
  end if;

  for e in
    select emp.* from public.employees emp
     where emp.company_id = p_company_id
       and emp.lifecycle_state = 'active'
       and emp.performance_enrolled
       -- good standing: last appraisal for the year is not 'below'
       and emp.last_appraisal_year = p_appraisal_year
       and emp.last_appraisal_rating is distinct from 'below'
       and emp.base_salary is not null
  loop
    v_new := round(e.base_salary * (1 + s.appreciation_pct / 100.0), 2);
    perform public.set_employee_salary(
      e.id, p_effective_date, v_new, coalesce(e.allowance, 0), e.per_day_salary,
      'Annual appreciation ' || s.appreciation_pct || '% (' || p_appraisal_year || ')');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
