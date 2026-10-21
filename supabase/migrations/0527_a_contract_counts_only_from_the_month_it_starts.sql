-- 0527 — client_cover counts a contract only from the month it starts
--
-- client_cover(p_company_id, p_month) summed committed heads on every ACTIVE
-- guard-deployment contract, whatever month was asked for. A contract that
-- starts in October was therefore "contracted" in September too: Regent 1
-- (start 2026-10-01) read as a live September client with no September
-- invoice, and the Dashboard's billing check flagged it (2026-10-21). Shayan
-- approved the fix the same day.
--
-- The one change: the `con` CTE keeps a contract only when its start_date is
-- on or before the last day of the month asked for. Nothing else moves —
-- deployed, unbilled and payroll are untouched, and a contract past its end
-- date still counts as before (that is a separate question, not asked).
--
-- client_cover has one author (0516), so it is restated here behind a digest
-- precondition: if the live body is not the 0516 body this was written
-- against, the migration refuses rather than overwrite an edit nobody recorded
-- (CLAUDE.md, "A function edited by more than one migration").
--
-- Effect, named so it is not mistaken for a defect: for the current month
-- nothing changes unless a contract starts later in it; for an earlier month,
-- clients whose contract began after it drop out of `contracted`.

do $$
declare v_digest text;
begin
  select md5(pg_get_functiondef('public.client_cover(uuid,date)'::regprocedure)) into v_digest;
  if v_digest <> '93534cce6c0189c034a51f0a224e60f3' then
    raise exception '0527 REFUSED: client_cover''s live body (md5 %) is not the 0516 body this restates. Amend by surgery against pg_get_functiondef instead.', v_digest;
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.client_cover(p_company_id uuid, p_month date)
 RETURNS TABLE(client_id uuid, client_name text, contracted numeric, deployed numeric, unbilled_cover numeric, payroll_cost numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare v_m date := date_trunc('month', p_month)::date; v_e date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0516. Contracted vs deployed vs unbilled cover, per client — the same
  -- definitions the Contracted vs Deployed screen computes in the browser
  -- today, moved here so a dashboard tile and that screen cannot disagree:
  --   contracted  committed heads on personnel lines of active guard-deployment contracts
  --               that had started by the month's last day (0527)
  --   deployed    distinct guards marked present / double duty / relief cover FOR the client
  --   unbilled    deployed above contracted — cover the company absorbs (a report, not a failure)
  --   payroll     the accrual client statement's direct payroll (salary split by days worked)
  -- DEFERRED: ContractedVsDeployed.tsx should read this function once 0516 is
  -- applied, retiring its browser copy of the same rule.
  return query
  with con as (
    select k.client_id, sum(cl.committed_count)::numeric n
      from public.contracts k
      join public.clients c on c.id = k.client_id and c.company_id = p_company_id
      join public.contract_lines cl on cl.contract_id = k.id
     where k.status = 'active' and k.contract_type = 'guard_deployment'
       and (k.start_date is null or k.start_date <= v_e)
       and cl.category in ('SR_SUPERVISOR', 'ASST_SUPERVISOR', 'SUPERVISOR', 'GUARD', 'RELIEVER')
     group by 1
  ),
  dep as (
    select ar.worked_for_client_id cid, count(distinct ar.employee_id)::numeric n
      from public.attendance_records ar
      join public.employees e on e.id = ar.employee_id and e.company_id = p_company_id
     where ar.attendance_date between v_m and v_e
       and ar.status in ('present', 'double_duty', 'relief_cover')
       and ar.worked_for_client_id is not null
     group by 1
  ),
  pay as (
    select s.client_id, s.direct_payroll from public.client_statement_loaded(v_m, v_e, 'revenue', p_company_id) s
     where s.client_id is not null
  ),
  ids as (select client_id from con union select cid from dep union select client_id from pay where direct_payroll <> 0)
  select i.client_id, c.name::text, coalesce(con.n, 0), coalesce(dep.n, 0),
         greatest(coalesce(dep.n, 0) - coalesce(con.n, 0), 0), coalesce(pay.direct_payroll, 0)
    from ids i
    join public.clients c on c.id = i.client_id
    left join con on con.client_id = i.client_id
    left join dep on dep.cid = i.client_id
    left join pay on pay.client_id = i.client_id
   order by (coalesce(dep.n, 0) - coalesce(con.n, 0)) desc, c.name;
end $function$;

-- The fix, asserted on the case that found it: a contract starting after the
-- month asked for adds nothing to that month's contracted heads.
do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from public.companies co
    cross join lateral public.client_cover(co.id, '2026-09-01'::date) cv
    join public.contracts k on k.client_id = cv.client_id
   where cv.contracted > 0
     and k.status = 'active' and k.contract_type = 'guard_deployment'
     and not exists (select 1 from public.contracts k2
                      where k2.client_id = cv.client_id and k2.status = 'active'
                        and k2.contract_type = 'guard_deployment'
                        and (k2.start_date is null or k2.start_date <= '2026-09-30'));
  if v_bad <> 0 then
    raise exception '0527 REFUSED: % client(s) still read as contracted in September with no contract started by then.', v_bad;
  end if;
end $$;

-- Tenant guards: the restated body keeps its guard; the detector must read clean.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
