-- 0658 — remarks passed between stages, acknowledged before the next stage approves
--
-- Asked 11 Nov 2026 (Shayan): HR leaves remarks on the monthly board for Ops;
-- Ops, before approving, leaves remarks for Accounts. "Compulsory for Ops in
-- the attendance run to see the remarks, highlighted, and a button where he
-- acknowledges it before approving. Same in the payroll run, remarks from Ops."
-- Today a remark lives in someone's head or a chat message, and an approval
-- can be given without anyone having read it.
--
-- The change:
--   1. HR's remarks are the ones already written on the monthly board
--      (attendance_board_remarks, 0493 — 23 in use on 11 Nov 2026). They gain
--      acknowledged_at / _by / _by_name, and acknowledge_board_remark (Ops,
--      attendance.ops_verify) marks one read. A second, parallel kind of HR
--      remark would split one conversation in two.
--   2. Ops' remarks for Accounts are new: run_remarks (stage ops_to_accounts),
--      for one scope (a client, or a staff group in a region) and pay month,
--      optionally about one employee. add_run_remark (attendance.ops_verify)
--      and acknowledge_run_remark (payroll.edit or payroll.approve — the keys
--      that Finance Verify a payroll scope).
--   3. The gates sit on the tables the approvals write, so no screen can skip
--      them:
--        * attendance_half_verifications — Ops verifying a half is refused
--          while that board has an unacknowledged top-level remark.
--        * payroll_run_phases — Finance Verify is refused while that scope and
--          month has an unacknowledged Ops remark.
--      A staff group's payroll phase has no region, so its gate counts the
--      group's remarks from every region.
--
-- Not changed: attendance_half_action and the Payroll Run's own writes. The
-- triggers read the row being written, whatever wrote it.
--
-- Asserted on what can break, on throwaway rows for January 2026 inside a block
-- rolled back by a sentinel: with an unacknowledged board remark Ops verify is
-- refused, and with an unacknowledged Ops remark Finance Verify is refused, each
-- with its own message; acknowledged, both go through.

create table if not exists public.run_remarks (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies(id),
  branch_id              uuid references public.branches(id),
  client_id              uuid references public.clients(id),
  category               text,
  period_month           date not null check (period_month = date_trunc('month', period_month)::date),
  stage                  text not null check (stage = 'ops_to_accounts'),
  employee_id            uuid references public.employees(id),
  body                   text not null check (btrim(body) <> ''),
  author_id              uuid default auth.uid(),
  author_name            text,
  created_at             timestamptz not null default now(),
  acknowledged_at        timestamptz,
  acknowledged_by        uuid,
  acknowledged_by_name   text,
  constraint run_remarks_one_scope check ((client_id is null) <> (category is null))
);
create index if not exists run_remarks_scope_idx on public.run_remarks (company_id, period_month, stage);

comment on table public.run_remarks is
  '0658: remarks Ops hands to Accounts for a payroll scope and month. Finance Verify is refused while one is '
  'unacknowledged. Written only by add_run_remark / acknowledge_run_remark. HR''s remarks for Ops are attendance_board_remarks.';

alter table public.run_remarks enable row level security;
revoke all on public.run_remarks from anon, authenticated;
grant select on public.run_remarks to authenticated;

drop policy if exists company_members on public.run_remarks;
create policy company_members on public.run_remarks for select
  using (company_id = (select public.current_company_id()));
drop policy if exists ssa_all on public.run_remarks;
create policy ssa_all on public.run_remarks for select
  using ((select public.is_ssa_unscoped()));
drop policy if exists branch_scope on public.run_remarks;
create policy branch_scope on public.run_remarks as restrictive for select
  using ((not (select public.is_branched_user())) or (select public.is_super_super_admin())
         or branch_id is null or branch_id = (select public.current_branch_id()));
drop policy if exists perm_read on public.run_remarks;
create policy perm_read on public.run_remarks as restrictive for select
  using ((select public.has_perm('attendance.hr_verify')) or (select public.has_perm('attendance.ops_verify'))
         or (select public.has_perm('payroll.view')) or (select public.has_perm('payroll.edit'))
         or (select public.has_perm('payroll.approve')));

