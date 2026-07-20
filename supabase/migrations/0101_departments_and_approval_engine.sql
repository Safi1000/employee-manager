-- Department roles + approval workflow engine (spec section 2).
--
-- Additive to the existing auth roles (super_super_admin / super_admin /
-- accounting / hr stay): a DEPARTMENT dimension (Operations, Compliance, HR,
-- Finance, Client Management) and an RMD flag layer on top, each mapping to a
-- default permission set. Plus a configurable recommend -> approve engine that
-- gates the action types the spec names (increments, bonuses, expenses over a
-- limit, contract changes, terminations, inter-region funding), logging every
-- decision.

-- ===========================================================================
-- 1. Department dimension on profiles.
-- ===========================================================================

do $$ begin
  create type public.department as enum
    ('operations', 'compliance', 'hr', 'finance', 'client_management');
exception when duplicate_object then null; end $$;

alter table public.profiles
  add column if not exists department public.department,
  -- RMD: owns one region (branch_id already scopes them per §3); this marks
  -- the role explicitly.
  add column if not exists is_rmd boolean not null default false;

-- Default permission set per department, per the RACI. Returned as an array
-- the UI/admin can apply to a profile; not auto-enforced, so a person can be
-- given more or fewer than their department's default.
create or replace function public.department_default_permissions(p_dept public.department)
returns text[] language sql immutable set search_path = public as $$
  select case p_dept
    when 'operations' then array[
      'employees.view','attendance.view','attendance.edit','roster.view','roster.edit',
      'incidents.view','incidents.edit','inventory.view']
    when 'compliance' then array[
      'compliance.view','compliance.edit','documents.view','documents.edit','employees.view']
    when 'hr' then array[
      'employees.view','employees.edit','attendance.view','payroll.view','documents.view']
    when 'finance' then array[
      'accounting.view','accounting.edit','expenses.view','expenses.edit','invoices.view',
      'invoices.edit','payroll.view','payroll.edit','payroll.approve','reports.view','coa.view',
      'cashflow.view','period_close.manage']
    when 'client_management' then array[
      'clients.view','clients.edit','contracts.view','contracts.edit','invoices.view']
  end;
$$;

-- ===========================================================================
-- 2. The generic permission predicate all approver gates share.
-- ===========================================================================

create or replace function public.has_perm(p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    public.current_role()::text in ('super_super_admin', 'super_admin')
    or exists (select 1 from public.profiles
                where id = auth.uid() and p_perm = any(permissions)),
    false);
$$;

-- ===========================================================================
-- 3. Approval engine.
--    A per-company config maps each action type to the permission its approver
--    must hold, and (optionally) a threshold below which no approval is needed.
-- ===========================================================================

create table if not exists public.approval_configs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  action_key    text not null,
  name          text not null,
  approver_permission text not null,
  -- Only amounts strictly above this need approval (null = always require).
  threshold_amount numeric(16,2),
  active        boolean not null default true,
  unique (company_id, action_key)
);

drop trigger if exists trg_aaa_approval_configs_fill_company on public.approval_configs;
create trigger trg_aaa_approval_configs_fill_company
  before insert on public.approval_configs
  for each row execute function public.fill_company_id();

alter table public.approval_configs enable row level security;
drop policy if exists "ssa_all" on public.approval_configs;
create policy "ssa_all" on public.approval_configs for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.approval_configs;
create policy "company_members" on public.approval_configs for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Seed the action types the spec names, for every company.
insert into public.approval_configs (company_id, action_key, name, approver_permission, threshold_amount)
select c.id, v.action_key, v.name, v.perm, v.threshold
  from public.companies c
  cross join (values
    ('increment',          'Salary increment',        'performance.approve', null),
    ('bonus',              'Bonus payout',            'performance.approve', null),
    ('expense_over_limit', 'Expense above limit',     'accounting.edit',     100000),
    ('contract_change',    'Contract change',         'contracts.edit',      null),
    ('termination',        'Employee termination',    'employees.edit',      null),
    ('interregion_funding','Inter-region funding',    'accounting.edit',     null)
  ) as v(action_key, name, perm, threshold)
 where not exists (
   select 1 from public.approval_configs ac
    where ac.company_id = c.id and ac.action_key = v.action_key
 );

