-- 0654 — a payslip paid in parts posts each part to the ledger when it is paid
--
-- Found 11 Nov 2026 in the standards audit. Waqas Ahmed (YY-002) earns 37,000
-- for October; 34,000 was paid from Askari at 10:48. disburse_payslip moved the
-- bank 34,000 (apply_money_delta) and wrote the part (payslip_payments), but
-- the ledger posts a payslip's disbursement only once it is FULLY paid
-- (post_payslip_disbursement returns early while `disbursed` is false). So the
-- bank account fell 34,000 and the Askari GL did not move:
-- bank_control_equals_bank_accounts went red by exactly 34,000, and
-- bank_per_account_gl_equals_operational red on Askari. A partly paid payslip
-- was a hole between the bank and the books for as long as it stayed partly
-- paid — which, for a guard paid in instalments, can be weeks.
--
-- This closes 0541's DEFERRED note ("one journal entry per payslip_payments
-- row"). DECIDED 11 Nov 2026 (Shayan): "post it as entry for each payment".
--
-- The change:
--   1. sync_payslip_part_journals(payslip) — the one place that decides what
--      the parts of a payslip should have in the ledger:
--        * not yet fully paid, something paid → every part has its own entry,
--          dated the day it was paid: Dr salaries payable, Cr the channel it
--          left by (settlement_account, exactly as 0541 credits it). A
--          negative part (a payment taken back) posts the mirror image.
--        * fully paid → the part entries are reversed on the disbursement
--          date, because post_payslip_disbursement then posts the whole net
--          with one credit per channel (0541) as before. Each month carries
--          the cash that actually moved in it: 34,000 out in November, then
--          on completion +34,000 reversed and 37,000 posted — 3,000 net.
--        * nothing paid (reverse_payslip_disbursement sets amount_paid 0 and
--          then deletes the parts) → nothing posted, so a reversal makes no
--          post-then-reverse noise.
--   2. journal_on_payslip() calls it on every UPDATE, after its own branches.
--      journal_on_payslip has more than one author (0223, 0242, 0269, 0541 …):
--      surgery, one anchor asserted to appear exactly once.
--   3. A part deleted while its entry is live (a deleted payslip cascades to
--      its parts) reverses that entry: trg_payslip_payments_unpost.
--   4. Backfill: every payslip partly paid today gets its part entries
--      (Waqas's 34,000, dated 11 Nov).
--   5. salaries_payable_equals_undisbursed_net_pay (ledger_checks_base) counted
--      a partly paid payslip's WHOLE net as owed. Once the parts post, the
--      payable falls by what was paid, so the check would go red by exactly
--      the parts (measured in the dry run: 0 -> -34,000). It now counts net
--      less the parts — what the ledger says is still owed. ledger_checks_base
--      has many authors: surgery, anchor asserted once.
--
-- Also asserted: no GGS check gets worse. Every check's |difference| after
-- the migration is at most what it was before (dry run: the two bank checks
-- 34,000 -> 0 and 1 -> 0, nothing else moved).
--
-- Not changed: post_payslip_disbursement (fully paid payslips post exactly as
-- before, so no existing entry moves) and disburse_payslip.
--
-- Both new functions are definer and internal: called only from triggers, so
-- revoked from every API role.
--
-- Asserted on what can break:
--   a. Waqas's part posts 34,000 to Askari's GL account, dated 11 Nov, and the
--      GGS bank control that was red by 34,000 is no longer off by it.
--   b. Paying his last 3,000 (inside a block rolled back by a sentinel)
--      reverses the 34,000 part entry and posts the full 37,000 — the payslip's
--      live entries against Askari's GL total exactly -37,000, not -71,000
--      (part + full, the double count) and not -37,000 + 34,000 left over.

create or replace function public.sync_payslip_part_journals(p_payslip_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ps     record;
  pm     record;
  v_acct uuid;
  v_amt  numeric;
  v_dim  jsonb;
begin
  if p_payslip_id is not null then
    perform public.assert_same_company((select company_id from public.payslips where id = p_payslip_id));
  end if;

  select * into ps from public.payslips where id = p_payslip_id;
  if not found then return; end if;

  if ps.disbursed then
    -- Fully paid: post_payslip_disbursement carries every part. Retire the
    -- part entries on the disbursement date.
    for pm in select id from public.payslip_payments where payslip_id = ps.id loop
      perform public.reverse_journal_for_source(ps.company_id, 'payslip_payments', pm.id,
                coalesce(ps.disbursed_at::date, current_date));
    end loop;
    return;
  end if;

  if round(coalesce(ps.amount_paid, 0)) = 0 then
    return;   -- nothing paid, or a reversal on its way to deleting the parts
  end if;

  v_dim := jsonb_build_object('employee_id', ps.employee_id,
             'client_id', (select e.client_id from public.employees e where e.id = ps.employee_id));

  for pm in
    select p.* from public.payslip_payments p
     where p.payslip_id = ps.id
       and p.amount <> 0
       and not exists (
         select 1 from public.journal_entries je
          where je.company_id = ps.company_id
            and je.source_table = 'payslip_payments' and je.source_id = p.id
            and je.is_reversal = false
            and not exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id))
     order by p.paid_at, p.created_at
  loop
    v_acct := public.settlement_account(ps.company_id, pm.payment_mode,
                                        pm.bank_account_id, pm.custodian_location_id, true);
    v_amt := abs(pm.amount);
    perform public.post_journal(
      ps.company_id, pm.paid_at::date,
      'Payroll part-paid — ' || left(ps.period_month::text, 7),
      'payslip_payments', pm.id, false,
      case when pm.amount > 0 then
        jsonb_build_array(
          v_dim || jsonb_build_object('key', 'salaries_payable', 'debit', v_amt, 'credit', 0),
          v_dim || jsonb_build_object('account_id', v_acct, 'debit', 0, 'credit', v_amt))
      else
        jsonb_build_array(
          v_dim || jsonb_build_object('account_id', v_acct, 'debit', v_amt, 'credit', 0),
          v_dim || jsonb_build_object('key', 'salaries_payable', 'debit', 0, 'credit', v_amt))
      end,
      ps.branch_id);
  end loop;
end $function$;

comment on function public.sync_payslip_part_journals(uuid) is
  '0654: a partly paid payslip posts each payslip_payments part on the day it was paid (Dr salaries payable, '
  'Cr its channel); on full payment the part entries are reversed and post_payslip_disbursement posts the whole. '
  'DECIDED 11 Nov 2026 (Shayan): an entry for each payment. Called from journal_on_payslip only.';

revoke all on function public.sync_payslip_part_journals(uuid) from public, anon, authenticated;

create or replace function public.unpost_payslip_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
  -- 0654. A definer trigger: it fires inside a delete the caller already
  -- passed RLS to make. A part that goes keeps no live ledger entry.
begin
  perform public.reverse_journal_for_source(old.company_id, 'payslip_payments', old.id, old.paid_at::date);
  return old;
end $function$;

revoke all on function public.unpost_payslip_payment() from public, anon, authenticated;

drop trigger if exists trg_payslip_payments_unpost on public.payslip_payments;
create trigger trg_payslip_payments_unpost
  after delete on public.payslip_payments
  for each row execute function public.unpost_payslip_payment();

drop table if exists pg_temp._0654_before;
create temp table _0654_before as
  select co.id as company_id, c.check_name, abs(coalesce(c.difference, 0)) as d
    from public.companies co cross join lateral public.ledger_checks(co.id) c
   where exists (select 1 from public.ledger_check_results x where x.company_id = co.id);

do $mig$
declare
  v_def  text;
  v_hits int;
  c1 constant text := '    select coalesce(sum(ps.net_salary) filter (where not ps.disbursed), 0) owed';
  c2 constant text := E'    -- 0654: a partly paid payslip owes its net less the parts already posted.\n    select coalesce(sum(ps.net_salary - coalesce((select sum(pm.amount) from public.payslip_payments pm\n                                                   where pm.payslip_id = ps.id), 0))\n                    filter (where not ps.disbursed), 0) owed';
  a constant text := E'    perform public.post_payslip_disbursement(new.id);\n  end if;\n\n  return new;\nend;';
  b constant text := E'    perform public.post_payslip_disbursement(new.id);\n  end if;\n\n  -- 0654: the parts of a payslip not yet fully paid post when paid.\n  perform public.sync_payslip_part_journals(new.id);\n\n  return new;\nend;';
  r record;
begin
  select pg_get_functiondef('public.journal_on_payslip()'::regprocedure) into v_def;
  if position('sync_payslip_part_journals' in v_def) = 0 then
    v_hits := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
    if v_hits <> 1 then
      raise exception '0654 REFUSED: journal_on_payslip anchor appears % times, expected 1.', v_hits;
    end if;
    execute replace(v_def, a, b);
  end if;

  select pg_get_functiondef('public.ledger_checks_base'::regproc) into v_def;
  if position('0654: a partly paid payslip' in v_def) = 0 then
    v_hits := (length(v_def) - length(replace(v_def, c1, ''))) / length(c1);
    if v_hits <> 1 then
      raise exception '0654 REFUSED: ledger_checks_base payroll_owed anchor appears % times, expected 1.', v_hits;
    end if;
    execute replace(v_def, c1, c2);
  end if;

  -- Backfill: every payslip partly paid today.
  for r in select p.id from public.payslips p
            where not p.disbursed and round(coalesce(p.amount_paid, 0)) <> 0
              and exists (select 1 from public.payslip_payments pm where pm.payslip_id = p.id) loop
    perform public.sync_payslip_part_journals(r.id);
  end loop;
end $mig$;

-- a. and b. — on Waqas Ahmed's October payslip, if it is still partly paid.
do $mig$
declare
  v_ps   uuid;
  v_co   uuid;
  v_bank uuid;
  v_gl   uuid;
  v_paid numeric;
  v_net  numeric;
  v_part numeric;
  v_live numeric;
  v_diff numeric;
begin
  select p.id, p.company_id, p.amount_paid, p.net_salary into v_ps, v_co, v_paid, v_net
    from public.payslips p join public.employees e on e.id = p.employee_id
   where e.full_name = 'Waqas Ahmed' and p.period_month = '2026-10-01' and not p.disbursed
     and round(p.amount_paid) = 34000;
  if v_ps is null then
    raise notice '0654: Waqas Ahmed''s October payslip is no longer partly paid at 34,000; asserting on every part instead.';
    if exists (
      select 1 from public.payslips p join public.payslip_payments pm on pm.payslip_id = p.id
       where not p.disbursed and round(coalesce(p.amount_paid, 0)) <> 0 and pm.amount <> 0
         and not exists (select 1 from public.journal_entries je
                          where je.source_table = 'payslip_payments' and je.source_id = pm.id and not je.is_reversal
                            and not exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id))) then
      raise exception '0654 REFUSED: a part of a partly paid payslip has no live ledger entry.';
    end if;
    return;
  end if;

  select pm.bank_account_id into v_bank from public.payslip_payments pm where pm.payslip_id = v_ps limit 1;
  v_gl := public.settlement_account(v_co, 'Bank', v_bank, null, true);

  -- a. the part is posted, 34,000 to Askari's GL, dated the day it was paid.
  select coalesce(sum(jl.credit - jl.debit), 0) into v_part
    from public.payslip_payments pm
    join public.journal_entries je on je.source_table = 'payslip_payments' and je.source_id = pm.id
    join public.journal_lines jl on jl.journal_entry_id = je.id and jl.account_id = v_gl
   where pm.payslip_id = v_ps and je.entry_date = pm.paid_at::date;
  if round(v_part) <> 34000 then
    raise exception '0654 REFUSED: Waqas''s part posted % to the Askari GL, expected 34,000 on the day paid.', v_part;
  end if;

  select c.difference into v_diff from public.ledger_checks(v_co) c
   where c.check_name = 'bank_control_equals_bank_accounts';
  if round(abs(coalesce(v_diff, 0))) = 34000 then
    raise exception '0654 REFUSED: the bank control is still off by exactly 34,000 after posting the part.';
  end if;

  -- b. finish paying him, then roll back.
  begin
    perform public.disburse_payslip(v_ps, v_paid, v_net, 'Bank', v_bank, null, null, now(),
                                    '0654 test — rolled back', null);
    select coalesce(sum(jl.credit - jl.debit), 0) into v_live
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id and jl.account_id = v_gl
     where (je.source_table = 'payslips_disbursement' and je.source_id = v_ps)
        or (je.source_table = 'payslip_payments'
            and je.source_id in (select id from public.payslip_payments where payslip_id = v_ps));
    if round(v_live) <> round(v_net) then
      raise exception '0654 REFUSED: after paying in full, Askari''s GL shows % out for this payslip, expected % (no double count).', v_live, v_net;
    end if;
    raise exception '0654_SENTINEL';
  exception when others then
    if sqlerrm <> '0654_SENTINEL' then raise; end if;
  end;

end $mig$;

-- c. Nothing got worse, and the catalogue is clean.
do $mig$
declare v_worse text;
begin
  -- No check got worse, on any company the nightly job evaluates.
  with co as (select distinct company_id from _0654_before),
  aft as (select co.company_id, c.check_name, abs(coalesce(c.difference, 0)) as d
            from co cross join lateral public.ledger_checks(co.company_id) c)
  select string_agg(b.check_name || ' ' || b.d || ' -> ' || a.d, ', ') into v_worse
    from _0654_before b join aft a using (company_id, check_name)
   where a.d > b.d + 0.005;
  if v_worse is not null then
    raise exception '0654 REFUSED: a ledger check is further from passing than before: %', v_worse;
  end if;

  if exists (select 1 from public.security_gaps()) then
    raise exception '0654 REFUSED: security_gaps() reports a gap.';
  end if;
  if exists (select 1 from public.tenant_guard_gaps()) then
    raise exception '0654 REFUSED: tenant_guard_gaps() reports a gap.';
  end if;
end $mig$;

drop table pg_temp._0654_before;