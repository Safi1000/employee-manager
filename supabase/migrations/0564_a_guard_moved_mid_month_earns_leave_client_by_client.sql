-- 0564 — a guard moved mid-month earns leave client by client
--
-- DECIDED 2026-10-26 (Shayan), answering 0558's DEFERRED note: "allowed leaves
-- and days calculation as per previous client once shifted according to new
-- clients of the remaining days".
--
-- Until now a guard on two contracts in one month earned on the AVERAGE quota
-- over his present days and ONE tier on the month's total — so a move between
-- a 2-leave and a 4-leave client gave a quota of 3, on neither client's rule.
-- From October 2026: each contract he stood on is a stretch; each stretch earns
-- on that contract's own quota and the present days he stood there, by the
-- same rule a full month uses (leave_earned_on: 0438's tiers, 0558's 2-leave
-- rule); the stretches add up. Then the 15-day cap, consumption and carry-over
-- work exactly as before.
--
-- Unchanged: a guard on one contract all month; a named override (it replaces
-- the contract's figure entirely, as 0438 decided); relievers (0540); every
-- period before October 2026.
--
-- leave_periods_all has three authors (0438, 0540, 0558): surgery against the
-- live definition, each anchor asserted to appear exactly once.

-- Every guard's September and October as they stand, to compare after.
-- (2026-10-26: the only two guards who moved this month moved between
-- contracts that give no leave, so nothing may change today.)
do $pre$
declare u uuid;
begin
  select id into u from public.profiles where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e'
     and coalesce(user_type, 'office_staff') <> 'partner' order by created_at limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  create temp table t0564_before on commit drop as
    select employee_id, period_start, earned, closing
      from public.leave_periods_all('7f7899a0-edd2-4491-a40d-f81b54c68d1e', '2026-10-31');
end $pre$;

do $surgery$
declare
  v_def text := pg_get_functiondef('public.leave_periods_all(uuid, date)'::regprocedure);
  a1 constant text := E'                 0)::numeric as q\n          from pd';
  a2 constant text := '      wq as (select employee_id, avg(q) as q from pq group by employee_id)';
  a3 constant text := E'                      wq.q, 0) as q\n        from ap';
  a4 constant text := E'        left join wq on wq.employee_id = ap.employee_id\n    loop';
  a5 constant text := '      v_earn := public.leave_earned_on(v_q, r.present_days, v_ms);  -- 0558: a 2-leave quota from October 2026';
  a text; v_n int;
begin
  if position('0564' in v_def) > 0 then return; end if;  -- replay
  foreach a in array array[a1, a2, a3, a4, a5] loop
    v_n := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
    if v_n <> 1 then raise exception '0564 REFUSED: an anchor appears % times in leave_periods_all: %', v_n, left(a, 60); end if;
  end loop;

  -- 1. each present day also names the contract it was earned on
  v_def := replace(v_def, a1,
    E'                 0)::numeric as q,\n' ||
    E'               coalesce(   -- 0564: the contract this day was stood on\n' ||
    E'                 (select l.contract_id\n' ||
    E'                    from public.deployments d\n' ||
    E'                    join public.contract_lines l on l.id = d.contract_line_id\n' ||
    E'                   where d.guard_id = pd.employee_id\n' ||
    E'                     and d.start_date <= pd.attendance_date\n' ||
    E'                     and coalesce(d.end_date, ''infinity''::date) >= pd.attendance_date\n' ||
    E'                   order by d.start_date desc limit 1),\n' ||
    E'                 (select e.contract_id from public.employees e where e.id = pd.employee_id)) as kid\n' ||
    E'          from pd');
  -- 2. the stretches: one per contract, earning on its own quota and days
  v_def := replace(v_def, a2, a2 || E',\n' ||
    E'      -- 0564: a guard moved mid-month earns each stretch on that contract''s own rule\n' ||
    E'      seg as (select employee_id, kid, max(q) as q, count(*)::int as days from pq group by employee_id, kid),\n' ||
    E'      sq as (select employee_id, count(*) as nseg, sum(public.leave_earned_on(q, days, v_ms)) as earned_seg\n' ||
    E'               from seg group by employee_id)');
  -- 3. carried to the loop, with whether the contract rule applies at all
  v_def := replace(v_def, a3,
    E'                      wq.q, 0) as q,\n' ||
    E'             sq.nseg, sq.earned_seg,\n' ||
    E'             (e.leave_quota_override is null and coalesce(e.category::text, '''') <> ''reliever'') as by_contract\n' ||
    E'        from ap');
  v_def := replace(v_def, a4,
    E'        left join wq on wq.employee_id = ap.employee_id\n' ||
    E'        left join sq on sq.employee_id = ap.employee_id\n' ||
    E'    loop');
  -- 4. the earning line
  v_def := replace(v_def, a5,
    E'      v_earn := case when v_ms >= date ''2026-10-01'' and r.by_contract and coalesce(r.nseg, 0) > 1\n' ||
    E'                     then r.earned_seg::int   -- 0564: moved mid-month, client by client\n' ||
    E'                     else public.leave_earned_on(v_q, r.present_days, v_ms) end;  -- 0558: a 2-leave quota from October 2026');
  execute v_def;
end $surgery$;

do $$
begin
  if position('earned_seg' in pg_get_functiondef('public.leave_periods_all(uuid, date)'::regprocedure)) = 0 then
    raise exception '0564 REFUSED: leave_periods_all does not earn client by client.';
  end if;
  if exists (
    select 1 from t0564_before b
      full join public.leave_periods_all('7f7899a0-edd2-4491-a40d-f81b54c68d1e', '2026-10-31') a
        on a.employee_id = b.employee_id and a.period_start = b.period_start
     where (a.earned, a.closing) is distinct from (b.earned, b.closing)) then
    raise exception '0564 REFUSED: a September or October leave figure moved; no guard moved between leave-giving contracts.';
  end if;
  perform set_config('request.jwt.claims', '', true);
end $$;
