-- 0313 — RBAC enforcement, closing the gaps found while testing 0310-0312:
--   * Daily Reports (FieldOps) writes daily_client_reports / daily_report_exports
--     with NO permission gate — a view-only user could create reports. → roster.edit
--   * Invoice satellites invoice_lines / invoice_taxes were ungated (only reachable
--     after an invoices insert, which IS gated, but close them too). → invoices.edit
--   * Performance: guard_bonuses / bonus_pools direct writes + generate_bonus_pool /
--     approve_bonus_pool RPCs were ungated. → performance.approve
--   * payroll_run_phases (the Payroll Run phase workflow) was ungated. Gate on
--     payroll.edit OR payroll.approve — the reviewer prep flow (draft→review) needs
--     edit, sign-off needs approve; either write perm is enough to touch a phase,
--     which is what keeps a no-perm user out. Fine-grained draft-vs-approve stays a
--     frontend concern (the sign-off buttons are gated on payroll.approve).
--
-- Same RESTRICTIVE pattern as 0310 (has_perm ANDed onto INSERT/UPDATE/DELETE,
-- SELECT untouched, authenticated only). ACCESS CONTROL ONLY.
do $$
declare m record;
begin
  for m in
    select * from (values
      ('daily_client_reports', 'public.has_perm(''roster.edit'')'),
      ('daily_report_exports', 'public.has_perm(''roster.edit'')'),
      ('invoice_lines',        'public.has_perm(''invoices.edit'')'),
      ('invoice_taxes',        'public.has_perm(''invoices.edit'')'),
      ('guard_bonuses',        'public.has_perm(''performance.approve'')'),
      ('bonus_pools',          'public.has_perm(''performance.approve'')'),
      ('payroll_run_phases',   '(public.has_perm(''payroll.edit'') or public.has_perm(''payroll.approve''))')
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

-- generate_bonus_pool / approve_bonus_pool are SECURITY DEFINER and bypass the
-- RLS above, so guard them directly on performance.approve (surgical prepend
-- against the live definition; body logic unchanged).
do $$
declare m record; v_def text; v_new text;
begin
  for m in select unnest(array['generate_bonus_pool','approve_bonus_pool']) as fn
  loop
    for v_def in select pg_get_functiondef(p.oid) from pg_proc p
                 join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname=m.fn
    loop
      if position('require_perm' in v_def) > 0 then continue; end if;
      v_new := regexp_replace(v_def, E'begin\n', E'begin\n  perform public.require_perm(''performance.approve'');\n');
      if v_new = v_def then raise exception 'guard anchor not found for %', m.fn; end if;
      execute v_new;
    end loop;
  end loop;
end $$;
