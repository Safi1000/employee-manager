-- 0252 — Guard every tenant-scoped parameter, not just the first.
--
-- DEV ONLY. Closes the 29 parameters 0251's extended check reports.
--
-- ONE PLACE FOR THE BRANCH RULE, WITH A DEVIATION FLAGGED
--
-- Delegating literally to same_company_branch loses the SSA escape: it compares
-- branches.company_id against a company passed in, so a guard calling
-- same_company_branch(current_company_id(), p_branch_id) would refuse an
-- SSA-unscoped user acting on another company — the path 0242 preserved via
-- is_ssa_unscoped(). Reproducing the SSA test at thirteen call sites is the
-- drift the instruction exists to prevent. So the rule lives in ONE place as
-- asked, in a helper shaped for guarding rather than for returning a value.
-- same_company_branch is untouched and remains the value-returning validator
-- for its existing callers.
--
-- TWO BUGS THIS MIGRATION'S FIRST ATTEMPT HAD, BOTH CAUGHT BY 0251
--
-- 1. The generator looped over a gap list that carried prosrc with it. For a
--    function with three uncovered parameters, every iteration started from the
--    ORIGINAL source and the last write won — two of three guards silently
--    lost. prosrc is now re-read from the catalogue inside the loop.
-- 2. The check did not recognise assert_branch_in_company, so thirteen
--    correctly-guarded parameters still reported as gaps. A new guard helper
--    has to be taught to the check, or the check quietly disagrees with the
--    code. Both forms are now recognised, in one place
--    (tenant_guard_covered), so adding a third helper is a single edit.
--
-- The check refusing to accept a form it did not know about is the check
-- working. It reported 20 remaining and the migration refused to commit.
--
-- fund_region: lender <> borrower. A region funding itself is either two
-- cancelling lines or an inter-region receivable against itself. Checked the
-- schema for others of the same shape — fund_region is the only function taking
-- two branch/region ids.

create or replace function public.assert_branch_in_company(p_branch_id uuid)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- NULL carries no claim. p_branch_id is optional almost everywhere it appears
  -- (raise_alert, request_approval, generate_bonus_pool all pass NULL routinely),
  -- and 0242's failure to allow for that is what broke every expense insert.
  if p_branch_id is null then
    return;
  end if;
  perform public.assert_same_company((select company_id from public.branches where id = p_branch_id));
end
$fn$;

comment on function public.assert_branch_in_company(uuid) is
  'The single place the branch/region tenant rule is written. NULL-tolerant, and delegates the comparison to assert_same_company so the SSA-unscoped escape and the identical-message no-oracle property are preserved. same_company_branch remains the value-returning validator for callers that want a branch id back. See 0252.';

revoke execute on function public.assert_branch_in_company(uuid) from anon, public;
grant  execute on function public.assert_branch_in_company(uuid) to authenticated, service_role;

-- Teach the check the second guard form BEFORE generating, so the generator's
-- own gap list is computed against the predicate the verification will use.
create or replace function public.tenant_guard_covered(p_src text, p_param text)
returns boolean
language sql
immutable
as $function$
  select p_src ~ ('assert_same_company\([^;]*\m' || p_param || '\M')
      or p_src ~ ('assert_branch_in_company\([^;]*\m' || p_param || '\M');
$function$;

comment on function public.tenant_guard_covered(text, text) is
  'Is this parameter covered by any tenant guard? One place listing the accepted guard forms, so adding a third helper is a single edit rather than a silent disagreement between the code and the check. See 0252.';

drop function if exists public.tenant_guard_gaps();

