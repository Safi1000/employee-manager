-- 0657 — hold one guard's payslip; the rest of the client goes ahead
--
-- Asked 11 Nov 2026 (Shayan): "AWT has 7 guards — hold one guard's payslip,
-- approve the others. Now, due to one guard's discrepancy, the whole client is
-- stuck." Payroll Run signs off a client as a whole (payroll_run_phases), and
-- once a client is Finance Verified every payslip in it can be paid; there was
-- no way to keep ONE back while the question about him is answered.
--
-- The change:
--   1. payroll_holds — employee, pay month, reason, who held it and when; and
--      who released it, when, and why. One open hold per employee per month.
--   2. hold_payslip(employee, month, reason) / release_payslip_hold(hold, note)
--      — payroll.edit; a reason is required both ways.
--   3. A held payslip can still be calculated, saved and corrected, but NO
--      MONEY can be paid against it: trg_payslip_hold_blocks_payment refuses
--      any write that raises amount_paid or marks the payslip disbursed while
--      an open hold exists. It sits on the table, so it holds for
--      disburse_payslip, a bulk run, the auto-save and anything written later.
--      Lowering a payment (taking one back) is not blocked.
--
-- Not changed: Finance Verify of the client. A hold does not stop the client
-- being signed off — that is the point.
--
-- Asserted on what can break, on Waqas Ahmed's October payslip (34,000 of
-- 37,000 paid) inside a block rolled back by a sentinel: held, paying the
-- remaining 3,000 is refused with the hold's own message; released, the same
-- payment goes through.

create table if not exists public.payroll_holds (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  branch_id     uuid references public.branches(id),
  employee_id   uuid not null references public.employees(id),
  period_month  date not null check (period_month = date_trunc('month', period_month)::date),
  reason        text not null check (btrim(reason) <> ''),
  held_by       uuid default auth.uid(),
  held_at       timestamptz not null default now(),
  released_at   timestamptz,
  released_by   uuid,
  release_note  text
);
create unique index if not exists payroll_holds_one_open
  on public.payroll_holds (employee_id, period_month) where released_at is null;
create index if not exists payroll_holds_period_idx on public.payroll_holds (company_id, period_month);

comment on table public.payroll_holds is
  '0657: one guard''s payslip held for a month while a question is answered. No payment can be made against a held '
  'payslip (trg_payslip_hold_blocks_payment). Written only by hold_payslip / release_payslip_hold.';

alter table public.payroll_holds enable row level security;
revoke all on public.payroll_holds from anon, authenticated;
grant select on public.payroll_holds to authenticated;

drop policy if exists company_members on public.payroll_holds;
create policy company_members on public.payroll_holds for select
  using (company_id = (select public.current_company_id()));
drop policy if exists ssa_all on public.payroll_holds;
create policy ssa_all on public.payroll_holds for select
  using ((select public.is_ssa_unscoped()));
drop policy if exists branch_scope on public.payroll_holds;
create policy branch_scope on public.payroll_holds as restrictive for select
  using ((not (select public.is_branched_user())) or (select public.is_super_super_admin())
         or branch_id = (select public.current_branch_id())
         or employee_id in (select public.branch_scoped_employee_ids()));
drop policy if exists perm_read on public.payroll_holds;
create policy perm_read on public.payroll_holds as restrictive for select
  using ((select public.has_perm('payroll.view')) or (select public.has_perm('payroll.edit'))
         or (select public.has_perm('payroll.approve')) or (select public.has_perm('payroll.adjust'))
         or (select public.has_perm('accounting.edit')));

