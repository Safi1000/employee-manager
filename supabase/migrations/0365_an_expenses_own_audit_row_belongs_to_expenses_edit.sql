-- 0365. AN EXPENSE'S OWN AUDIT ROW BELONGS TO expenses.edit.
--
-- THE DEFECT, on production, 2026-09-03. An employee holding expenses.edit
-- entered five cash expenses. Each one was refused with "You don't have
-- permission to do this", and each one was recorded anyway. The refusal came
-- from the FOURTH of four independent REST calls:
--
--     1. insert expenses            <- committed
--     2. upload receipts to Drive
--     3. update treasury            <- committed
--     4. insert bank_transactions   <- REFUSED (42501)
--
-- perm_write_ins on bank_transactions requires accounting.edit. The employee
-- has expenses.edit. So a single user action — record a cash expense — spans
-- two tables gated on two different permission keys, and nothing in the
-- permission UI says the two travel together. The operator retried, because the
-- UI told them it had failed, and produced a duplicate.
--
-- An expense's own audit row is part of recording the expense. It is not a
-- separate accounting act, and it cannot be separately authorised without
-- making the expense itself half-writable.
--
-- THIS IS A DISJUNCTION, NOT A SWAP. bank_transactions also carries genuine
-- bank activity — transfers, deposits, withdrawals to cash, payroll runs. Those
-- stay on accounting.edit. Replacing the key rather than widening it would hand
-- every expense clerk the bank transfer log, which is a bigger hole than the one
-- being closed.
--
-- ── THE CARVE-OUT, AND WHY IT IS NOT TIMIDITY ──────────────────────────────
--
-- The new arm requires `bank_account_id is null` — CASH expenses only.
--
-- Widening to bank-paid expenses as well would make them SILENTLY WRONG. The
-- add path runs applyBankDelta() BEFORE the audit insert, and that is an UPDATE
-- on bank_accounts, still gated on accounting.edit. A blocked UPDATE returns
-- zero rows with NO error (see src/app/lib/supabase.ts) — so for an
-- expenses.edit-only user a bank expense would record the expense, leave the
-- bank balance untouched without raising, and — after a careless widening —
-- write a clean-looking audit row saying the money moved.
--
-- Today that user is stopped by a loud refusal at step 4. Loud and wrong beats
-- quiet and wrong. So the cash path, which is the one that is broken and the
-- one that has no bank balance to miss, is the only path opened. Bank-paid
-- expenses keep failing exactly as they do now until 0366 makes the whole
-- action one transaction, which is the real fix and the one that removes this
-- class rather than this instance.
--
-- Not fixed here, deliberately, and listed so nobody reads this migration as
-- the end of the matter: SIX other single actions span two permission keys the
-- same way (Expenses handleEdit/handleDecision, Accounting handleMarkPaid/
-- handleRevertToPending, Invoices handleEditPayment, ComplianceCases nextStage).
-- They are follow-ups to the RPC work, not six more policy widenings — patching
-- each fixes the symptom six times and leaves the class.

-- ---------------------------------------------------------------------------
-- 1. THE POLICIES
-- ---------------------------------------------------------------------------

drop policy if exists perm_write_ins on public.bank_transactions;
create policy perm_write_ins on public.bank_transactions
  as restrictive for insert to public
  with check (
    public.has_perm('accounting.edit')
    or (public.has_perm('expenses.edit') and kind = 'expense' and bank_account_id is null)
  );

drop policy if exists perm_write_upd on public.bank_transactions;
create policy perm_write_upd on public.bank_transactions
  as restrictive for update to public
  using (
    public.has_perm('accounting.edit')
    or (public.has_perm('expenses.edit') and kind = 'expense' and bank_account_id is null)
  )
  with check (
    public.has_perm('accounting.edit')
    or (public.has_perm('expenses.edit') and kind = 'expense' and bank_account_id is null)
  );

drop policy if exists perm_write_del on public.bank_transactions;
create policy perm_write_del on public.bank_transactions
  as restrictive for delete to public
  using (
    public.has_perm('accounting.edit')
    or (public.has_perm('expenses.edit') and kind = 'expense' and bank_account_id is null)
  );

-- ---------------------------------------------------------------------------
-- 2. VERIFICATION
-- ---------------------------------------------------------------------------
-- BOTH HALVES OR IT IS A WIDENING, NOT A BOUNDARY. Proving only that the
-- expense insert now succeeds would be satisfied by dropping the policy
-- altogether. The transfer insert must still be refused, by the same identity,
-- in the same session, moments apart — which is also what proves RLS was in
-- force for the first result. Two different outcomes under identical conditions
-- cannot both be explained by "the policy was not applying".

do $verify$
declare
  v_uid     uuid;
  v_co      uuid;
  v_mode    text;
  v_id      uuid;
  v_bank    uuid;
  v_err     text;
  v_planted uuid[] := '{}';
