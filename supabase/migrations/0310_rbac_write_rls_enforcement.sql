-- 0310 — RBAC enforcement, layer 1: write-side RLS.
--
-- The audit found every write policy on these tables checked only
-- company_id/branch — never the permission. Any authenticated company member
-- could INSERT/UPDATE/DELETE regardless of their permission checkboxes, because
-- enforcement was 100% client-side. This adds a RESTRICTIVE policy per write
-- command that ANDs has_perm(<key>) onto the existing company/branch/ssa
-- permissive policies (which are left untouched). has_perm() already returns
-- true for super_admin/SSA, so they are unaffected; SECURITY DEFINER
-- triggers/RPCs run as their definer (BYPASSRLS) and are unaffected here — the
-- money/approval RPCs that bypass RLS get their own has_perm() guard in 0311.
--
-- SELECT is deliberately NOT restricted: read access stays governed by the
-- existing .view permissions + branch scope. Restrictive policies target the
-- authenticated role only, so service_role / edge functions are untouched.
do $$
declare m record;
begin
  for m in
    select * from (values
      ('clients',                        'public.has_perm(''clients.edit'')'),
      ('employees',                      'public.has_perm(''employees.edit'')'),
      ('expenses',                       'public.has_perm(''expenses.edit'')'),
      ('invoices',                       'public.has_perm(''invoices.edit'')'),
      ('invoice_payments',               'public.has_perm(''invoices.edit'')'),
      ('contracts',                      'public.has_perm(''contracts.edit'')'),
      ('bank_accounts',                  'public.has_perm(''accounting.edit'')'),
      ('bank_transactions',              'public.has_perm(''accounting.edit'')'),
      ('inventory_items',                'public.has_perm(''inventory.edit'')'),
      ('incidents',                      'public.has_perm(''incidents.edit'')'),
      ('accounting_periods',             'public.has_perm(''period_close.manage'')'),
      ('attendance_records',             '(public.has_perm(''attendance.edit'') or public.has_perm(''attendance.bulk_mark''))'),
      ('attendance_confirmations',       '(public.has_perm(''attendance.edit'') or public.has_perm(''attendance.bulk_mark'') or public.has_perm(''attendance.ops_verify''))'),
      ('attendance_month_verifications', 'public.has_perm(''attendance.ops_verify'')')
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
