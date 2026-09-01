-- 0251 — tenant_guard_gaps() now asks about EVERY tenant-scoped parameter.
--
-- DEV ONLY. This is the part that lasts: the resolver map in 0252 fixes 29
-- parameters, this stops the 30th.
--
-- WHY THE OLD QUESTION IS NOW THE WRONG ONE
--
-- The 0243 check asked "does this function call assert_same_company at all".
-- That was right for 0242, whose defect was functions with no guard. It is
-- wrong now: it passes a function that guards one of three tenant-scoped
-- parameters, which is exactly the defect 0242's generator produced by only
-- ever guarding the first uuid. post_manual_journal had two guards solely
-- because one was written by hand.
--
-- The new property is per-parameter: every uuid parameter of a SECURITY DEFINER
-- function reachable by `authenticated` is either covered by a guard that
-- mentions it, or is listed below with a reason.
--
-- AN UNEXPLAINED GAP IS A FAILURE; AN EXPLAINED ONE IS A LINE SOMEBODY WROTE
--
-- The exemptions live in the check itself rather than in a doc, so adding one
-- is a code change with a reason attached and shows up in review. Two kinds:
--
--   POLYMORPHIC — the parameter's table is another parameter (p_source_table,
--   p_ref_table), so there is nothing to resolve against mechanically. Closing
--   these needs a per-source-table resolver, which is its own change.
--
--   ALREADY CHECKED BY HAND — the function's own body validates the id against
--   the resolved company. Listed so the generator does not add a second guard
--   in a different style beside a correct one.
--
-- This migration asserts the check SEES the 29 known gaps. A gap check created
-- green over a database that has gaps would be worthless, and proving it can
-- report before proving it can pass is the same discipline as breaking a guard
-- to watch it go red.
--
-- SUPERSEDED BY 0252, which teaches the check the second guard helper
-- (assert_branch_in_company) and closes the 29. Read them in order.

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
       and p.proname <> 'assert_same_company'
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
      -- POLYMORPHIC: the table is named by a sibling text parameter.
      ('post_journal',               'p_source_id',
       'POLYMORPHIC: the table is p_source_table, a text parameter, so there is nothing to resolve against mechanically. Needs a per-source-table resolver, same as is_action_approved.'),
      ('reverse_journal_for_source', 'p_source_id', 'POLYMORPHIC: paired with p_source_table.'),
      ('raise_alert',                'p_ref_id',    'POLYMORPHIC: paired with p_ref_table.'),
      ('request_approval',           'p_ref_id',    'POLYMORPHIC: paired with p_ref_table.'),
      ('is_action_approved',         'p_ref_id',
       'POLYMORPHIC: paired with p_ref_table. Leaks a boolean about another company ref_id; logged in PRE_GO_LIVE.md.'),
      -- ALREADY CHECKED BY HAND in the function own body.
      ('assign_employee_code',       'p_client_id',
       'ALREADY CHECKED: the body selects from clients where id = p_client_id and company_id = v_company_id, and raises NO_PREFIX otherwise.'),
      ('record_invoice_payment',     'p_bank_account_id',
       'ALREADY CHECKED: the body does perform 1 from bank_accounts where id = p_bank_account_id and company_id = v_company.'),
      ('post_manual_journal',        'p_credit_account_id',
       'ALREADY CHECKED: the body validates BOTH accounts together, where id in (p_debit_account_id, p_credit_account_id) and company_id = v_company having count(*) = 2.'),
      ('same_company_branch',        'p_branch_id',
       'THIS FUNCTION IS THE BRANCH VALIDATOR. Its whole body is the check and the p_branch_id guards elsewhere delegate to it. Guarding it with itself would recurse.')
    ) as t(fname, param, why)
  )
  select p.fname,
         p.param,
         case when p.fargs ilike 'p_company%' and p.ord = 1 then 'claimed' else 'resolved' end,
         'tenant-scoped uuid parameter with no assert_same_company covering it'
    from params p
   where p.prosrc !~ ('assert_same_company\([^;]*\m' || p.param || '\M')
     and not exists (select 1 from exempt e where e.fname = p.fname and e.param = p.param)
   order by 1, 2;
$function$;

comment on function public.tenant_guard_gaps() is
  'Returns every tenant-scoped uuid PARAMETER of a SECURITY DEFINER function reachable by authenticated that no tenant guard covers. Per-parameter, not per-function: the older per-function form passed a function guarding one of three ids, which is the defect 0242 generator produced. Deliberate omissions are listed inside the function with a reason, so an unexplained gap fails and an explained one is a line somebody wrote. Zero rows is the only acceptable result. See 0251, 0252.';

revoke execute on function public.tenant_guard_gaps() from anon, public;
grant  execute on function public.tenant_guard_gaps() to authenticated, service_role;

do $verify$
declare
  v_n int;
  v_fns int;
begin
  select count(*), count(distinct function_name) into v_n, v_fns
    from public.tenant_guard_gaps();

  -- The check must SEE the defect it was written for. Created green over a
  -- database with 29 known gaps, it would be worthless.
  if v_n <> 29 then
    raise exception
      '0251: expected the extended check to report the 29 known uncovered parameters, got % across % function(s). Either the map moved or the predicate is wrong — do not proceed until this is understood.',
      v_n, v_fns;
  end if;

  if v_fns < 15 then
    raise exception '0251: % gaps concentrated in only % function(s) — the parameter expansion is not working', v_n, v_fns;
  end if;

  raise notice '0251: extended check reports % uncovered parameters across % functions, as expected', v_n, v_fns;
end
$verify$;
