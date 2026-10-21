-- 0535 — an advance is a cost in the month it is paid
--
-- Found 2026-10-21 reconciling Col Nauman's September share against the GGS
-- sheet: on the CASH basis, client_statement_loaded() — and so the partnership
-- allocation that reads it — never counted an advance at all. Payroll cash is
-- payslips.net_salary, which is already NET of the advance it recovers, and
-- nothing anywhere added the advance itself. So every advance quietly raised
-- the profit a partner is shared on: not counted when paid, not counted when
-- recovered.
--
-- DECIDED 2026-10-21 (Shayan): an advance is charged in the month it is PAID
-- (Bastion's existing dating, not the sheet's "gross pay in the month it is
-- settled"). Recovery from a later payslip is then correctly not a cost again,
-- because net_salary is already reduced by it.
--
-- The change, by surgery against the LIVE definitions (both functions have
-- been edited by many migrations — CLAUDE.md, "A function edited by more than
-- one migration has no canonical file"), each anchor asserted exactly once:
--
--   client_statement_loaded   one more arm in pay_split: cash-basis advances,
--                             on their cash date (a cheque when it clears),
--                             to the advance's client, else the employee's
--                             client, else the employee's region overhead —
--                             exactly where that person's salary would go.
--   ho_pool                   the head-office cash pool gains head-office
--                             staff advances, so they are apportioned like
--                             head-office salaries.
--
-- Accrual basis untouched: an advance is a receivable, not an expense, until
-- the payroll that recovers it accrues.
-- Carry-forward rows (payroll overpayments, payment_mode 'Carry-forward') are
-- excluded: no cash moves.
--
-- KNOWN GAP, left visible: an employee with neither a client nor a region is
-- costed to the "Unassigned" region, which no partner shares in (on
-- 2026-10-21, reliever Anjum Sharafat — 32,000 in September). Give him a
-- region and his advances follow into that region's share.
--
-- Verified in-migration on GGS September 2026: the statement's company total
-- must fall by EXACTLY the September advances (to within the 0.05 that the
-- per-client split rounds away) — an advance dropped or counted twice moves
-- it. A dry run on 2026-10-21 moved it by 186,500.01 against 186,500.00, and
-- Col Nauman's September share from 431,766.56 to 394,309.10. Idempotent: a
-- function already carrying the 0535 marker is left alone.

do $mig$
declare
  v_co      constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_before  numeric;
  v_after   numeric;
  v_expect  numeric;
  v_src     text;
  v_cnt     int;
  v_anchor  text;
  v_insert  text;
begin
  select sum(net) into v_before
    from public.client_statement_loaded('2026-09-01', '2026-09-30', 'cash', v_co);

  -- ── client_statement_loaded ────────────────────────────────────────────────
  v_src := pg_get_functiondef('public.client_statement_loaded(date,date,text,uuid)'::regprocedure);
  if position('0535' in v_src) = 0 then
    v_anchor := E'        where t.employee_id = ps.employee_id and t.period_month = ps.period_month and t.total_d > 0)\n  ),\n  pay_client as';
    v_cnt := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    if v_cnt <> 1 then
      raise exception '0535 REFUSED: client_statement_loaded anchor found % times, expected 1. Read the live body; do not widen the anchor.', v_cnt;
    end if;
    v_insert := E'        where t.employee_id = ps.employee_id and t.period_month = ps.period_month and t.total_d > 0)\n'
             || E'    union all\n'
             || E'    -- 0535. ADVANCES, CASH BASIS, IN THE MONTH THEY ARE PAID. net_salary above\n'
             || E'    -- is already net of the advance it recovers, so this is the only place an\n'
             || E'    -- advance becomes a cost. Same home as the person''s salary.\n'
             || E'    select coalesce(a.client_id, e.client_id), e.branch_id, a.amount::numeric\n'
             || E'      from public.advances a\n'
             || E'      join public.employees e on e.id = a.employee_id\n'
             || E'      left join public.cheques ch on ch.id = a.cheque_id\n'
             || E'      cross join cid cross join cash\n'
             || E'     where a.company_id = cid.company_id and cash.on_cash\n'
             || E'       and coalesce(a.payment_mode, '''') <> ''Carry-forward''\n'
             || E'       and (case when a.payment_mode = ''Cheque''\n'
             || E'                 then case when ch.status = ''cleared'' then ch.cleared_at::date end\n'
             || E'                 else a.advance_date end) between p_start and p_end\n'
             || E'  ),\n  pay_client as';
    execute replace(v_src, v_anchor, v_insert);
  end if;

  -- ── ho_pool ────────────────────────────────────────────────────────────────
  v_src := pg_get_functiondef('public.ho_pool(uuid,date,date,text)'::regprocedure);
  if position('0535' in v_src) = 0 then
    v_anchor := E'           between p_start and p_end;\n\n    select v_amt + coalesce(sum(x.amount), 0) into v_amt';
    v_cnt := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    if v_cnt <> 1 then
      raise exception '0535 REFUSED: ho_pool anchor found % times, expected 1. Read the live body; do not widen the anchor.', v_cnt;
    end if;
    v_insert := E'           between p_start and p_end;\n\n'
             || E'    -- 0535. Head-office staff advances, in the month they are paid.\n'
             || E'    select v_amt + coalesce(sum(a.amount), 0) into v_amt\n'
             || E'      from public.advances a\n'
             || E'      join public.employees e on e.id = a.employee_id\n'
             || E'      left join public.cheques ch on ch.id = a.cheque_id\n'
             || E'     where a.company_id = p_company_id and e.branch_id = v_ho\n'
             || E'       and coalesce(a.client_id, e.client_id) is null\n'
             || E'       and coalesce(a.payment_mode, '''') <> ''Carry-forward''\n'
             || E'       and (case when a.payment_mode = ''Cheque''\n'
             || E'                 then case when ch.status = ''cleared'' then ch.cleared_at::date end\n'
             || E'                 else a.advance_date end) between p_start and p_end;\n\n'
             || E'    select v_amt + coalesce(sum(x.amount), 0) into v_amt';
    execute replace(v_src, v_anchor, v_insert);
  end if;

  -- ── the assertion: on the thing that can break ─────────────────────────────
  -- Every September advance must reduce the company total by its amount — no
  -- more, no less. One silently dropped, or counted twice, moves this.
  select sum(net) into v_after
    from public.client_statement_loaded('2026-09-01', '2026-09-30', 'cash', v_co);

  select coalesce(sum(a.amount), 0) into v_expect
    from public.advances a
    join public.employees e on e.id = a.employee_id
    left join public.cheques ch on ch.id = a.cheque_id
   where a.company_id = v_co
     and coalesce(a.payment_mode, '') <> 'Carry-forward'
     and (case when a.payment_mode = 'Cheque' then case when ch.status = 'cleared' then ch.cleared_at::date end
               else a.advance_date end) between '2026-09-01' and '2026-09-30';

  -- Already applied: before and after are equal, and that is correct.
  if v_before = v_after then
    raise notice '0535: functions already carry the change; nothing re-applied.';
  elsif abs((v_before - v_after) - v_expect) > 0.05 then
    raise exception '0535 REFUSED: September total moved by %, expected % (September advances).',
      round(v_before - v_after, 2), round(v_expect, 2);
  end if;
  raise notice '0535: GGS September company total % -> % (advances charged %).', v_before, v_after, v_expect;

  if (select count(*) from public.tenant_guard_gaps()) <> 0 then
    raise exception '0535 REFUSED: tenant_guard_gaps() is not empty.';
  end if;
end $mig$;
