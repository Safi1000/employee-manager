-- Alert Engine, three tiers (spec section 21).
--
-- Tier 1 BLOCKING   — an action that must be acknowledged/overridden, logged.
-- Tier 2 WARNING    — an on-screen popup the user should see but can proceed.
-- Tier 3 DASHBOARD  — passive, surfaced on dashboards.
--
-- Two halves:
--   * a persisted `alerts` table for raised blocking/warning alerts and their
--     acknowledgement/override trail (the audit the spec requires);
--   * live views that COMPUTE the current warning/dashboard signals from
--     existing data, so nothing has to be manually kept in sync.
--
-- Blocking-tier CHECKS are enforced at the point of action. Several already
-- exist as hard gates (locked payroll run, locked contract/identity, approval
-- gates). This adds a helper to raise+log a blocking alert and the two
-- outstanding data-driven checks (ammo discrepancy, adverse-verification
-- deployment) as callable guards.

do $$ begin
  create type public.alert_tier as enum ('blocking', 'warning', 'dashboard');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.alert_state as enum ('open', 'acknowledged', 'overridden', 'resolved');
exception when duplicate_object then null; end $$;

create table if not exists public.alerts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  branch_id     uuid references public.branches(id),
  tier          public.alert_tier not null,
  category      text not null,          -- e.g. 'ammo_discrepancy', 'danger_level'
  message       text not null,
  ref_table     text,
  ref_id        uuid,
  state         public.alert_state not null default 'open',
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  override_reason text,
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create index if not exists idx_alerts_company on public.alerts(company_id, tier, state);

drop trigger if exists trg_aaa_alerts_fill_company on public.alerts;
create trigger trg_aaa_alerts_fill_company
  before insert on public.alerts
  for each row execute function public.fill_company_id();

alter table public.alerts enable row level security;
drop policy if exists "ssa_all" on public.alerts;
create policy "ssa_all" on public.alerts for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.alerts;
create policy "company_members" on public.alerts for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- Raise + acknowledge/override helpers (the logged trail).
-- ---------------------------------------------------------------------------

