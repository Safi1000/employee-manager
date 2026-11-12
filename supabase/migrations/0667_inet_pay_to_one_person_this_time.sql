-- 0667 — iNet: pay a group's salaries to one or more receivers, this time only, as one row or one transfer
--
-- Asked 12 Nov 2026 (Shayan), initiating MIU's October salaries: most of MIU's
-- guards have no bank account; the site is paid into the site supervisor's
-- account, who cashes it and hands it out.
-- 0663 could already pay a guard to someone else, but only as a standing
-- setting made guard by guard on the profile, and initiate refused the rest.
--
-- DECIDED 12 Nov 2026 (Shayan):
--   * The receiver is chosen in the Initiate window, THIS TIME ONLY, with a
--     line showing where those guards' salary went last time.
--   * More than one receiver per initiation: MIU's October went to two
--     receivers the same day. Each guard is assigned to one receiver, or left
--     out.
--   * Both options: one row per guard, or one combined transfer to the
--     receiver ("33 lines is a bit too much"). This relaxes 0663's "never
--     grouped" for the bank FILE only: every payslip still has its own item,
--     its own amount and its own record; only the upload file joins the
--     receiver's items into one row. If the bank rejects that row, all of its
--     guards go back to unpaid together.
--   * Paid at release (when the bank pays the receiver), as with 0663.
--
-- The change:
--   1. inet_batches.combined — the file joins items paid to the same receiver
--      account into one row.
--   2. initiate_inet_payslips_to(bank, label, reference, date, items, pay_to,
--      combined) — pay_to is one receiver or a list of them, each with the
--      payslips it receives (a payslip under two receivers is refused). Sets
--      the receiver on each chosen guard (set_salary_payee,
--      so payroll.edit and a reason are required exactly as on the profile),
--      initiates through initiate_inet_payslips (bank.inet_initiate), then
--      ends each of those receivers with the note "This time only: <batch>".
--      The salary_payees rows stay as the record, which is also what "where
--      it went last time" reads. A guard who already has a standing receiver
--      is refused by name: initiate him normally, or stop that first.
--
-- Nothing is restated: initiate_inet_payslips, set_salary_payee and
-- end_salary_payee are called, not copied.

alter table public.inet_batches add column if not exists combined boolean not null default false;
comment on column public.inet_batches.combined is
  '0667: the upload file joins the items paid to the same receiver account into one row (one transfer). Each payslip '
  'keeps its own item. DECIDED 12 Nov 2026 (Shayan): offered beside one row per guard.';

create or replace function public.initiate_inet_payslips_to(p_bank_account_id uuid, p_label text, p_reference text,
                                                            p_transaction_date date, p_items jsonb, p_pay_to jsonb, p_combined boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ids uuid[]; v_all uuid[] := '{}'; v_ps record; v_open record; v_sp uuid; v_made uuid[] := '{}'; v_res jsonb;
  v_problems text[] := '{}'; v_batch text; v_k text; v_list jsonb; v_r jsonb;
begin
  -- 0667. Gates: bank.inet_initiate here; payroll.edit inside set_salary_payee.
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('bank.inet_initiate'); end if;
  if p_bank_account_id is not null then
    perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id));
  end if;
  v_list := case jsonb_typeof(p_pay_to) when 'array' then p_pay_to when 'object' then jsonb_build_array(p_pay_to) end;
  if v_list is null or jsonb_array_length(v_list) = 0 then
    raise exception 'Say who the salaries are paid to. Nothing has been recorded.';
  end if;
  for v_r in select * from jsonb_array_elements(v_list) loop
    select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(coalesce(v_r->'payslip_ids', '[]'::jsonb)) x;
    if coalesce(cardinality(v_ids), 0) = 0 then
      raise exception 'Choose the guards whose salary goes to %. Nothing has been recorded.', coalesce(v_r->>'payee_name', 'the receiver');
    end if;
    if v_all && v_ids then raise exception 'A guard is under two receivers. Nothing has been recorded.'; end if;
    v_all := v_all || v_ids;
  end loop;
  -- Every chosen payslip must be one of the items being initiated.
  if exists (select 1 from unnest(v_all) i
              where not exists (select 1 from jsonb_array_elements(p_items) it where (it->>'payslip_id')::uuid = i)) then
    raise exception 'A guard paid to a receiver is not in this initiation. Nothing has been recorded.';
  end if;

  -- A standing receiver is not overridden silently.
  for v_ps in select p.id, p.employee_id, p.company_id, e.full_name, e.branch_id
                from public.payslips p join public.employees e on e.id = p.employee_id where p.id = any(v_all) loop
    perform public.assert_same_company(v_ps.company_id);
    perform public.assert_branch_writable(v_ps.branch_id);
    select sp.payee_name into v_open from public.salary_payees sp where sp.employee_id = v_ps.employee_id and sp.ended_at is null;
    if v_open.payee_name is not null then
      v_problems := v_problems || format('%s is already paid to %s every month', v_ps.full_name, v_open.payee_name);
    end if;
  end loop;
  if cardinality(v_problems) > 0 then
    raise exception 'Not initiated — %. Untick them in "pay to a receiver", or stop that first on the profile. Nothing has been recorded.',
      array_to_string(v_problems, '; ') using errcode = '23514';
  end if;

  for v_r in select * from jsonb_array_elements(v_list) loop
    for v_ps in select p.employee_id from public.payslips p
                 where p.id in (select x::uuid from jsonb_array_elements_text(v_r->'payslip_ids') x) loop
      v_sp := public.set_salary_payee(v_ps.employee_id, v_r->>'payee_name', v_r->>'bank_name',
                                      v_r->>'account_no', v_r->>'iban', v_r->>'reason');
      v_made := v_made || v_sp;
    end loop;
  end loop;

  v_res := public.initiate_inet_payslips(p_bank_account_id, p_label, p_reference, p_transaction_date, p_items);

  for v_k in select jsonb_object_keys(coalesce(v_res->'batches', '{}'::jsonb)) loop
    v_batch := v_res->'batches'->>v_k;
    if coalesce(p_combined, false) then
      update public.inet_batches set combined = true where id = v_batch::uuid;
    end if;
  end loop;

  foreach v_sp in array v_made loop
    perform public.end_salary_payee(v_sp, format('This time only: %s', btrim(p_label)));
  end loop;

  return v_res || jsonb_build_object('paid_to', cardinality(v_made), 'combined', coalesce(p_combined, false));
