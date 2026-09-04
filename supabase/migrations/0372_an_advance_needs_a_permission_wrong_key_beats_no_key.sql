-- 0370 — an advance stops being money that leaves on nobody's authority.
--
-- ===========================================================================
-- THE DEFECT
-- ===========================================================================
--
-- public.advances carried NO perm_write_* policy at all — only company_members
-- and branch_scope. Every neighbouring money table has one: expenses wants
-- expenses.edit, bank_accounts wants accounting.edit, invoice_payments wants
-- invoices.edit. advances wanted nothing.
--
-- So any authenticated member of the company could create, edit or delete an
-- advance. Unlike the RPC gaps this is not a missing check inside a function —
-- it is a missing policy on the table, so EVERY path reaches it, not just the
-- ones somebody thought to write an RPC for.
--
-- It is smaller than 0368 only because the balance leg still needs
-- accounting.edit, so the money movement half-fails and shows up as one of the
-- non-atomic flows in docs/PERMISSION_GAPS.md §4. The advances row itself
-- committed regardless, which is the part that mattered: a record of money owed
-- by a guard, created by anyone.
--
-- ===========================================================================
-- THE KEY IS EXPENSES.EDIT, AND IT IS EXPLICITLY PROVISIONAL
-- ===========================================================================
--
-- An advance to a guard is money leaving now against that guard's future pay,
-- which makes it partly a payroll act and partly a disbursement.
--
--   payroll.edit   is wrong: it is paid out of the till today, not run through
--                  a payroll cycle, and payroll.edit is the key that computes
--                  and disburses a whole month.
--   expenses.edit  is closer: whoever hands cash over the counter already holds
--                  it, and the advance is recorded beside the expenses it sits
--                  with in the same screen.
--
-- Neither is right. The decision is Shayan's and it has not been made. This
-- migration takes the closer of the two on the principle that WRONG KEY BEATS
-- NO KEY — a mis-scoped permission is one word to change and is visible in the
-- policy; an absent one is invisible and reachable by everyone.
--
-- If the answer comes back payroll.edit, or a new advances.edit, it is three
-- policy definitions in one file and no data migration.

do $$
declare v_n int;
begin
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'advances' and policyname like 'perm_write%';
  if v_n <> 0 then
    raise exception
      '0370 REFUSED: advances already carries % perm_write polic(ies). It was recorded as having none, so something has changed and this migration would be adding a second rule.', v_n;
  end if;
end $$;

create policy perm_write_ins on public.advances for insert
  to authenticated
  with check (has_perm('expenses.edit'));

create policy perm_write_upd on public.advances for update
  to authenticated
  using (has_perm('expenses.edit'))
  with check (has_perm('expenses.edit'));

create policy perm_write_del on public.advances for delete
  to authenticated
  using (has_perm('expenses.edit'));

comment on table public.advances is
  '0370: writes require expenses.edit. PROVISIONAL — an advance is money leaving now against future pay, which is neither cleanly payroll nor cleanly an expense. expenses.edit is the closer of the two and was chosen on "wrong key beats no key"; the table previously had no write policy at all and any company member could create one. Revisit when the intended key is decided.';

-- ---------------------------------------------------------------------------
-- PROVE THE POLICIES EXIST AND THAT READS ARE UNTOUCHED.
--
-- The second half matters: adding three write policies must not narrow who can
-- SEE advances, and a mistake there would look like a working fix while quietly
-- hiding rows from the people who need them.
-- ---------------------------------------------------------------------------
do $$
declare v_w int; v_all int;
begin
  select count(*) into v_w from pg_policies
   where schemaname = 'public' and tablename = 'advances' and policyname like 'perm_write%';
  if v_w <> 3 then
    raise exception '0370 FAILED: % write polic(ies) on advances, expected 3.', v_w;
  end if;

  select count(*) into v_all from pg_policies
   where schemaname = 'public' and tablename = 'advances'
     and policyname in ('company_members', 'ssa_all', 'branch_scope');
  if v_all <> 3 then
    raise exception
      '0370 FAILED: the company/ssa/branch policies on advances number %, expected 3 — reads have been disturbed.', v_all;
  end if;
  raise notice '0370: three write policies added, three scoping policies intact.';
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception '0370 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