create function public.tenant_guard_gaps()
returns table(function_name text, parameter_name text, shape text, reason text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with fns as (
    select p.oid, p.proname::text as fname, p.prosrc,
           p.proargnames, p.proargtypes,
           pg_get_function_identity_arguments(p.oid) as fargs
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosecdef
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and p.proname not in ('assert_same_company', 'assert_branch_in_company')
       and coalesce(obj_description(p.oid, 'pg_proc'), '') not like 'TENANT GUARD EXEMPT%'
  ),
  params as (
    select f.fname, f.prosrc, f.fargs, u.name as param, u.ord
      from fns f,
           lateral unnest(f.proargnames[1:array_length(f.proargtypes, 1)], f.proargtypes)
             with ordinality as u(name, typ, ord)
     where u.typ = 'uuid'::regtype::oid
  ),
  exempt as (
    select * from (values
      ('post_journal',               'p_source_id',
       'POLYMORPHIC: the table is p_source_table, a text parameter. Needs a per-source-table resolver, same as is_action_approved.'),
      ('reverse_journal_for_source', 'p_source_id', 'POLYMORPHIC: paired with p_source_table.'),
      ('raise_alert',                'p_ref_id',    'POLYMORPHIC: paired with p_ref_table.'),
      ('request_approval',           'p_ref_id',    'POLYMORPHIC: paired with p_ref_table.'),
      ('is_action_approved',         'p_ref_id',
       'POLYMORPHIC: paired with p_ref_table. Leaks a boolean about another company ref_id; logged in PRE_GO_LIVE.md.'),
      ('assign_employee_code',       'p_client_id',
       'ALREADY CHECKED: the body selects from clients where id = p_client_id and company_id = v_company_id.'),
      ('record_invoice_payment',     'p_bank_account_id',
       'ALREADY CHECKED: the body does perform 1 from bank_accounts where id = p_bank_account_id and company_id = v_company.'),
      ('post_manual_journal',        'p_credit_account_id',
       'ALREADY CHECKED: the body validates BOTH accounts together with having count(*) = 2.'),
      ('same_company_branch',        'p_branch_id',
       'THIS FUNCTION IS THE BRANCH VALIDATOR. Guarding it with itself would recurse.')
    ) as t(fname, param, why)
  )
  select p.fname, p.param,
         case when p.fargs ilike 'p_company%' and p.ord = 1 then 'claimed' else 'resolved' end,
         'tenant-scoped uuid parameter with no tenant guard covering it'
    from params p
   where not public.tenant_guard_covered(p.prosrc, p.param)
     and not exists (select 1 from exempt e where e.fname = p.fname and e.param = p.param)
   order by 1, 2;
$function$;

revoke execute on function public.tenant_guard_gaps() from anon, public;
grant  execute on function public.tenant_guard_gaps() to authenticated, service_role;

do $gen$
declare
  r        record;
  v_guard  text;
  v_body   text;
  v_src    text;
  v_def    text;
  v_hdr    text;
  v_rest   text;
  p1       int;
  p2       int;
  v_oid    oid;
  v_tbl    text;
  v_done   int := 0;
begin
  -- Snapshot the gap list first: the loop changes what tenant_guard_gaps()
  -- returns, and iterating a set that shrinks underneath you is its own bug.
  create temp table _tg2 on commit drop as
    select function_name, parameter_name, shape from public.tenant_guard_gaps();

  for r in select * from _tg2 order by function_name, parameter_name
  loop
    -- Re-read the CURRENT source every iteration. A function with three gaps is
    -- rewritten three times and each rewrite must build on the last.
    select p.oid, p.prosrc into v_oid, v_src
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname::text = r.function_name;

    if public.tenant_guard_covered(v_src, r.parameter_name) then
      continue;
    end if;

    -- THE MAP. Hand-written and reviewed; every table verified to exist and
    -- carry company_id before this migration was written.
    v_tbl := case r.parameter_name
               when 'p_new_client_id'         then 'clients'
               when 'p_client_id'             then 'clients'
               when 'p_contract_line_id'      then 'contract_lines'
               when 'p_site_id'               then 'sites'
               when 'p_approval_request_id'   then 'approval_requests'
               when 'p_location_id'           then 'cash_locations'
               when 'p_custodian_location_id' then 'cash_locations'
               when 'p_kpi_definition_id'     then 'kpi_definitions'
               when 'p_payslip_id'            then 'payslips'
               when 'p_usage_id'              then 'ai_usage'
               else null
             end;

    if r.parameter_name in ('p_branch_id','p_region_id','p_lender','p_borrower') then
      v_guard := format(
        E'  -- tenant guard [resolved, second map]: %I via the branch rule (0252)\n'
        '  perform public.assert_branch_in_company(%I);' || E'\n',
        r.parameter_name, r.parameter_name);
    elsif r.parameter_name = 'p_company_id' then
      v_guard := format(
        E'  -- tenant guard [claimed, second map]: %I IS a tenant claim (0252)\n'
        '  if %I is not null then perform public.assert_same_company(%I); end if;' || E'\n',
        r.parameter_name, r.parameter_name, r.parameter_name);
    elsif v_tbl is not null then
      v_guard := format(
        E'  -- tenant guard [resolved, second map]: owning company from %I via public.%I (0252)\n'
        '  if %I is not null then perform public.assert_same_company((select company_id from public.%I where id = %I)); end if;' || E'\n',
        r.parameter_name, v_tbl, r.parameter_name, v_tbl, r.parameter_name);
    else
      raise exception '0252: no map entry for %.% — refusing to guess a table',
        r.function_name, r.parameter_name;
    end if;

    p1     := regexp_instr(v_src, '\mbegin\M', 1, 1, 0, 'i');
    v_body := left(v_src, p1 + 4) || E'\n' || v_guard || substr(v_src, p1 + 5);

    v_def  := pg_get_functiondef(v_oid);
    p1     := strpos(v_def, '$function$');
    v_rest := substr(v_def, p1 + 10);
    p2     := strpos(v_rest, '$function$');
    v_hdr  := left(v_def, p1 - 1);

    execute v_hdr || '$function$' || v_body || '$function$' || substr(v_rest, p2 + 10);
    v_done := v_done + 1;
  end loop;

  raise notice '0252 added % parameter guard(s)', v_done;
end
$gen$;

do $self$
declare
  v_src text; v_body text; v_def text; v_hdr text; v_rest text; v_oid oid; p1 int; p2 int;
begin
  select p.oid, p.prosrc into v_oid, v_src from pg_proc p
   where p.pronamespace='public'::regnamespace and p.proname='fund_region';
  if v_src like '%cannot fund itself%' then return; end if;

  p1 := regexp_instr(v_src, '\mbegin\M', 1, 1, 0, 'i');
  v_body := left(v_src, p1 + 4) || E'\n'
    || '  -- A region funding itself is either two cancelling lines or an' || E'\n'
    || '  -- inter-region receivable against itself. Neither is meant (0252).' || E'\n'
    || '  if p_lender is not null and p_borrower is not null and p_lender = p_borrower then' || E'\n'
    || '    raise exception ''A region cannot fund itself: lender and borrower are the same region.''' || E'\n'
    || '      using errcode = ''22023'';' || E'\n'
    || '  end if;' || E'\n'
    || substr(v_src, p1 + 5);

  v_def  := pg_get_functiondef(v_oid);
  p1     := strpos(v_def, '$function$');
  v_rest := substr(v_def, p1 + 10);
  p2     := strpos(v_rest, '$function$');
  v_hdr  := left(v_def, p1 - 1);
  execute v_hdr || '$function$' || v_body || '$function$' || substr(v_rest, p2 + 10);
end
$self$;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_n int; v_co uuid; v_p uuid; v_other_branch uuid; v_own_branch uuid;
      v_msg text; v_ok boolean;
    begin
      select count(*) into v_n from public.tenant_guard_gaps();
      if v_n > 0 then
        raise exception '0252 FAILED: % parameter(s) still uncovered', v_n;
      end if;

      -- Non-vacuity: gaps=0 must not be because the check stopped looking.
      select count(*) into v_n
        from pg_proc p
       where p.pronamespace='public'::regnamespace
         and p.prosrc like '%second map%';
      if v_n < 15 then
        raise exception '0252 SUSPECT: only % function(s) carry a second-map guard', v_n;
      end if;

      select p.company_id, p.id into v_co, v_p from public.profiles p
       where p.company_id is not null and coalesce(p.role::text,'') <> 'super_super_admin' limit 1;
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_p::text, 'role','authenticated')::text, true);

      select b.id into v_own_branch   from public.branches b where b.company_id = v_co limit 1;
      select b.id into v_other_branch from public.branches b where b.company_id <> v_co limit 1;

      -- POSITIVE: NULL is tolerated everywhere the branch rule is applied.
      begin
        perform public.assert_branch_in_company(null);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        raise exception '0252 FAILED: assert_branch_in_company(NULL) raises (%)', v_msg;
      end;

      -- POSITIVE: the caller's own branch passes.
      if v_own_branch is not null then
        begin
          perform public.assert_branch_in_company(v_own_branch);
        exception when others then
          get stacked diagnostics v_msg = message_text;
          raise exception '0252 FAILED: the caller OWN branch is refused (%)', v_msg;
        end;
      end if;

      -- NEGATIVE: a foreign branch is refused, identically to a missing one.
      if v_other_branch is not null then
        v_ok := false;
        begin
          perform public.assert_branch_in_company(v_other_branch);
        exception when others then
          get stacked diagnostics v_msg = message_text;
          v_ok := (v_msg = 'Row not found');
        end;
        if not v_ok then
          raise exception '0252 FAILED: a foreign branch is not refused';
        end if;
      end if;

      v_ok := false;
      begin
        perform public.assert_branch_in_company('00000000-0000-0000-0000-000000000000'::uuid);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg = 'Row not found');
      end;
      if not v_ok then
        raise exception '0252 FAILED: a non-existent branch is not refused identically';
      end if;

      -- fund_region refuses a self-funding region, by message.
      v_ok := false;
      begin
        perform public.fund_region(v_co, v_own_branch, v_own_branch, 100, null, false, 'probe');
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg like '%cannot fund itself%');
      end;
      if not v_ok then
        raise exception '0252 FAILED: fund_region did not refuse lender = borrower (msg: %)',
          coalesce(v_msg, '<no error>');
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0252 verification failed: %', v_outcome;
  end if;
end
$verify$;