create or replace function public.add_run_remark(
  p_stage text, p_client_id uuid, p_category text, p_branch_id uuid, p_period_month date,
  p_body text, p_employee_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_company uuid; v_branch uuid; v_id uuid; v_name text;
begin
  if p_stage is distinct from 'ops_to_accounts' then raise exception 'Unknown remark stage. Nothing has been recorded.'; end if;
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('attendance.ops_verify');
  end if;
  if p_client_id is not null then
    perform public.assert_same_company((select company_id from public.clients where id = p_client_id));
  end if;
  if p_employee_id is not null then
    perform public.assert_same_company((select company_id from public.employees where id = p_employee_id));
  end if;
  perform public.assert_branch_in_company(p_branch_id);
  if (p_client_id is null) = (nullif(btrim(p_category), '') is null) then
    raise exception 'A remark is for exactly one client or one staff group. Nothing has been recorded.';
  end if;
  if p_period_month is null then raise exception 'Choose the month. Nothing has been recorded.'; end if;
  if nullif(btrim(p_body), '') is null then raise exception 'Write the remark. Nothing has been recorded.'; end if;

  if p_client_id is not null then
    select company_id, branch_id into v_company, v_branch from public.clients where id = p_client_id;
  else
    v_company := public.current_company_id();
    v_branch := p_branch_id;
  end if;
  if v_company is null then raise exception 'No company is selected. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(v_branch);

  select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
  insert into public.run_remarks (company_id, branch_id, client_id, category, period_month, stage, employee_id, body, author_name)
  values (v_company, v_branch, p_client_id, case when p_client_id is null then btrim(p_category) end,
          date_trunc('month', p_period_month)::date, p_stage, p_employee_id, btrim(p_body), v_name)
  returning id into v_id;
  return v_id;
end $function$;
comment on function public.add_run_remark(text, uuid, text, uuid, date, text, uuid) is
  '0658: Ops leaves a remark for Accounts on a payroll scope and month (attendance.ops_verify).';
revoke all on function public.add_run_remark(text, uuid, text, uuid, date, text, uuid) from public, anon;
grant execute on function public.add_run_remark(text, uuid, text, uuid, date, text, uuid) to authenticated;

create or replace function public.acknowledge_run_remark(p_remark_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r public.run_remarks; v_name text; v_n int;
begin
  if p_remark_id is not null then
    perform public.assert_same_company((select company_id from public.run_remarks where id = p_remark_id));
  end if;
  select * into r from public.run_remarks where id = p_remark_id for update;
  if r.id is null then raise exception 'That remark does not exist. Nothing has been recorded.'; end if;
  if auth.uid() is not null and pg_trigger_depth() = 0
     and not (public.has_perm('payroll.edit') or public.has_perm('payroll.approve')) then
    raise exception 'permission denied: payroll.edit or payroll.approve required' using errcode = '42501';
  end if;
  perform public.assert_branch_writable(r.branch_id);
  if r.acknowledged_at is not null then return; end if;   -- already read; nothing to do
  select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
  update public.run_remarks
     set acknowledged_at = now(), acknowledged_by = auth.uid(), acknowledged_by_name = v_name
   where id = r.id and acknowledged_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The remark could not be acknowledged. Nothing has been recorded.'; end if;
end $function$;
comment on function public.acknowledge_run_remark(uuid) is
  '0658: Accounts marks an Ops remark read (payroll.edit or payroll.approve). Finance Verify waits for it.';
revoke all on function public.acknowledge_run_remark(uuid) from public, anon;
grant execute on function public.acknowledge_run_remark(uuid) to authenticated;

-- ── HR's board remarks gain an acknowledgement ────────────────────────────
alter table public.attendance_board_remarks add column if not exists acknowledged_at timestamptz;
alter table public.attendance_board_remarks add column if not exists acknowledged_by uuid;
alter table public.attendance_board_remarks add column if not exists acknowledged_by_name text;

create or replace function public.acknowledge_board_remark(p_remark_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r public.attendance_board_remarks; v_name text; v_n int;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('attendance.ops_verify'); end if;
  if p_remark_id is not null then
    perform public.assert_same_company((select company_id from public.attendance_board_remarks where id = p_remark_id));
  end if;
  select * into r from public.attendance_board_remarks where id = p_remark_id for update;
  if r.id is null then raise exception 'That remark does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(coalesce(r.branch_id, (select branch_id from public.clients where id = r.client_id)));
  if r.acknowledged_at is not null then return; end if;
  select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
  update public.attendance_board_remarks
     set acknowledged_at = now(), acknowledged_by = auth.uid(), acknowledged_by_name = v_name
   where id = r.id and acknowledged_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The remark could not be acknowledged. Nothing has been recorded.'; end if;
end $function$;
comment on function public.acknowledge_board_remark(uuid) is
  '0658: Ops marks an HR remark on the monthly board read (attendance.ops_verify). Ops verify of that half waits for it.';
revoke all on function public.acknowledge_board_remark(uuid) from public, anon;
grant execute on function public.acknowledge_board_remark(uuid) to authenticated;

-- ── the gates ──────────────────────────────────────────────────────────────
create or replace function public.enforce_remarks_before_ops_verify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
  -- 0658. A definer trigger: it fires inside a write the caller already passed
  -- to make. Ops verify waits for HR's remarks to be acknowledged.
declare v_n int;
begin
  if new.ops_verified_at is null or (tg_op = 'UPDATE' and old.ops_verified_at is not null) then
    return new;
  end if;
  select count(*) into v_n from public.attendance_board_remarks br
   where br.company_id = new.company_id and br.period_month = new.period_month and br.half = new.half
     and br.kind = 'remark' and br.parent_id is null and br.acknowledged_at is null
     and coalesce(br.client_id::text, 'cat:' || br.category) = coalesce(new.client_id::text, 'cat:' || new.category)
     and (new.client_id is not null or br.branch_id is not distinct from new.branch_id);
  if v_n > 0 then
    raise exception 'This half has % remark% on the board that Ops has not acknowledged. Read and acknowledge them before verifying. Nothing has been recorded.',
      v_n, case when v_n = 1 then '' else 's' end using errcode = '23514';
  end if;
  return new;
end $function$;
revoke all on function public.enforce_remarks_before_ops_verify() from public, anon, authenticated;

drop trigger if exists trg_remarks_before_ops_verify on public.attendance_half_verifications;
create trigger trg_remarks_before_ops_verify
  before insert or update of ops_verified_at on public.attendance_half_verifications
  for each row execute function public.enforce_remarks_before_ops_verify();

create or replace function public.enforce_remarks_before_finance_verify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
  -- 0658. A definer trigger: it fires inside a write the caller already passed
  -- RLS to make. Finance Verify waits for Ops' remarks to be acknowledged.
declare v_n int;
begin
  if new.finance_verified_at is null or (tg_op = 'UPDATE' and old.finance_verified_at is not null) then
    return new;
  end if;
  select count(*) into v_n from public.run_remarks rr
   where rr.company_id = new.company_id and rr.period_month = new.period_month and rr.stage = 'ops_to_accounts'
     and rr.acknowledged_at is null
     and coalesce(rr.client_id::text, 'cat:' || rr.category) = coalesce(new.client_id::text, 'cat:' || new.category);
  if v_n > 0 then
    raise exception 'Ops left % remark% for this month that Accounts has not acknowledged. Read and acknowledge them before Finance Verify. Nothing has been recorded.',
      v_n, case when v_n = 1 then '' else 's' end using errcode = '23514';
  end if;
  return new;
end $function$;
revoke all on function public.enforce_remarks_before_finance_verify() from public, anon, authenticated;

drop trigger if exists trg_remarks_before_finance_verify on public.payroll_run_phases;
create trigger trg_remarks_before_finance_verify
  before insert or update of finance_verified_at on public.payroll_run_phases
  for each row execute function public.enforce_remarks_before_finance_verify();

-- ── assertions ─────────────────────────────────────────────────────────────
do $mig$
declare
  v_co uuid; v_cli uuid; v_half uuid; v_phase uuid; v_rem uuid; v_msg text; v_ok boolean := false;
begin
  select c.company_id, c.id into v_co, v_cli from public.clients c
   where c.company_id = (select id from public.companies where name ilike '%guards and guides%') limit 1;
  if v_cli is null then raise exception '0658 REFUSED: no client to test against.'; end if;

  begin
    -- Ops verify: refused with an open board remark, allowed once acknowledged.
    insert into public.attendance_half_verifications (company_id, client_id, period_month, half, hr_verified_at, updated_at)
    values (v_co, v_cli, '2026-01-01', 1, now(), now()) returning id into v_half;
    insert into public.attendance_board_remarks (company_id, client_id, period_month, half, kind, body)
    values (v_co, v_cli, '2026-01-01', 1, 'remark', '0658 test') returning id into v_rem;
    begin
      update public.attendance_half_verifications set ops_verified_at = now() where id = v_half;
      v_msg := '0658_NOT_REFUSED';
    exception when others then v_msg := sqlerrm;
    end;
    if v_msg not like 'This half has 1 remark on the board that Ops has not acknowledged.%' then
      raise exception '0658 REFUSED: Ops verify was not refused with its own message; got: %', v_msg;
    end if;
    perform public.acknowledge_board_remark(v_rem);
    update public.attendance_half_verifications set ops_verified_at = now() where id = v_half;

    -- Finance Verify: refused with an open ops_to_accounts remark, allowed once acknowledged.
    insert into public.payroll_run_phases (company_id, client_id, period_month, phase)
    values (v_co, v_cli, '2026-01-01', 'finance_verify') returning id into v_phase;
    insert into public.run_remarks (company_id, client_id, period_month, stage, body)
    values (v_co, v_cli, '2026-01-01', 'ops_to_accounts', '0658 test') returning id into v_rem;
    begin
      update public.payroll_run_phases set finance_verified_at = now() where id = v_phase;
      v_msg := '0658_NOT_REFUSED';
    exception when others then v_msg := sqlerrm;
    end;
    if v_msg not like 'Ops left 1 remark for this month that Accounts has not acknowledged.%' then
      raise exception '0658 REFUSED: Finance Verify was not refused with its own message; got: %', v_msg;
    end if;
    perform public.acknowledge_run_remark(v_rem);
    update public.payroll_run_phases set finance_verified_at = now() where id = v_phase;
    v_ok := true;
    raise exception '0658_SENTINEL';
  exception when others then
    if sqlerrm <> '0658_SENTINEL' then raise; end if;
  end;
  if not v_ok then raise exception '0658 REFUSED: the rolled-back test did not complete.'; end if;

  if exists (select 1 from public.security_gaps()) then raise exception '0658 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0658 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $mig$;