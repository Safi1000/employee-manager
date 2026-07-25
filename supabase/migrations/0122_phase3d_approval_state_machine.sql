-- 0122: Phase 3D — approval state machine (§4) + new approver roles.
--
-- Chain: Draft (clerk) → Ops verified (ops_manager/ops_director) →
--        Finance approved (finance_director) → Active (system, automatic).
-- Confirmed: one ops step (either ops role); finance approval auto-activates;
-- posting blocked below ops_verified (app + DB); payroll gate app-side;
-- reversal one step back by super_admin or the owning role, reason logged.
--
-- Resting states are draft / ops_verified / active; finance_approved is a
-- momentary step the finance approval passes through on its way to active.

-- ---------------------------------------------------------------------------
-- 1. New approver roles (compared as text inside functions to stay tx-safe).
-- ---------------------------------------------------------------------------
alter type user_role add value if not exists 'ops_manager';
alter type user_role add value if not exists 'ops_director';
alter type user_role add value if not exists 'finance_director';

-- ---------------------------------------------------------------------------
-- 2. Approval-event log (approver + timestamp per transition → service log).
-- ---------------------------------------------------------------------------
create table if not exists public.employee_approval_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  from_state  record_state,
  to_state    record_state not null,
  action      text not null,   -- ops_verify | finance_approve | activate | reverse
  reason      text,
  approved_by uuid references auth.users(id) on delete set null,
  changed_at  timestamptz not null default now()
);

create index if not exists employee_approval_events_emp_idx
  on public.employee_approval_events(employee_id, changed_at desc);

drop trigger if exists trg_aaa_approval_events_fill_company on public.employee_approval_events;
create trigger trg_aaa_approval_events_fill_company
  before insert on public.employee_approval_events
  for each row execute function public.fill_company_id();

alter table public.employee_approval_events enable row level security;

drop policy if exists "ssa_all" on public.employee_approval_events;
create policy "ssa_all" on public.employee_approval_events for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.employee_approval_events;
create policy "company_members" on public.employee_approval_events for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 3. transition_record_state(): the ONLY way record_state advances/reverses.
--    Enforces role gates, logs approver+timestamp+reason. Finance approval
--    auto-advances through finance_approved to active in one call.
-- ---------------------------------------------------------------------------
create or replace function public.transition_record_state(
  p_employee_id uuid,
  p_action      text,               -- 'ops_verify' | 'finance_approve' | 'reverse'
  p_reason      text default null
) returns record_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_company uuid;
  v_cur     record_state;
  v_new     record_state;
begin
  select role::text into v_role from public.profiles where id = auth.uid();
  select company_id, record_state into v_company, v_cur
    from public.employees where id = p_employee_id;
  if v_company is null then raise exception 'Employee % not found', p_employee_id; end if;

  if p_action = 'ops_verify' then
    if v_cur <> 'draft' then raise exception 'Can only Ops-verify a Draft record (current: %)', v_cur; end if;
    if v_role not in ('ops_manager','ops_director','super_admin','super_super_admin') then
      raise exception 'Only Ops Manager/Director may Ops-verify'; end if;
    v_new := 'ops_verified';
    update public.employees set record_state = v_new, updated_at = now() where id = p_employee_id;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, v_cur, v_new, 'ops_verify', p_reason, auth.uid());

  elsif p_action = 'finance_approve' then
    if v_cur <> 'ops_verified' then raise exception 'Can only Finance-approve an Ops-verified record (current: %)', v_cur; end if;
    if v_role not in ('finance_director','super_admin','super_super_admin') then
      raise exception 'Only Director Finance may approve'; end if;
    -- finance approval, logged
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, v_cur, 'finance_approved', 'finance_approve', p_reason, auth.uid());
    -- system auto-activation, logged
    v_new := 'active';
    update public.employees set record_state = v_new, updated_at = now() where id = p_employee_id;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, 'finance_approved', v_new, 'activate', 'auto (system) on finance approval', auth.uid());

  elsif p_action = 'reverse' then
    if p_reason is null or btrim(p_reason) = '' then raise exception 'Reversal requires a reason'; end if;
    if v_cur = 'active' or v_cur = 'finance_approved' then
      if v_role not in ('finance_director','super_admin','super_super_admin') then
        raise exception 'Only Director Finance or super admin may reverse a finance-approved/active record'; end if;
      v_new := 'ops_verified';
    elsif v_cur = 'ops_verified' then
      if v_role not in ('ops_manager','ops_director','super_admin','super_super_admin') then
        raise exception 'Only Ops Manager/Director or super admin may reverse an Ops-verified record'; end if;
      v_new := 'draft';
    else
      raise exception 'Nothing to reverse from Draft';
    end if;
    update public.employees set record_state = v_new, updated_at = now() where id = p_employee_id;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, v_cur, v_new, 'reverse', p_reason, auth.uid());
  else
    raise exception 'Unknown action %', p_action;
  end if;

  return v_new;
end;
$$;

grant execute on function public.transition_record_state(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Posting gate (DB): a Draft record cannot be posted/transferred to a client.
--    Fires on UPDATE only (initial-hire flow is reworked in §3F).
-- ---------------------------------------------------------------------------
create or replace function public.enforce_posting_requires_ops_verified()
returns trigger language plpgsql as $$
begin
  if NEW.client_id is not null
     and NEW.client_id is distinct from OLD.client_id
     and NEW.record_state = 'draft' then
    raise exception 'Guard must be Ops-verified before being posted to a client';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_posting_requires_ops_verified on public.employees;
create trigger trg_posting_requires_ops_verified
  before update on public.employees
  for each row execute function public.enforce_posting_requires_ops_verified();

-- ---------------------------------------------------------------------------
-- 5. Surface approval events in the Service History timeline (recreate view,
--    preserving all existing unions from 0084 and adding 'approval').
-- ---------------------------------------------------------------------------
create or replace view public.employee_service_history
  with (security_invoker = true) as
  select ele.employee_id, ele.company_id, 'lifecycle'::text as kind,
         ele.changed_at as event_at,
         (ele.from_state || ' → ' || ele.to_state)::text as title,
         ele.reason as detail
    from public.employee_lifecycle_events ele
  union all
  select dw.employee_id, dw.company_id, 'warning',
         dw.issued_on::timestamptz,
         ('Warning ' || dw.warning_number || case when dw.rescinded then ' (rescinded)' else '' end),
         dw.reason
    from public.disciplinary_warnings dw
  union all
  select ig.employee_id, inc.company_id, 'incident',
         inc.occurred_at,
         ('Incident: ' || coalesce(inc.category::text, 'event')),
         inc.description
    from public.incident_guards ig
    join public.incidents inc on inc.id = ig.incident_id
  union all
  select tr.employee_id, tr.company_id, 'training',
         tr.completed_on::timestamptz,
         tr.kind::text,
         tr.notes
    from public.employee_training_records tr
  union all
  select ech.employee_id, ech.company_id, 'posting',
         ech.changed_at,
         ('Code ' || coalesce(ech.old_code, '—') || ' → ' || coalesce(ech.new_code, '—')),
         ech.reason
    from public.employee_code_history ech
  union all
  select ae.employee_id, ae.company_id, 'approval',
         ae.changed_at,
         (coalesce(ae.from_state::text, '—') || ' → ' || ae.to_state::text),
         (ae.action || coalesce(' · ' || ae.reason, ''))
    from public.employee_approval_events ae;