end $function$;
comment on function public.initiate_inet_payslips_to(uuid, text, text, date, jsonb, jsonb, boolean) is
  '0667: initiate on iNet with some guards paid to receivers, this time only (salary_payees set, used, ended — kept '
  'as the record); optionally one combined transfer per receiver in the file.';
revoke all on function public.initiate_inet_payslips_to(uuid, text, text, date, jsonb, jsonb, boolean) from public, anon;
grant execute on function public.initiate_inet_payslips_to(uuid, text, text, date, jsonb, jsonb, boolean) to authenticated;

-- Asserted on what can break, rolled back by a sentinel.
do $mig$
declare
  v_soneri uuid := 'fd247f1d-e85c-4fd3-8eb5-23fd2f1d7439'; v_ps record; v_ps2 record; v_res jsonb; v_ok boolean := false;
  v_batch uuid; v_n int; v_open int; v_msg text; v_sp uuid;
begin
  begin
    perform set_config('request.jwt.claims', '{}', true);
    -- Two unpaid October payslips, neither with a standing receiver nor in transit.
    select p.id, p.employee_id, p.net_salary, p.amount_paid into v_ps
      from public.payslips p
     where p.period_month = '2026-10-01' and not p.disbursed and p.net_salary - p.amount_paid >= 1
       and not exists (select 1 from public.payroll_holds h where h.employee_id = p.employee_id and h.released_at is null)
       and not exists (select 1 from public.inet_items i where i.payslip_id = p.id and i.status = 'initiated')
       and not exists (select 1 from public.salary_payees s where s.employee_id = p.employee_id and s.ended_at is null)
     order by p.id limit 1;
    select p.id, p.employee_id, p.net_salary, p.amount_paid into v_ps2
      from public.payslips p
     where p.period_month = '2026-10-01' and not p.disbursed and p.net_salary - p.amount_paid >= 1 and p.id <> v_ps.id
       and p.employee_id <> v_ps.employee_id
       and not exists (select 1 from public.payroll_holds h where h.employee_id = p.employee_id and h.released_at is null)
       and not exists (select 1 from public.inet_items i where i.payslip_id = p.id and i.status = 'initiated')
       and not exists (select 1 from public.salary_payees s where s.employee_id = p.employee_id and s.ended_at is null)
     order by p.id limit 1;
    if v_ps.id is null or v_ps2.id is null then
      raise notice '0667: fewer than two unpaid October payslips; the test is skipped.';
    else
      v_res := public.initiate_inet_payslips_to(v_soneri, '0667 test', 'TEST', current_date,
        jsonb_build_array(
          jsonb_build_object('payslip_id', v_ps.id, 'amount', round(v_ps.net_salary - v_ps.amount_paid)),
          jsonb_build_object('payslip_id', v_ps2.id, 'amount', round(v_ps2.net_salary - v_ps2.amount_paid))),
        jsonb_build_array(
          jsonb_build_object('payee_name', '0667 Receiver', 'bank_name', 'Easypaisa (Wallet)', 'account_no', '03001234567',
                             'reason', '0667 test — no bank account', 'payslip_ids', jsonb_build_array(v_ps.id)),
          jsonb_build_object('payee_name', '0667 Second', 'bank_name', 'Easypaisa (Wallet)', 'account_no', '03111234567',
                             'reason', '0667 test — no bank account', 'payslip_ids', jsonb_build_array(v_ps2.id))),
        true);
      v_batch := (v_res->'batches'->>'IBFT')::uuid;
      if v_batch is null then raise exception '0667 REFUSED: no IBFT batch was made: %', v_res; end if;
      if not (select combined from public.inet_batches where id = v_batch) then
        raise exception '0667 REFUSED: the batch is not marked combined.';
      end if;
      select count(*) into v_n from public.inet_items
       where batch_id = v_batch and on_behalf_of is not null
         and ((payslip_id = v_ps.id and payee_name = '0667 Receiver' and account_no = '03001234567')
           or (payslip_id = v_ps2.id and payee_name = '0667 Second' and account_no = '03111234567'));
      if v_n <> 2 then raise exception '0667 REFUSED: expected each guard paid to his own receiver, found % of 2.', v_n; end if;
      -- one guard under two receivers is refused
      begin
        perform public.initiate_inet_payslips_to(v_soneri, '0667 test 3', 'TEST', current_date,
          jsonb_build_array(jsonb_build_object('payslip_id', v_ps.id, 'amount', 1)),
          jsonb_build_array(
            jsonb_build_object('payee_name', 'A', 'bank_name', 'Easypaisa (Wallet)', 'account_no', '03001234567', 'reason', '0667 dup test', 'payslip_ids', jsonb_build_array(v_ps.id)),
            jsonb_build_object('payee_name', 'B', 'bank_name', 'Easypaisa (Wallet)', 'account_no', '03001234568', 'reason', '0667 dup test', 'payslip_ids', jsonb_build_array(v_ps.id))),
          false);
        v_msg := '0667_NOT_REFUSED';
      exception when others then v_msg := sqlerrm; end;
      if v_msg not like 'A guard is under two receivers.%' then
        raise exception '0667 REFUSED: a guard under two receivers was not refused; got: %', v_msg;
      end if;
      -- this time only: no standing receiver is left on either guard
      select count(*) into v_open from public.salary_payees
       where employee_id in (v_ps.employee_id, v_ps2.employee_id) and ended_at is null;
      if v_open <> 0 then raise exception '0667 REFUSED: % receiver(s) were left standing.', v_open; end if;
      -- …but the record of where it went stays
      select count(*) into v_n from public.salary_payees
       where employee_id in (v_ps.employee_id, v_ps2.employee_id) and end_note = 'This time only: 0667 test';
      if v_n <> 2 then raise exception '0667 REFUSED: expected 2 "this time only" records, found %.', v_n; end if;

      -- a guard with a standing receiver is refused by name
      v_sp := public.set_salary_payee(v_ps.employee_id, 'Standing Receiver', 'Easypaisa (Wallet)', '03007654321', null, '0667 test standing');
      begin
        perform public.initiate_inet_payslips_to(v_soneri, '0667 test 2', 'TEST', current_date,
          jsonb_build_array(jsonb_build_object('payslip_id', v_ps.id, 'amount', 1)),
          jsonb_build_object('payee_name', 'X', 'bank_name', 'Easypaisa (Wallet)', 'account_no', '03001234567',
                             'reason', '0667 test second', 'payslip_ids', jsonb_build_array(v_ps.id)),
          false);
        v_msg := '0667_NOT_REFUSED';
      exception when others then v_msg := sqlerrm; end;
      if v_msg not like 'Not initiated — % is already paid to Standing Receiver every month%' then
        raise exception '0667 REFUSED: a standing receiver was not refused by name; got: %', v_msg;
      end if;
    end if;
    v_ok := true;
    raise exception '0667_SENTINEL';
  exception when others then
    if sqlerrm <> '0667_SENTINEL' then raise; end if;
  end;
  if not v_ok then raise exception '0667 REFUSED: the rolled-back test did not complete.'; end if;

  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0667 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0667 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps() where function_name = 'initiate_inet_payslips_to') then
    raise exception '0667 REFUSED: branch_guard_gaps() reports initiate_inet_payslips_to.';
  end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0667 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $mig$;