-- 0312 — RBAC enforcement, tier 6: the granular satellite tables the original
-- audit assumed were single tables. Same RESTRICTIVE write-RLS pattern as 0310
-- (has_perm ANDed onto INSERT/UPDATE/DELETE, SELECT untouched, authenticated
-- only). Mappings confirmed by the user:
--   employee_documents      -> documents.edit
--   compliance_cases        -> compliance.edit
--   compliance_case_visits  -> compliance.edit
--   statutory_filings       -> compliance.filings   (NEW key: regulatory filings
--                              are kept separate from general compliance edits)
--   incident_guards         -> incidents.edit       (satellite of incidents; no
--                              company_id of its own — has_perm needs none)
--   opening_balance_batches -> coa.view             (defence-in-depth; the real
--                              write path is the RPC guarded below)
--
-- Excluded (reported, not policy'd): compliance_jurisdiction_register is a VIEW
-- (rollup); `posts` is the site master, not an incident satellite.
--
-- ACCESS CONTROL ONLY. No accounting / posting / calculation logic is touched.
do $$
declare m record;
begin
  for m in
    select * from (values
      ('employee_documents',      'public.has_perm(''documents.edit'')'),
      ('compliance_cases',        'public.has_perm(''compliance.edit'')'),
      ('compliance_case_visits',  'public.has_perm(''compliance.edit'')'),
      ('statutory_filings',       'public.has_perm(''compliance.filings'')'),
      ('incident_guards',         'public.has_perm(''incidents.edit'')'),
      ('opening_balance_batches', 'public.has_perm(''coa.view'')')
    ) as t(tbl, expr)
  loop
    execute format('drop policy if exists perm_write_ins on public.%I', m.tbl);
    execute format('drop policy if exists perm_write_upd on public.%I', m.tbl);
    execute format('drop policy if exists perm_write_del on public.%I', m.tbl);
    execute format('create policy perm_write_ins on public.%I as restrictive for insert to authenticated with check (%s)', m.tbl, m.expr);
    execute format('create policy perm_write_upd on public.%I as restrictive for update to authenticated using (%s) with check (%s)', m.tbl, m.expr, m.expr);
    execute format('create policy perm_write_del on public.%I as restrictive for delete to authenticated using (%s)', m.tbl, m.expr);
  end loop;
end $$;

-- post_opening_balances is SECURITY DEFINER and bypasses the table policy above,
-- so gate it directly. coa.view per the confirmed decision (opening balances stay
-- coa.view-only; accounting.edit is deliberately NOT admitted). Surgical prepend
-- against the live definition — the posting logic below the guard is unchanged.
do $$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.post_opening_balances(uuid)'::regprocedure);
  if position('require_perm' in v_def) = 0 then
    v_new := regexp_replace(v_def, E'begin\n', E'begin\n  perform public.require_perm(''coa.view'');\n');
    if v_new = v_def then raise exception 'guard anchor not found for post_opening_balances'; end if;
    execute v_new;
  end if;
end $$;
