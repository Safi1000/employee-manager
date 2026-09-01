-- 0250 — The three month-batch RPCs refuse a closed period at the door.
--
-- DEV ONLY.
--
-- WHY REFUSAL AND NOT A PRIOR-PERIOD ADJUSTMENT
--
-- repost_payslip_accruals_for_month, run_ho_cost_allocation and
-- accrue_bonus_reserve do not post a delta. They reverse and repost an ENTIRE
-- month. Landing that in the current period would move the whole of July's
-- payroll expense out of July and into August, destroying A4, the revenue/cost
-- matching A4 exists for, July's regional P&L, and every partner share computed
-- on July.
--
-- A prior-period adjustment posts the DIFFERENCE and leaves the original where
-- it was. A reverse-and-repost moves everything. Only the first belongs in the
-- current period, and if PPA behaviour is ever wanted for these it is a
-- different mechanism — compute the delta, post only the delta, dated current —
-- and it must not be reachable by accident through a repost path.
--
-- These are also batch jobs. A month is closed deliberately. A batch that
-- silently restated a closed month into the current one would be discovered by
-- someone reading a P&L, not by anyone running the job.
--
-- FAIL EARLY, NOT DEEP IN A REVERSAL
--
-- Before 0250 the refusal came from post_journal several frames down, after the
-- reversal work had already been done and rolled back. The message named the
-- period but not the operation. The check now sits at the entry point, next to
-- the tenant guard, and names both.
--
-- The conditional in reverse_journal_for_source (0249) STAYS as defence in
-- depth. supabase/tests/batch_reposts_closed_month.sql asserts its closed
-- branch is UNREACHABLE from these three: if it ever becomes reachable, someone
-- has added a path and the test says so.

do $gen$
declare
  r       record;
  v_body  text;
  v_def   text;
  v_hdr   text;
  v_rest  text;
  v_guard text;
  p1      int;
  p2      int;
  v_done  int := 0;
  c_anchor constant text :=
    '  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;';
begin
  for r in
    select p.oid, p.proname, p.prosrc, m.period_expr
      from pg_proc p
      join (values ('repost_payslip_accruals_for_month', 'p_period_month'),
                   ('run_ho_cost_allocation',            'v_month'),
                   ('accrue_bonus_reserve',              'v_month'))
             as m(fn, period_expr) on m.fn = p.proname::text
     where p.pronamespace = 'public'::regnamespace
       and p.prosrc not like '%is_period_closed(p_company_id%'
  loop
    if position(c_anchor in r.prosrc) = 0 then
      raise exception '0250 could not find the tenant-guard anchor in % — refusing to guess an insertion point', r.proname;
    end if;

    v_guard := c_anchor || E'\n\n' ||
      '  -- Refuse a closed month AT THE DOOR (0250). This reverses and reposts an' || E'\n' ||
      '  -- entire month, not a delta, so allowing it against a closed period would' || E'\n' ||
      '  -- move that whole month out of itself. Reopening is the correction path.' || E'\n' ||
      format('  if public.is_period_closed(p_company_id, %s) then', r.period_expr) || E'\n' ||
      '    raise exception' || E'\n' ||
      format('      %L,', 'Period % is closed. ' || r.proname ||
             ' reverses and reposts the whole month, which would restate a closed period. Reopen the month in Period Close first.') || E'\n' ||
      format('      date_trunc(''month'', %s)::date', r.period_expr) || E'\n' ||
      '      using errcode = ''P0001'';' || E'\n' ||
      '  end if;';

    v_body := replace(r.prosrc, c_anchor, v_guard);

    v_def  := pg_get_functiondef(r.oid);
    p1     := strpos(v_def, '$function$');
    v_rest := substr(v_def, p1 + 10);
    p2     := strpos(v_rest, '$function$');
    v_hdr  := left(v_def, p1 - 1);

    execute v_hdr || '$function$' || v_body || '$function$' || substr(v_rest, p2 + 10);
    v_done := v_done + 1;
  end loop;

  if v_done <> 3 then
    raise exception '0250 guarded % of 3 batch RPCs', v_done;
  end if;
end
$gen$;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_p uuid; v_month date; v_msg text; v_ok boolean; v_n int;
    begin
      perform set_config('app.ledger_maintenance', 'off', true);
      select c.id into v_co from public.companies c
       where exists (select 1 from public.journal_entries je
                      where je.company_id = c.id and je.source_table = 'payslips')
         and exists (select 1 from public.profiles p
                      where p.company_id = c.id
                        and coalesce(p.role::text,'') <> 'super_super_admin')
       limit 1;
      if v_co is null then
        raise exception '0250 cannot self-test: no company with payslip postings and a non-SSA profile';
      end if;
      select p.id into v_p from public.profiles p
       where p.company_id = v_co and coalesce(p.role::text,'') <> 'super_super_admin' limit 1;
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_p::text, 'role','authenticated')::text, true);

      select je.posting_period into v_month
        from public.journal_entries je
       where je.company_id = v_co and je.source_table = 'payslips'
       group by je.posting_period order by count(*) desc limit 1;

      -- CONTROL: with the month OPEN the batch must still run. A guard that
      -- refuses everything would pass a refusal-only check and break the job.
      begin
        v_n := public.repost_payslip_accruals_for_month(v_co, v_month);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        raise exception '0250 BROKE THE BATCH: repost failed on an OPEN month (%)', v_msg;
      end;
      if v_n < 1 then
        raise exception '0250 self-test is VACUOUS: the open-month control reposted % payslips', v_n;
      end if;

      -- Now close it and require the refusal, naming the operation.
      insert into public.accounting_periods (company_id, period_month, closed_at)
      values (v_co, v_month, now());

      v_ok := false;
      begin
        perform public.repost_payslip_accruals_for_month(v_co, v_month);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg like '%is closed%' and v_msg like '%repost_payslip_accruals_for_month%');
      end;
      if not v_ok then
        raise exception '0250 FAILED: closed-month repost was not refused by name (msg: %)',
          coalesce(v_msg, '<no error at all>');
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0250 verification failed: %', v_outcome;
  end if;
end
$verify$;
