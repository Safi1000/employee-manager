-- 0538 — a region's cash profit counts its advances too
--
-- Found 2026-10-21, applying 0537: September's partnership showed Head Office
-- with a cash PROFIT of 57,000 — exactly two head-office staff advances
-- (Gul Rehman 55,000, Mehr Khan 2,000).
--
-- 0535 (DECIDED 2026-10-21: an advance is a cost in the month it is paid)
-- changed client_statement_loaded and ho_pool. It missed the third reader:
-- regional_pl_range, whose cash payroll is payslips.net_salary only. The
-- partnership's REGION rows — the profit the equity partner's residual is
-- made of — come from regional_pl_range. So after 0535:
--   * ISB/RWP was charged head office's advances through the head-office
--     apportionment (ho_pool has them), but head office's own cost did not
--     include them: a phantom +57,000 left at head office for the equity
--     partner;
--   * every region's own advances were missing from its profit, so the equity
--     partner's share was overstated by them (the regional partner's take,
--     computed from client statements, already had them).
-- Three readers of one fact, two of them changed: the defect CLAUDE.md names.
--
-- The change, by surgery against the live definition: a cash-basis advances
-- term (adv_c) beside pay_c, on the same cash date rule as 0535, placed
-- exactly where 0535 places it, and added into payroll_cash and profit_cash.
-- Dry runs placed it by the employee's region, then by client-else-employee
-- region, and both left head office at -25,000: reliever M. Riaz Akhtar is a
-- head-office employee assigned to the client "GGS Relief Pool", which has NO
-- region. 0535 charges his advance to that client (Unassigned); so must this.
-- Giving Relief Pool a region is a data decision, left to Shayan. Accrual basis untouched (an advance is not an
-- accrued cost).
--
-- Asserted on the thing that broke: head office's September partnership
-- profit is back to zero (its whole pool is apportioned out), and the region
-- totals fall by exactly September's advances.

do $mig$
declare
  v_src text; v_cnt int; v_a text; v_b text;
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_before numeric; v_after numeric; v_expect numeric; v_ho numeric;
begin
  select sum(profit_cash) into v_before from public.regional_pl_range('2026-09-01', '2026-09-30', v_co);

  v_src := pg_get_functiondef('public.regional_pl_range(date,date,uuid)'::regprocedure);
  if position('0538' in v_src) = 0 then
    -- 1. the advances term, beside pay_c
    v_a := E'\n  exp_a as (\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0538 REFUSED: exp_a anchor found % times.', v_cnt; end if;
    v_b := E'\n  adv_c as (\n'
        || E'    -- 0538. Advances, cash basis, in the month they are paid (0535). Placed\n'
        || E'    -- exactly where client_statement_loaded and ho_pool place them: with a\n'
        || E'    -- client (the advance''s, else the employee''s), that client''s region\n'
        || E'    -- (none = Unassigned); without one, the employee''s region.\n'
        || E'    select case when coalesce(a.client_id, e.client_id) is not null then ac.branch_id\n'
        || E'                else e.branch_id end as b, sum(a.amount)::numeric as amt\n'
        || E'      from public.advances a join public.employees e on e.id = a.employee_id\n'
        || E'      left join public.clients ac on ac.id = coalesce(a.client_id, e.client_id)\n'
        || E'      left join public.cheques ch on ch.id = a.cheque_id cross join cid\n'
        || E'     where a.company_id = cid.company_id\n'
        || E'       and coalesce(a.payment_mode, '''') <> ''Carry-forward''\n'
        || E'       and not public.scenario_excluded(coalesce(a.client_id, e.client_id), e.branch_id)\n'
        || E'       and (case when a.payment_mode = ''Cheque''\n'
        || E'                 then case when ch.status = ''cleared'' then ch.cleared_at::date end\n'
        || E'                 else a.advance_date end) between p_start and p_end group by 1\n'
        || E'  ),\n  exp_a as (\n';
    v_src := replace(v_src, v_a, v_b);

    -- 2. an Unassigned region also appears when only advances land there
    v_a := E'or exists (select 1 from exp_a where b is null) or exists (select 1 from exp_c where b is null)';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0538 REFUSED: regions anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, v_a || E'\n        or exists (select 1 from adv_c where b is null)');

    -- 3. into payroll_cash and profit_cash
    v_a := E'    coalesce(rcp.amt,0), coalesce(pay_c.amt,0), coalesce(exp_c.amt,0),\n'
        || E'    coalesce(rcp.amt,0) - coalesce(pay_c.amt,0) - coalesce(exp_c.amt,0)';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0538 REFUSED: select anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
               E'    coalesce(rcp.amt,0), coalesce(pay_c.amt,0) + coalesce(adv_c.amt,0) /* 0538 */, coalesce(exp_c.amt,0),\n'
            || E'    coalesce(rcp.amt,0) - coalesce(pay_c.amt,0) - coalesce(adv_c.amt,0) - coalesce(exp_c.amt,0)');

    v_a := E'  left join pay_c on pay_c.b is not distinct from r.id\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0538 REFUSED: join anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, v_a || E'  left join adv_c on adv_c.b is not distinct from r.id\n');

    execute v_src;
  end if;

  -- ── asserts ────────────────────────────────────────────────────────────────
  select sum(profit_cash) into v_after from public.regional_pl_range('2026-09-01', '2026-09-30', v_co);
  select coalesce(sum(a.amount), 0) into v_expect
    from public.advances a left join public.cheques ch on ch.id = a.cheque_id
   where a.company_id = v_co and coalesce(a.payment_mode, '') <> 'Carry-forward'
     and (case when a.payment_mode = 'Cheque' then case when ch.status = 'cleared' then ch.cleared_at::date end
               else a.advance_date end) between '2026-09-01' and '2026-09-30';
  if v_before <> v_after and abs((v_before - v_after) - v_expect) > 0.05 then
    raise exception '0538 REFUSED: September region profit fell by %, expected % (September advances).', v_before - v_after, v_expect;
  end if;

  select coalesce(sum(base_amount), 0) into v_ho
    from public.partnership_allocation('2026-09-01', '2026-09-30', 'cash', v_co) pa
    join public.branches b on b.id = pa.branch_id and b.is_head_office
   where pa.row_kind = 'REGION';
  if abs(v_ho) > 0.05 then
    raise exception '0538 REFUSED: head office still keeps % of September in the partnership.', v_ho;
  end if;
  raise notice '0538: September region cash profit % -> %; head office in the partnership %.', v_before, v_after, v_ho;
end $mig$;
