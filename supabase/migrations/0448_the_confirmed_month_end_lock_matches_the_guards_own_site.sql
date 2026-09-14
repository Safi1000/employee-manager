-- 0448 — the confirmed-month-end lock is PER SITE, not per client.
--
-- THE BUG. enforce_confirmed_month_end_lock() and its advisory twin
-- attendance_gate() decided "is this day confirmed?" by the guard's CLIENT,
-- ignoring which SITE he stands at:
--
--     and ((v_client is not null and c.client_id = v_client) ...)
--
-- A client that bills several sites off one contract (Nova Group runs Charsadda,
-- Islamabad, Peshawar, Qutbal; MIU runs three) therefore had ONE site's
-- confirmation lock EVERY site's guards for that date+shift. Confirming Nova
-- Charsadda/day on an ended month locked the Nova Peshawar day guards too —
-- even though Peshawar was never confirmed. The Daily board (which reads the
-- confirmation per SITE) correctly showed Peshawar unconfirmed, so the board and
-- the trigger disagreed and the operator got "confirmed … locked" on a day the
-- board says is open. Single-site clients were immune only by coincidence
-- (client = site).
--
-- THE FIX. Match the confirmation to the guard's OWN site — the site of the
-- deployment segment covering that date (else his most recent segment, which is
-- how the Monthly Board attributes a separated guard's marks to the site he left
-- from). A category group (office staff, v_client null) still matches by
-- category. And the shift predicate is dropped: attendance is a fact about a
-- DATE, not a shift (0423) — the frontend confirmation gate and attendance_payroll
-- already ignore shift, and the merged Daily board writes confirmations with
-- shift_code='all', which the old `c.shift_code = worked_shift` could never match.
-- After this, the trigger, attendance_gate and loadConfirmationGate/attendance_payroll
-- all agree: confirmed = (this guard's site, this date).
--
-- SURGERY, NOT RESTATEMENT. Both functions have been edited by several migrations
-- (0224/0405/0407 and the gate's own line) so neither has a canonical file. Each
-- is amended against its LIVE definition, with the client-wide predicate asserted
-- to appear EXACTLY ONCE; if it is missing or doubled the migration refuses.

-- 1) The hard lock (trigger function).
do $mig$
declare
  v_src text;
  v_new text;
  v_anchor text :=
'c.attendance_date=v_date and c.shift_code=v_shift
      and ((v_client is not null and c.client_id=v_client)
           or (v_client is null and v_cat is not null and c.category=v_cat))';
  v_repl text :=
'c.attendance_date=v_date
      and ((v_client is not null and c.site_id = (
              select d.site_id from public.deployments d
               where d.guard_id = v_emp and d.start_date <= v_date
               order by (d.end_date is null or d.end_date >= v_date) desc, d.start_date desc
               limit 1))
           or (v_client is null and v_cat is not null and c.category=v_cat))';
  v_cnt int;
begin
  v_src := pg_get_functiondef('public.enforce_confirmed_month_end_lock()'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_cnt <> 1 then
    raise exception '0448 REFUSED: expected the client-wide confirm predicate exactly once in enforce_confirmed_month_end_lock, found %.', v_cnt;
  end if;
  v_new := replace(v_src, v_anchor, v_repl);
  execute v_new;
end $mig$;

-- 2) The advisory gate (attendance_gate) — kept in step so the Daily board's
--    greying matches the trigger. This one was already shift-agnostic.
do $mig$
declare
  v_src text;
  v_new text;
  v_anchor text :=
'where c.attendance_date = p_date
         and ((e.client_id is not null and c.client_id = e.client_id)
              or (e.client_id is null and e.category is not null and c.category = e.category::text))';
  v_repl text :=
'where c.attendance_date = p_date
         and ((e.client_id is not null and c.site_id = (
                 select d.site_id from public.deployments d
                  where d.guard_id = p_guard and d.start_date <= p_date
                  order by (d.end_date is null or d.end_date >= p_date) desc, d.start_date desc
                  limit 1))
              or (e.client_id is null and e.category is not null and c.category = e.category::text))';
  v_cnt int;
begin
  v_src := pg_get_functiondef('public.attendance_gate(uuid,date,integer)'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_cnt <> 1 then
    raise exception '0448 REFUSED: expected the client-wide confirm predicate exactly once in attendance_gate, found %.', v_cnt;
  end if;
  v_new := replace(v_src, v_anchor, v_repl);
  execute v_new;
end $mig$;

-- 3) Verify the thing that can break: the client-wide predicate is gone from both,
--    the site-scoped subquery is present in both, and both still compile.
do $mig$
declare v_trig text; v_gate text;
begin
  v_trig := pg_get_functiondef('public.enforce_confirmed_month_end_lock()'::regprocedure);
  v_gate := pg_get_functiondef('public.attendance_gate(uuid,date,integer)'::regprocedure);
  if position('c.client_id=v_client' in v_trig) > 0 then
    raise exception '0448 FAILED: enforce_confirmed_month_end_lock still matches by client.';
  end if;
  if position('c.client_id = e.client_id' in v_gate) > 0 then
    raise exception '0448 FAILED: attendance_gate still matches by client.';
  end if;
  if position('c.site_id = (' in v_trig) = 0 or position('c.site_id = (' in v_gate) = 0 then
    raise exception '0448 FAILED: the site-scoped subquery is missing from one of the two functions.';
  end if;
  -- attendance_gate is STABLE and safe to call; a null guard returns "blocked".
  perform public.attendance_gate(null, current_date);
end $mig$;

-- 4) The tenant-guard tail required of every migration. Neither function gained
--    a tenant parameter, so no gap is opened; a green run here is evidence.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0448 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