-- The request log — one row per approval, from recommend through decision.
do $$ begin
  create type public.approval_status as enum
    ('pending', 'recommended', 'approved', 'rejected', 'auto_approved', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.approval_requests (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  branch_id     uuid references public.branches(id),
  action_key    text not null,
  ref_table     text,
  ref_id        uuid,
  amount        numeric(16,2),
  payload       jsonb,
  status        public.approval_status not null default 'pending',
  requested_by  uuid,
  recommended_by uuid,
  decided_by    uuid,
  decided_at    timestamptz,
  decision_reason text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_ar_company on public.approval_requests(company_id, status);
create index if not exists idx_ar_ref on public.approval_requests(ref_table, ref_id);

drop trigger if exists trg_aaa_approval_requests_fill_company on public.approval_requests;
create trigger trg_aaa_approval_requests_fill_company
  before insert on public.approval_requests
  for each row execute function public.fill_company_id();

alter table public.approval_requests enable row level security;
drop policy if exists "ssa_all" on public.approval_requests;
create policy "ssa_all" on public.approval_requests for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.approval_requests;
create policy "company_members" on public.approval_requests for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Raise a request. If the action has a threshold and the amount is at/under
-- it, the request is auto-approved (nothing needing sign-off). Otherwise it
-- lands pending for an approver.
create or replace function public.request_approval(
  p_company_id uuid, p_action_key text, p_ref_table text default null,
  p_ref_id uuid default null, p_amount numeric default null,
  p_payload jsonb default null, p_branch_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare cfg record; v_id uuid; v_auto boolean := false;
begin
  select * into cfg from public.approval_configs
   where company_id = p_company_id and action_key = p_action_key and active;
  if not found then
    raise exception 'no active approval config for action %', p_action_key using errcode = '23503';
  end if;

  if cfg.threshold_amount is not null and coalesce(p_amount, 0) <= cfg.threshold_amount then
    v_auto := true;
  end if;

  insert into public.approval_requests
    (company_id, branch_id, action_key, ref_table, ref_id, amount, payload,
     status, requested_by, decided_by, decided_at)
  values
    (p_company_id, p_branch_id, p_action_key, p_ref_table, p_ref_id, p_amount, p_payload,
     (case when v_auto then 'auto_approved' else 'pending' end)::public.approval_status,
     auth.uid(), case when v_auto then auth.uid() end, case when v_auto then now() end)
  returning id into v_id;
  return v_id;
end;
$$;

-- Decide. Only a holder of the action's configured approver permission may
-- approve or reject. The request row is the permanent log.
create or replace function public.decide_approval(
  p_request_id uuid, p_approve boolean, p_reason text default null)
returns public.approval_status language plpgsql security definer set search_path = public as $$
declare r record; cfg record;
begin
  select * into r from public.approval_requests where id = p_request_id for update;
  if not found then
    raise exception 'approval request % not found', p_request_id using errcode = '23503';
  end if;
  if r.status not in ('pending', 'recommended') then
    raise exception 'request is already %', r.status using errcode = '23514';
  end if;

  select * into cfg from public.approval_configs
   where company_id = r.company_id and action_key = r.action_key;

  if not coalesce(public.has_perm(cfg.approver_permission), false) then
    raise exception 'you lack the % permission required to decide this action', cfg.approver_permission
      using errcode = '42501';
  end if;

  update public.approval_requests set
    status = (case when p_approve then 'approved' else 'rejected' end)::public.approval_status,
    decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason
  where id = p_request_id;

  return (case when p_approve then 'approved' else 'rejected' end)::public.approval_status;
end;
$$;

-- Convenience: is there an approved (or auto-approved) request for this ref?
-- The action functions call this before executing.
create or replace function public.is_action_approved(p_ref_table text, p_ref_id uuid, p_action_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.approval_requests
     where ref_table = p_ref_table and ref_id = p_ref_id and action_key = p_action_key
       and status in ('approved', 'auto_approved'));
$$;
