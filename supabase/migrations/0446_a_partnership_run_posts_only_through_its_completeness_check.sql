-- 0446 — a partnership run posts only through its completeness check.
--
-- THE GAP. run_profit_allocation(p_company_id, p_period, p_basis, p_post
-- default TRUE) was executable by `authenticated`. Any logged-in user could
-- call it directly and post a month to every partner's capital account,
-- skipping both gates that live in post_profit_allocation: the
-- partnership.post permission, and the completeness question
-- (partnership_uninvoiced_clients — "N clients live this month have no
-- invoice; post anyway only if that is deliberate").
--
-- THE DESIGN THIS RESTORES — DECIDED (Shayan, 2026-09-15): BLOCK THE POST, KEEP
-- THE DRAFT. Drafting is how an incomplete month is found out; refusing it at
-- draft leaves a refusal naming 27 clients and no provisional month to look at.
-- So completeness is asked at POST, where post_profit_allocation already asks
-- it, and p_confirm_incomplete stays: a named human decision to allocate an
-- incomplete month, which is what it was built to be.
--
-- An earlier draft of 0446 (never applied) put the completeness question into
-- partnership_run_blocker. run_profit_allocation calls the blocker for drafts
-- too, so that refused the draft and made p_confirm_incomplete unreachable. It
-- was withdrawn for that reason; the blocker is unchanged here and keeps its one
-- job — refusing a month whose head-office pool has nothing to land on.
--
-- THE FIX is one privilege. run_profit_allocation is reached only through its
-- two definer wrappers: draft_profit_allocation (stops at DRAFT) and
-- post_profit_allocation (permission, completeness, staleness, then post).
-- Both are owned by postgres and keep calling it. service_role keeps execute
-- for server-side maintenance; it is not a person and has no permission set.

revoke execute on function public.run_profit_allocation(uuid, date, text, boolean) from public, anon, authenticated;

comment on function public.run_profit_allocation(uuid, date, text, boolean) is
  '0446: NOT callable by authenticated. Reached only through draft_profit_allocation and post_profit_allocation, so a post always passes partnership.post and the completeness check.';

comment on function public.post_profit_allocation(uuid, boolean) is
  '0446: the ONLY route by which a user posts a partnership run. Completeness is asked HERE, not at draft — DECIDED: block the post, keep the draft. p_confirm_incomplete is the named human decision to post a month with uninvoiced clients.';

comment on function public.partnership_run_blocker(uuid, date) is
  '0446: refuses a DRAFT only when head office has a cost pool and nothing to apportion it over. It deliberately does NOT ask completeness: that is asked at post by post_profit_allocation (DECIDED: block the post, keep the draft).';

-- ---------------------------------------------------------------------------
-- THE ASSERTIONS. The failure being guarded against is "a user can post
-- without the gate", so assert on the privilege itself, then on the gate.
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('authenticated', 'public.run_profit_allocation(uuid,date,text,boolean)', 'execute') then
    raise exception '0446 FAILED: authenticated can still execute run_profit_allocation.';
  end if;
  if has_function_privilege('anon', 'public.run_profit_allocation(uuid,date,text,boolean)', 'execute') then
    raise exception '0446 FAILED: anon can execute run_profit_allocation.';
  end if;
  if not has_function_privilege('authenticated', 'public.draft_profit_allocation(uuid,date,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.post_profit_allocation(uuid,boolean)', 'execute') then
    raise exception '0446 FAILED: the draft/post wrappers are no longer callable, so nobody can run the partnership at all.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE PROBE, rolled back. September 2026 on production has uninvoiced clients
-- (asserted first, so the gate is tested against a real case):
--   1. drafting September SUCCEEDS — the draft is kept;
--   2. posting it without confirmation is REFUSED with the completeness message
--      and the confirmation hint the screen keys on — the post is blocked.
-- ---------------------------------------------------------------------------
do $$
declare v_co uuid; v_uid uuid; v_run uuid; v_status text; v_hint text;
begin
  select id into v_co from public.companies where active and archived_at is null order by created_at limit 1;
  select p.id into v_uid from public.profiles p where p.company_id = v_co
   and p.role in ('super_admin','super_super_admin') order by p.role limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  if not exists (select 1 from public.partnership_uninvoiced_clients(v_co, '2026-09-01')) then
    raise exception '0446 PROBE FAILED: September 2026 has no uninvoiced client, so the gate cannot be tested against it.';
  end if;

  v_run := public.draft_profit_allocation(v_co, '2026-09-01', null);
  select status into v_status from public.profit_allocation_runs where id = v_run;
  if v_status is distinct from 'DRAFT' then
    raise exception '0446 PROBE FAILED: drafting an incomplete September gave status %, expected DRAFT.', v_status;
  end if;

  begin
    perform public.post_profit_allocation(v_run, false);
    raise exception '0446 PROBE FAILED: an incomplete September was posted without confirmation.';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if sqlerrm not like '%client(s) live in Sep 2026 have no primary invoice for the month:%'
       or v_hint is distinct from 'Confirm to proceed.' then
      raise;
    end if;
  end;

  raise exception 'ROLLBACK_PROBE';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    perform set_config('request.jwt.claim.sub', null, true);
    if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
    raise notice '0446 probe passed: an incomplete September drafts, and its post asks for confirmation.';
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0446 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