begin
  -- ---- static: both arms are present in all three policies.
  for v_err in
    select polname from pg_policy pol join pg_class c on c.oid = pol.polrelid
     where c.relname = 'bank_transactions' and polname like 'perm_write%'
  loop
    if (select count(*) from pg_policy pol join pg_class c on c.oid = pol.polrelid
         where c.relname = 'bank_transactions' and pol.polname = v_err
           and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
             || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
               like '%accounting.edit%') <> 1 then
      raise exception '0365 FAILED: % lost the accounting.edit arm', v_err;
    end if;
    if (select count(*) from pg_policy pol join pg_class c on c.oid = pol.polrelid
         where c.relname = 'bank_transactions' and pol.polname = v_err
           and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
             || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
               like '%expenses.edit%') <> 1 then
      raise exception '0365 FAILED: % did not gain the expenses.edit arm', v_err;
    end if;
  end loop;

  -- ---- the probe identity. 9.14a's second habit: this block cannot create an
  -- auth user, so it FILTERS to exactly the property under test and asserts it
  -- found something. A profile that merely happens to be first would prove
  -- whatever that profile's permissions happen to be.
  select p.id, p.company_id into v_uid, v_co
    from public.profiles p
    join public.companies c on c.id = p.company_id
   where c.archived_at is null
     and p.role not in ('super_admin', 'super_super_admin')
     and 'expenses.edit' = any(coalesce(p.permissions, '{}'))
     and not ('accounting.edit' = any(coalesce(p.permissions, '{}')))
   order by p.created_at
   limit 1;

  if v_uid is null then
    v_mode := 'STATIC ONLY — no profile holds expenses.edit without accounting.edit, so the boundary cannot be exercised';
    raise exception '0365 FAILED: %. This migration exists for that identity; if none exists the change is unverifiable and must not be trusted.', v_mode;
  end if;

  select id into v_bank from public.bank_accounts where company_id = v_co order by created_at limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform set_config('role', 'authenticated', true);

  if public.current_company_id() is distinct from v_co then
    perform set_config('role', 'postgres', true);
    raise exception '0365 FAILED: the probe identity does not resolve to the company under test';
  end if;

  -- (a) THE HALF THAT MUST NOW WORK: a cash expense audit row.
  begin
    insert into public.bank_transactions (bank_account_id, kind, amount, cash_delta, account_delta, description)
    values (null, 'expense', 1, -1, 0, '0365 probe — cash expense audit row')
    returning id into v_id;
    v_planted := v_planted || v_id;
  exception when others then
    perform set_config('role', 'postgres', true);
    raise exception '0365 FAILED: expenses.edit still cannot record a cash expense audit row: %', sqlerrm;
  end;

  -- (b) THE HALF THAT MUST STILL REFUSE: a transfer. Same identity, same
  --     session, seconds later. Without this the change is a widening.
  begin
    insert into public.bank_transactions (bank_account_id, kind, amount, cash_delta, account_delta, description)
    values (null, 'transfer', 1, 0, 0, '0365 probe — transfer, must be refused')
    returning id into v_id;
    v_planted := v_planted || v_id;
    v_err := 'WENT THROUGH';
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err = 'WENT THROUGH' then
    perform set_config('role', 'postgres', true);
    raise exception '0365 FAILED: expenses.edit was able to insert a TRANSFER. This is a widening, not a boundary.';
  end if;
  if v_err not like '%row-level security%' then
    perform set_config('role', 'postgres', true);
    raise exception '0365 FAILED: the transfer was refused, but not by the policy. Got: %', v_err;
  end if;

  -- (c) THE CARVE-OUT: an expense row naming a BANK is still refused, because
  --     applyBankDelta cannot move that bank's balance for this identity and a
  --     silent balance failure with a clean audit row is worse than a refusal.
  if v_bank is not null then
    begin
      insert into public.bank_transactions (bank_account_id, kind, amount, cash_delta, account_delta, description)
      values (v_bank, 'expense', 1, 0, -1, '0365 probe — bank expense, must be refused')
      returning id into v_id;
      v_planted := v_planted || v_id;
      v_err := 'WENT THROUGH';
    exception when others then
      v_err := sqlerrm;
    end;
    if v_err = 'WENT THROUGH' then
      perform set_config('role', 'postgres', true);
      raise exception '0365 FAILED: a BANK-paid expense row was accepted. The carve-out is missing and bank expenses can now record a movement whose balance never moved.';
    end if;
  end if;

  -- ---- restore before the verdict (0318's lesson), and prove the restore.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  perform set_config('request.jwt.claim.sub', null, true);

  delete from public.bank_transactions where id = any(v_planted);
  if exists (select 1 from public.bank_transactions where description like '0365 probe%') then
    raise exception '0365 FAILED: probe rows were left behind in bank_transactions';
  end if;
end
$verify$;
