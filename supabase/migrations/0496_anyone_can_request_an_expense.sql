-- 0496 — Anyone can request an expense; only expenses.approve can decide it.
--
-- DECIDED with the user on 2026-10-05, the same day as 0495: requesting is for
-- everyone in the company. Approving, rejecting and signing off stay behind
-- expenses.approve, which decide_expense_request already requires.
--
-- So request_expense no longer asks expenses.request, and the key leaves the
-- permission catalogue: a key that gates nothing should not be offered on the
-- grant screen. The company is still enforced — the row is written to the
-- caller's own company, and the category and client are asserted to be in it.
--
-- request_expense was written by exactly one migration (0495); amended here by
-- anchored surgery against the live definition.

do $$
declare v_def text; v_hits int;
  a text := '  perform public.require_perm(''expenses.request'');' || chr(10);
begin
  v_def := pg_get_functiondef('public.request_expense(uuid, uuid, numeric, text, text, date)'::regprocedure);
  if position('expenses.request' in v_def) = 0 then
    return;  -- already amended
  end if;
  v_hits := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
  if v_hits <> 1 then
    raise exception '0496 REFUSED: request_expense anchor appears %, expected 1.', v_hits;
  end if;
  execute replace(v_def, a,
    '  -- 0496: anyone in the company may ask. Deciding is what is gated.' || chr(10) ||
    '  if auth.uid() is null then raise exception ''Sign in to request an expense.''; end if;' || chr(10));
end $$;

comment on function public.request_expense(uuid, uuid, numeric, text, text, date) is
  'Ask for an expense (0495). Open to anyone signed in to the company since 0496; approving or rejecting needs expenses.approve (decide_expense_request).';

delete from public.permission_keys where key = 'expenses.request';

do $$
begin
  if position('expenses.request' in
       pg_get_functiondef('public.request_expense(uuid, uuid, numeric, text, text, date)'::regprocedure)) > 0 then
    raise exception '0496 FAILED: request_expense still asks expenses.request.';
  end if;
  if exists (select 1 from public.permission_key_gaps()) then
    raise exception '0496 FAILED: permission_key_gaps() is not empty.';
  end if;
end $$;

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
