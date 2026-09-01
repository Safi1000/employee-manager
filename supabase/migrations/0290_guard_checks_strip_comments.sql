-- 0290 — The tenant-guard coverage checks match comments too. Fix them.
--
-- DEV ONLY.
--
-- THE AUDIT THAT PROMPTED THIS
--
-- 0288b established the prohibition now written into 9.6: no check in this
-- codebase infers behaviour from a substring in prosrc. The audit that followed
-- found exactly two functions that read prosrc at all —
-- tenant_guard_gaps() and uninvoked_controls() — and both are guard-coverage
-- checks, which is the one place where a question about source text is the
-- question actually being asked ("does this body call the guard").
--
-- uninvoked_controls() was brought up to standard in 0288b: comments stripped,
-- call syntax required. tenant_guard_gaps() and tenant_guard_covered() were
-- not, and they are the more load-bearing of the two — they are what says
-- production is guarded.
--
-- THE HOLE, STATED PRECISELY
--
-- Coverage is decided by matching `assert_same_company\([^;]*\mPARAM\M` against
-- the raw body. A COMMENT containing that text counts. So:
--
--   -- guarded elsewhere: assert_same_company(p_client_id)
--
-- written above an unguarded parameter would mark it covered, and the check
-- would report zero gaps while the parameter was open. That is a FALSE
-- NEGATIVE, which 9.6 now records as the worst of the three failure modes
-- because it is reassuring and it stops the search.
--
-- No such comment exists today — verified below before and after, and the
-- reported gap count does not change. This closes the hole while it is
-- theoretical, which is the only comfortable time to close one.
--
-- WHAT IS STILL NOT PERFECT, WRITTEN DOWN RATHER THAN DISCOVERED
--
-- Comment-stripped call-syntax matching still cannot tell:
--
--   * a guard inside `if false then ... end if` from a live one;
--   * a guard reached through a helper the check does not know about — the
--     defect 0252 hit when assert_branch_in_company was invisible to the check
--     and thirteen correctly-guarded parameters reported as gaps;
--   * a name appearing inside a string literal from a call.
--
-- The second is mitigated by tenant_guard_covered() being the single place the
-- accepted guard forms are listed. The other two are accepted limits of source
-- inspection, and the reason 9.6 forbids this technique anywhere it is not the
-- actual question.

-- ---------------------------------------------------------------------------
-- One place to strip comments, so the two checks cannot drift apart.
-- ---------------------------------------------------------------------------

create or replace function public.executable_source(p_src text)
returns text
language sql
immutable
as $function$
  -- Line comments only. Block comments are not used in generated guard bodies,
  -- and a half-correct stripper that mishandled nesting would be worse than an
  -- honest one that handles the case that exists.
  select regexp_replace(coalesce(p_src, ''), '--[^\n]*', '', 'g');
$function$;

comment on function public.executable_source(text) is
  'A function body with line comments removed, for the guard-coverage checks. Comments are not code: 0288 matched a function name inside its own comment and cleared the function it existed to expose. See 0290 and TENANT_GUARD_REPORT.md 9.6.';

create or replace function public.tenant_guard_covered(p_src text, p_param text)
returns boolean
language sql
immutable
as $function$
  select public.executable_source(p_src) ~ ('assert_same_company\([^;]*\m' || p_param || '\M')
      or public.executable_source(p_src) ~ ('assert_branch_in_company\([^;]*\m' || p_param || '\M');
$function$;

comment on function public.tenant_guard_covered(text, text) is
  'Is this parameter covered by any tenant guard? One place listing the accepted guard forms, so adding a third helper is a single edit rather than a silent disagreement between the code and the check. Matches against comment-stripped source (0290): a guard named in a comment is not a guard.';

-- tenant_guard_gaps() carries its own copy of the predicate for the params CTE;
-- route it through the helper so there is one definition of "covered".
create or replace function public.tenant_guard_gaps()
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

do $verify$
declare
  v_outcome text;
begin
  begin
    declare v_gaps int;
    begin
      -- 1. The verdict has not moved. No function relied on a commented guard,
      -- so tightening must be a no-op on today's schema.
      select count(*) into v_gaps from public.tenant_guard_gaps();
      if v_gaps <> 0 then
        raise exception '0290 FAILED: tightening the predicate opened % gap(s) — a guard was being credited to a comment',
          v_gaps;
      end if;

      -- 2. THE HOLE IS ACTUALLY CLOSED. A comment naming the guard must no
      -- longer count. Asserted against the helper directly, both directions.
      if public.tenant_guard_covered(
           E'begin\n  -- assert_same_company(p_client_id) happens in the caller\n  return 1;\nend', 'p_client_id') then
        raise exception '0290 FAILED: a guard named only in a comment still counts as coverage';
      end if;
      if not public.tenant_guard_covered(
           E'begin\n  perform public.assert_same_company((select company_id from public.clients where id = p_client_id));\n  return 1;\nend', 'p_client_id') then
        raise exception '0290 FAILED: a real guard is no longer recognised — the predicate was narrowed too far';
      end if;
      if not public.tenant_guard_covered(
           E'begin\n  perform public.assert_branch_in_company(p_branch_id);\nend', 'p_branch_id') then
        raise exception '0290 FAILED: the branch guard form is no longer recognised';
      end if;

      -- 3. Still able to report: strip a live guard, require the count to rise.
      declare
        v_src text; v_new text; v_def text; v_hdr text; v_rest text;
        v_oid oid; q1 int; q2 int; v_after int;
      begin
        select p.oid, p.prosrc into v_oid, v_src from pg_proc p
         where p.pronamespace='public'::regnamespace and p.proname='count_client_employees';
        v_new := regexp_replace(v_src, '[^\n]*assert_same_company[^\n]*\n', '', 'g');
        v_def := pg_get_functiondef(v_oid);
        q1 := strpos(v_def,'$function$'); v_rest := substr(v_def,q1+10);
        q2 := strpos(v_rest,'$function$'); v_hdr := left(v_def,q1-1);
        execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest,q2+10);
        select count(*) into v_after from public.tenant_guard_gaps();
        execute v_hdr || '$function$' || v_src || '$function$' || substr(v_rest,q2+10);
        if v_after <> 1 then
          raise exception 'PROBE INSENSITIVE: stripped a guard and the check reported %', v_after;
        end if;
      end;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0290 verification failed: %', v_outcome;
  end if;
end
$verify$;
