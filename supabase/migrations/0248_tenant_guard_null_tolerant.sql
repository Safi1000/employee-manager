-- 0248 — 0242's guards raise on a legitimately absent id. Fix the call sites.
--
-- DEV ONLY. This is a regression introduced in 0242.
--
-- WHAT BROKE
--
-- Inserting an expense with no client fails:
--
--   INSERT INTO expenses (...)  ->  "Row not found"
--   context: SELECT public.assert_same_company(
--              (select company_id from public.clients where id = p_client_id))
--            in region_for_client
--
-- region_for_client(NULL) is a normal call — an expense need not belong to a
-- client, and twelve functions call it. Before 0242 it returned NULL. After
-- 0242 the lookup yields NULL, assert_same_company raises on NULL, and the
-- insert dies. Every path that passes an optional tenant-scoped id as NULL is
-- affected the same way.
--
-- WHY THE HELPER IS NOT THE PLACE TO FIX IT
--
-- assert_same_company MUST keep raising on NULL. That is the no-existence-
-- oracle property: a non-null id that does not exist resolves to NULL, and it
-- has to be answered identically to an id belonging to another company. If the
-- helper started tolerating NULL, "no such row" would become distinguishable
-- from "not your row" and the whole design would unravel.
--
-- The distinction belongs at the CALL SITE, where the two cases are different
-- things:
--
--   parameter IS NULL     -> the caller made no tenant claim. Nothing to check.
--                            The function's own preconditions govern, exactly
--                            as before 0242.
--   parameter is NOT NULL -> a claim was made. Check it, and answer a missing
--                            row and a foreign row identically.
--
-- This is the shape 0242b already used by hand for post_manual_journal's
-- p_branch_id. It was not generalised — a pattern applied by hand and lost in
-- the generated path, which is its own failure mode. See
-- docs/TENANT_GUARD_REPORT.md.
--
-- WHY THE SUITE DID NOT CATCH IT
--
-- tenant_guard.sql's positive control called each function with the caller's
-- OWN id and never with NULL. Exhaustive in the refusing direction, and testing
-- one of the two shapes a legitimate call takes.

do $gen$
declare
  r       record;
  v_body  text;
  v_def   text;
  v_hdr   text;
  v_rest  text;
  p1      int;
  p2      int;
  v_done  int := 0;
begin
  for r in
    select p.oid, p.proname, p.prosrc
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosrc like '%perform public.assert_same_company(%'
       -- idempotent: skip anything already made NULL-tolerant
       and p.prosrc !~ 'is not null then perform public\.assert_same_company'
     order by p.proname
  loop
    v_body := r.prosrc;

    -- [claimed]:  perform public.assert_same_company(p_company_id);
    v_body := regexp_replace(
      v_body,
      '  perform public\.assert_same_company\((p_\w+)\);',
      '  if \1 is not null then perform public.assert_same_company(\1); end if;',
      'g');

    -- [resolved]: perform public.assert_same_company((select company_id from public.T where id = p_x));
    v_body := regexp_replace(
      v_body,
      '  perform public\.assert_same_company\(\(select company_id from public\.(\w+) where id = (p_\w+)\)\);',
      '  if \2 is not null then perform public.assert_same_company((select company_id from public.\1 where id = \2)); end if;',
      'g');

    if v_body = r.prosrc then
      continue;   -- nothing matched; leave it exactly as it is
    end if;

    v_def  := pg_get_functiondef(r.oid);
    p1     := strpos(v_def, '$function$');
    v_rest := substr(v_def, p1 + 10);
    p2     := strpos(v_rest, '$function$');
    v_hdr  := left(v_def, p1 - 1);

    execute v_hdr || '$function$' || v_body || '$function$' || substr(v_rest, p2 + 10);
    v_done := v_done + 1;
  end loop;

  raise notice '0248 made % guard call site(s) NULL-tolerant', v_done;
end
$gen$;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_p uuid; v_client uuid; v_msg text;
      v_n int; v_ok boolean; v_res uuid;
    begin
      -- Every guarded function must STILL call the guard: 0248 must not have
      -- removed protection while making it tolerant.
      select count(*) into v_n from public.tenant_guard_gaps();
      if v_n > 0 then
        raise exception '0248 FAILED: % function(s) are no longer correctly guarded', v_n;
      end if;

      select c.id into v_co from public.companies c
       where exists (select 1 from public.clients cl where cl.company_id = c.id) limit 1;
      select p.id into v_p from public.profiles p
       where p.company_id = v_co and coalesce(p.role::text,'') <> 'super_super_admin' limit 1;
      select cl.id into v_client from public.clients cl where cl.company_id <> v_co limit 1;
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_p::text, 'role','authenticated')::text, true);

      -- 1. NULL is tolerated: this is the call that broke.
      begin
        v_res := public.region_for_client(null);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        raise exception '0248 FAILED: region_for_client(NULL) still raises (%)', v_msg;
      end;

      -- 2. A FOREIGN id is still refused. Without this, 0248 would have
      -- "fixed" the regression by removing the guard.
      if v_client is not null then
        v_ok := false;
        begin
          v_res := public.region_for_client(v_client);
        exception when others then
          get stacked diagnostics v_msg = message_text;
          v_ok := (v_msg = 'Row not found');
        end;
        if not v_ok then
          raise exception '0248 FAILED: a foreign client id is no longer refused';
        end if;
      end if;

      -- 3. A NON-EXISTENT id is still refused, and with the SAME message as a
      -- foreign one. This is the no-existence-oracle property, and it is the
      -- reason the NULL check went at the call site rather than in the helper.
      v_ok := false;
      begin
        v_res := public.region_for_client('00000000-0000-0000-0000-000000000000'::uuid);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg = 'Row not found');
      end;
      if not v_ok then
        raise exception '0248 FAILED: a non-existent client id is not refused identically (%)',
          coalesce(v_msg, '<no error>');
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0248 verification failed: %', v_outcome;
  end if;
end
$verify$;