create or replace function public.hold_payslip(p_employee_id uuid, p_period_month date, p_reason text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_company uuid; v_branch uuid; v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('payroll.edit'); end if;
  if p_employee_id is not null then
    perform public.assert_same_company((select company_id from public.employees where id = p_employee_id));
  end if;
  select e.company_id, e.branch_id into v_company, v_branch from public.employees e where e.id = p_employee_id;
  if v_company is null then raise exception 'That employee does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(v_branch);
  if p_period_month is null then raise exception 'Choose the pay month. Nothing has been recorded.'; end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Say why this payslip is held. Nothing has been recorded.';
  end if;
  if exists (select 1 from public.payroll_holds h
              where h.employee_id = p_employee_id and h.period_month = date_trunc('month', p_period_month)::date
                and h.released_at is null) then
    raise exception 'This payslip is already on hold. Nothing has been recorded.';
  end if;
  insert into public.payroll_holds (company_id, branch_id, employee_id, period_month, reason)
  values (v_company, v_branch, p_employee_id, date_trunc('month', p_period_month)::date, btrim(p_reason))
  returning id into v_id;
  return v_id;
end $function$;
comment on function public.hold_payslip(uuid, date, text) is
  '0657: hold one employee''s payslip for a month (reason required). No payment can be made against it until released.';
revoke all on function public.hold_payslip(uuid, date, text) from public, anon;
grant execute on function public.hold_payslip(uuid, date, text) to authenticated;

create or replace function public.release_payslip_hold(p_hold_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare h public.payroll_holds; v_n int;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('payroll.edit'); end if;
  if p_hold_id is not null then
    perform public.assert_same_company((select company_id from public.payroll_holds where id = p_hold_id));
  end if;
  select * into h from public.payroll_holds where id = p_hold_id for update;
  if h.id is null then raise exception 'That hold does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(h.branch_id);
  if h.released_at is not null then raise exception 'This hold was already released. Nothing has been recorded.'; end if;
  if nullif(btrim(p_note), '') is null then
    raise exception 'Say how the question was settled. Nothing has been recorded.';
  end if;
  update public.payroll_holds
     set released_at = now(), released_by = auth.uid(), release_note = btrim(p_note)
   where id = h.id and released_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The hold could not be released. Nothing has been recorded.'; end if;
end $function$;
comment on function public.release_payslip_hold(uuid, text) is
  '0657: release a held payslip (note required); payment is allowed again.';
revoke all on function public.release_payslip_hold(uuid, text) from public, anon;
grant execute on function public.release_payslip_hold(uuid, text) to authenticated;

create or replace function public.enforce_payslip_hold()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
  -- 0657. A definer trigger: it fires inside a write the caller already passed
  -- RLS to make. Refuses paying anything against a held payslip.
declare h public.payroll_holds;
begin
  if not (
       (tg_op = 'INSERT' and (coalesce(new.amount_paid, 0) > 0 or coalesce(new.disbursed, false)))
    or (tg_op = 'UPDATE' and (coalesce(new.amount_paid, 0) > coalesce(old.amount_paid, 0)
                              or (coalesce(new.disbursed, false) and not coalesce(old.disbursed, false))))
  ) then
    return new;
  end if;
  select * into h from public.payroll_holds
   where employee_id = new.employee_id and period_month = date_trunc('month', new.period_month)::date
     and released_at is null
   limit 1;
  if h.id is null then return new; end if;
  raise exception '% payslip for % is on hold: %. Release the hold before paying. Nothing has been recorded.',
    coalesce((select e.full_name || '''s' from public.employees e where e.id = new.employee_id), 'This'),
    to_char(new.period_month, 'FMMonth YYYY'), h.reason
    using errcode = '23514';
end $function$;
revoke all on function public.enforce_payslip_hold() from public, anon, authenticated;

drop trigger if exists trg_payslip_hold_blocks_payment on public.payslips;
create trigger trg_payslip_hold_blocks_payment
  before insert or update of amount_paid, disbursed on public.payslips
  for each row execute function public.enforce_payslip_hold();

do $mig$
declare v_ps record; v_bank uuid; v_hold uuid; v_msg text; v_ok boolean := false;
begin
  select p.id, p.employee_id, p.period_month, p.amount_paid, p.net_salary into v_ps
    from public.payslips p join public.employees e on e.id = p.employee_id
   where e.full_name = 'Waqas Ahmed' and p.period_month = '2026-10-01' and not p.disbursed and round(p.amount_paid) = 34000;
  if v_ps.id is null then
    raise notice '0657: Waqas Ahmed''s October payslip is no longer part-paid; the payment test is skipped.';
  else
    select pm.bank_account_id into v_bank from public.payslip_payments pm where pm.payslip_id = v_ps.id limit 1;
    begin
      v_hold := public.hold_payslip(v_ps.employee_id, v_ps.period_month, '0657 test');
      begin
        perform public.disburse_payslip(v_ps.id, v_ps.amount_paid, v_ps.net_salary, 'Bank', v_bank, null, null, now(), '0657 test', null);
        v_msg := '0657_NOT_REFUSED';
      exception when others then v_msg := sqlerrm;
      end;
      if v_msg not like 'Waqas Ahmed''s payslip for October 2026 is on hold: 0657 test.%' then
        raise exception '0657 REFUSED: paying a held payslip was not refused with the hold''s message; got: %', v_msg;
      end if;
      perform public.release_payslip_hold(v_hold, '0657 test released');
      perform public.disburse_payslip(v_ps.id, v_ps.amount_paid, v_ps.net_salary, 'Bank', v_bank, null, null, now(), '0657 test', null);
      if not (select disbursed from public.payslips where id = v_ps.id) then
        raise exception '0657 REFUSED: after release the payment did not go through.';
      end if;
      v_ok := true;
      raise exception '0657_SENTINEL';
    exception when others then
      if sqlerrm <> '0657_SENTINEL' then raise; end if;
    end;
    if not v_ok then raise exception '0657 REFUSED: the rolled-back test did not complete.'; end if;
  end if;

  if exists (select 1 from public.security_gaps()) then raise exception '0657 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0657 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $mig$;