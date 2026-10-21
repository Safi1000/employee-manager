-- 0529 — an advance is written only by those allowed to
--
-- Found 2026-10-21 while checking what limited-access users can reach. The
-- three write gates on public.advances (perm_write_ins / _upd / _del) are
-- PERMISSIVE. A permissive policy is OR'd with the others, and company_members
-- (permissive, ALL) already lets every member of the company in — so these
-- gates narrowed nothing: any signed-in member could insert, change or delete
-- an advance whatever their permissions. On every other table that carries
-- them (expenses, invoices, invoice_payments, employees, bank_accounts …) the
-- same gates are RESTRICTIVE, which is what makes them a gate.
--
-- The change: the same three policies, the same conditions, recreated AS
-- RESTRICTIVE. Nothing else. The conditions are kept exactly:
--   payment_mode = 'Carry-forward'  → payroll.edit
--   otherwise                       → expenses.edit
--
-- Who this stops: a member with neither key writing advances directly. Who it
-- does not touch: people holding expenses.edit or payroll.edit, and reads
-- (self_scope and branch_scope are unchanged).
--
-- The functions that write advances, checked on prod before this was applied:
--   record_advance, amend_advance          SECURITY DEFINER — unaffected
--   delete_advance                         SECURITY INVOKER — now needs
--                                          expenses.edit (payroll.edit for a
--                                          carry-forward), which the Expenses
--                                          screen already asks before it calls it
--   sync_overpayment_carry_forward         SECURITY INVOKER — writes only
--                                          Carry-forward rows, now needs
--                                          payroll.edit; it runs on a payslip
--                                          save, which already needs payroll.edit.
--                                          Its own note (PayrollManagement.tsx)
--                                          says this is the intended gate — the
--                                          permissive policies never enforced it.
--
-- Idempotent: drop-and-create by name.

do $$
begin
  if to_regclass('public.advances') is null then
    raise exception '0529 REFUSED: public.advances does not exist.';
  end if;
end $$;

drop policy if exists perm_write_ins on public.advances;
create policy perm_write_ins on public.advances as restrictive for insert
  with check (
    case when payment_mode = 'Carry-forward' then (select public.has_perm('payroll.edit'))
         else (select public.has_perm('expenses.edit')) end);

drop policy if exists perm_write_upd on public.advances;
create policy perm_write_upd on public.advances as restrictive for update
  using (
    case when payment_mode = 'Carry-forward' then (select public.has_perm('payroll.edit'))
         else (select public.has_perm('expenses.edit')) end)
  with check (
    case when payment_mode = 'Carry-forward' then (select public.has_perm('payroll.edit'))
         else (select public.has_perm('expenses.edit')) end);

drop policy if exists perm_write_del on public.advances;
create policy perm_write_del on public.advances as restrictive for delete
  using (
    case when payment_mode = 'Carry-forward' then (select public.has_perm('payroll.edit'))
         else (select public.has_perm('expenses.edit')) end);

-- Asserts — on the thing that can break: all three are now restrictive.
do $$
declare v_n int; v_who text;
begin
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'advances'
     and policyname in ('perm_write_ins', 'perm_write_upd', 'perm_write_del') and permissive = 'RESTRICTIVE';
  if v_n <> 3 then raise exception '0529 REFUSED: expected 3 restrictive write gates on advances, found %.', v_n; end if;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'advances'
     and policyname like 'perm_write%' and permissive = 'PERMISSIVE';
  if v_n <> 0 then raise exception '0529 REFUSED: % permissive write gate(s) remain on advances.', v_n; end if;

  select count(*), string_agg(key::text, ', ') into v_n, v_who from public.permission_key_gaps();
  if v_n <> 0 then raise exception '0529 REFUSED: permission_key_gaps() reports %: %', v_n, v_who; end if;

  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ') into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then raise exception '0529 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who; end if;
end $$;
