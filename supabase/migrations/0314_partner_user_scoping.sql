-- 0314 — per-user Partner scoping for the Partnership Report, mirroring the
-- existing branch-scope pattern (profiles.branch_id + current_branch_id() +
-- is_branched_user() + branch_scope RLS). ACCESS CONTROL ONLY — no partnership
-- accounting/allocation/posting logic is changed; this only narrows WHICH
-- partners' rows a scoped user can see.
--
--   profiles.user_type    : 'office_staff' (default/unscoped) | 'partner'
--   profiles.partner_scope: uuid[] of partners this user may see. Empty/null
--                           while user_type='partner' => sees NO partners (an
--                           empty selection must not fall back to company-wide).
alter table public.profiles add column if not exists user_type text;
alter table public.profiles add column if not exists partner_scope uuid[];

-- Helpers (SECURITY DEFINER, read the caller's own profile) — the partner twins
-- of is_branched_user()/current_branch_id().
create or replace function public.is_partner_scoped()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select user_type = 'partner' from public.profiles where id = auth.uid()), false);
$$;
create or replace function public.current_partner_scope()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce((select partner_scope from public.profiles where id = auth.uid()), '{}'::uuid[]);
$$;
grant execute on function public.is_partner_scoped() to authenticated;
grant execute on function public.current_partner_scope() to authenticated;

-- RESTRICTIVE scope policies (FOR ALL incl. SELECT — same as branch_scope). ANDs
-- onto the existing company_members/ssa policies. A non-partner-scoped user is
-- unaffected; a partner-scoped user sees ONLY partners in their scope; SSA sees all.
do $$
declare m record;
begin
  for m in select * from (values
    ('partners',               'id'),
    ('partner_account_entries','partner_id'),
    ('partner_client_shares',  'partner_id')
  ) as t(tbl, col)
  loop
    execute format('drop policy if exists partner_scope on public.%I', m.tbl);
    execute format($f$
      create policy partner_scope on public.%I as restrictive for all to authenticated
      using (not public.is_partner_scoped() or %I = any(public.current_partner_scope()) or public.is_super_super_admin())
      with check (not public.is_partner_scoped() or %I = any(public.current_partner_scope()) or public.is_super_super_admin())
    $f$, m.tbl, m.col, m.col);
  end loop;
end $$;

-- partner_ledger is SECURITY DEFINER and bypasses the table RLS above, so add a
-- scope check at the very top (access filter only — returns nothing for an
-- out-of-scope partner; the ledger computation below is untouched). Surgical
-- prepend against the live definition, anchored on the body's first begin.
do $$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.partner_ledger(uuid,date,date)'::regprocedure);
  if position('current_partner_scope' in v_def) = 0 then
    v_new := regexp_replace(
      v_def, E'begin\n',
      E'begin\n  if public.is_partner_scoped() and not (p_partner_id = any(public.current_partner_scope())) then return; end if;\n');
    if v_new = v_def then raise exception 'anchor not found for partner_ledger'; end if;
    execute v_new;
  end if;
end $$;