create or replace function public.raise_alert(
  p_company_id uuid, p_tier public.alert_tier, p_category text, p_message text,
  p_ref_table text default null, p_ref_id uuid default null, p_branch_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.alerts (company_id, branch_id, tier, category, message, ref_table, ref_id, created_by)
  values (p_company_id, coalesce(p_branch_id, public.head_office_region(p_company_id)),
          p_tier, p_category, p_message, p_ref_table, p_ref_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.acknowledge_alert(
  p_alert_id uuid, p_override_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select * into a from public.alerts where id = p_alert_id;
  if not found then
    raise exception 'alert % not found', p_alert_id using errcode = '23503';
  end if;
  -- A blocking alert requires a reason to override.
  if a.tier = 'blocking' and coalesce(trim(p_override_reason), '') = '' then
    raise exception 'overriding a blocking alert requires a reason' using errcode = '23514';
  end if;
  update public.alerts set
    state = (case when a.tier = 'blocking' then 'overridden' else 'acknowledged' end)::public.alert_state,
    acknowledged_by = auth.uid(), acknowledged_at = now(),
    override_reason = p_override_reason
  where id = p_alert_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Blocking-tier data checks callable at action time.
-- ---------------------------------------------------------------------------

-- Deploying an adverse/pending-verification guard to a post: raises + returns
-- the blockers. Empty array => clear to deploy.
create or replace function public.check_deploy_guard(p_employee_id uuid)
returns text[] language plpgsql security definer set search_path = public as $$
declare v_block text[];
begin
  v_block := public.armed_post_blockers(p_employee_id);
  if array_length(v_block, 1) > 0 then
    perform public.raise_alert(
      (select company_id from public.employees where id = p_employee_id),
      'blocking', 'deploy_unverified_guard',
      'Guard cannot be deployed to a sensitive/armed post: ' || array_to_string(v_block, ', '),
      'employees', p_employee_id,
      (select branch_id from public.employees where id = p_employee_id));
  end if;
  return v_block;
end;
$$;

-- Ammo discrepancy is a standing blocking condition; raise one alert per open
-- discrepancy that doesn't already have an open alert.
create or replace function public.sweep_ammo_discrepancy_alerts(p_company_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare d record; v_count integer := 0;
begin
  for d in select * from public.ammunition_discrepancies where company_id = p_company_id loop
    if not exists (select 1 from public.alerts
                    where category = 'ammo_discrepancy' and ref_id = d.count_id and state = 'open') then
      perform public.raise_alert(p_company_id, 'blocking', 'ammo_discrepancy',
        'Ammunition discrepancy: ' || d.discrepancy || ' rounds unaccounted on '
        || coalesce(d.item_type,'weapon') || coalesce(' #' || d.serial_number, ''),
        'ammunition_counts', d.count_id, d.branch_id);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- WARNING-tier live signals (spec §21 middle row), one row per condition.
-- ---------------------------------------------------------------------------

create or replace view public.warning_alerts
  with (security_invoker = true) as
  -- Verification-pending guard rostered to a post
  select e.company_id, e.branch_id, 'verification_pending_rostered'::text as category,
         ('Verification-pending guard rostered: ' || e.full_name) as message,
         'roster_assignments'::text as ref_table, ra.id as ref_id
    from public.roster_assignments ra
    join public.employees e on e.id = ra.employee_id
   where (e.police_verification_status <> 'cleared' or e.nadra_verisys_status <> 'cleared')
     and ra.assignment_date >= current_date
  union all
  -- Invoices hitting +30 / +45 days overdue
  select i.company_id, i.branch_id, 'invoice_aging',
         ('Invoice ' || coalesce(i.invoice_number,'') || ' is '
           || (current_date - i.invoice_date) || ' days old'),
         'invoices', i.id
    from public.invoices i
   where i.amount_received < coalesce(i.total_due, i.invoice_amount)
     and (current_date - i.invoice_date) in
         (30, 31, 45, 46)  -- flags at the +30 and +45 thresholds
  union all
  -- Licences under 30 days to expiry (weapon / guard-service)
  select e.company_id, e.branch_id, 'licence_expiring',
         ('Weapon licence expiring for ' || e.full_name),
         'employees', e.id
    from public.employees e
   where e.weapon_licence_expiry is not null
     and e.weapon_licence_expiry between current_date and current_date + 30
     and e.lifecycle_state = 'active'
  union all
  -- Cheques pending beyond 15 days
  select ch.company_id, ch.branch_id, 'cheque_pending',
         ('Cheque ' || coalesce(ch.cheque_number,'') || ' pending '
           || (current_date - ch.cheque_date) || ' days'),
         'cheques', ch.id
    from public.cheques ch
   where ch.status <> 'cleared' and (current_date - ch.cheque_date) > 15;

-- Bonus accrual not run this month is a company-level warning (no natural row).
create or replace function public.bonus_accrual_missing(p_company_id uuid, p_period date)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from public.bonus_accruals
     where company_id = p_company_id
       and period_month = date_trunc('month', p_period)::date);
$$;

-- ---------------------------------------------------------------------------
-- DASHBOARD-tier passive summary (spec §21 bottom row).
-- ---------------------------------------------------------------------------

create or replace view public.dashboard_alerts
  with (security_invoker = true) as
  -- Sites silent today
  select company_id, branch_id, 'site_silent'::text as category,
         (post_name || ' has not reported today') as message,
         'posts'::text as ref_table, post_id as ref_id
    from public.daily_report_status
   where is_silent
  union all
  -- Expiring credentials (30–60 day window, softer than the warning tier)
  select company_id, branch_id, 'credential_expiring',
         ('Guard-service licence expiring for ' || full_name),
         'employees', id
    from public.employees
   where guard_service_licence_expiry is not null
     and guard_service_licence_expiry between current_date and current_date + 60
     and lifecycle_state = 'active'
  union all
  -- KPI RAG red breaches
  select kv.company_id, e.branch_id, 'kpi_red',
         ('KPI red: ' || d.name || ' for ' || e.full_name),
         'kpi_values', kv.id
    from public.kpi_values kv
    join public.kpi_definitions d on d.id = kv.kpi_definition_id
    join public.employees e on e.id = kv.employee_id
   where kv.rag = 'red'
  union all
  -- Open ammunition discrepancies (also blocking, but shown passively too)
  select company_id, branch_id, 'ammo_discrepancy',
         (discrepancy || ' rounds unaccounted'),
         'ammunition_counts', count_id
    from public.ammunition_discrepancies;
