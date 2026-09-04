-- 0369 — record_invoice_payment becomes SECURITY INVOKER, and a receipt's own
--        audit row stops needing the key that moves money between banks.
--
-- ===========================================================================
-- THE DEFECT
-- ===========================================================================
--
-- record_invoice_payment is SECURITY DEFINER, so the caller's policies are off
-- for the whole call. It scopes the tenant carefully and does not scope the
-- branch at all. `invoices` and `invoice_payments` both carry branch_scope, so
-- a user tied to ISB/RWP could pay ANY invoice in the company — Lahore's,
-- Kashmir's — and the payment row landed under that region. They could not see
-- the invoice on any screen; they only needed its id.
--
-- Not exploitable on GGS today: the function opens with
-- require_perm('invoices.edit'), and the two branched profiles are hr and hold
-- neither finance key. It goes live the moment a regional user is given
-- invoices.edit, which is what the regional model implies.
--
-- ===========================================================================
-- INVOKER, NOT A BRANCH ASSERTION
-- ===========================================================================
--
-- The branch here is a PROPERTY OF THE ROW — the invoice's — not a parameter.
-- assert_branch_writable() (0366) is the answer when a branch is handed in and
-- must be checked; there is nothing handed in here to check. Invoker brings
-- branch_scope back by itself and restates nothing, which is the same division
-- 0364 used for record_expense.
--
-- ===========================================================================
-- THE ALLOCATION CHANGES. THIS IS THE PART TO READ.
-- ===========================================================================
--
-- The oldest-first loop reads `invoices where client_id = v_client`. Under
-- DEFINER that saw every region. Under INVOKER it sees only what the caller
-- can, so:
--
--   A BRANCHED CALLER'S PAYMENT NOW SETTLES ONLY THEIR OWN REGION'S OLDEST OPEN
--   INVOICES FOR THAT CLIENT. Before, it settled the client's oldest across all
--   regions.
--
-- Almost certainly the intent — a regional operator receiving regional cash
-- should not be clearing another region's receivable — but it changes WHERE
-- MONEY LANDS, not merely who may act, and it is written here rather than
-- discovered from a reconciliation later. For an unbranched caller nothing
-- changes at all.
--
-- Naming an invoice from another region now returns 'Invoice not found', which
-- is the correct message: it is not found, for them.
--
-- ===========================================================================
-- WIDENING bank_transactions, AND THE LIMIT THAT REMAINS
-- ===========================================================================
--
-- Under invoker every write is checked against the caller. Walked one by one
-- for an operator holding invoices.edit and nothing else:
--
--   invoice_payments INSERT              invoices.edit        passes
--   invoices UPDATE (+ branch_scope)     invoices.edit        passes — the fix
--   the oldest-first read                branch_scope         scoped — the fix
--   treasury UPDATE (Cash)               no perm policy       passes
--   bank_transactions INSERT 'receipt'   accounting.edit      REFUSED
--   bank_accounts UPDATE (Bank)          accounting.edit      REFUSED
--
-- The bank_transactions row is WIDENED here, not worked around: a receipt's own
-- audit row is part of recording the receipt, and granting accounting.edit to
-- whoever records receipts would hand them bank transfers and deposits too. The
-- policy now admits invoices.edit for kind = 'receipt', mirroring the
-- expenses.edit carve-out that already exists for kind = 'expense'.
--
-- bank_accounts CANNOT be widened the same way and is left alone. Its UPDATE
-- policy governs the whole row — name, account number, balance — and RLS is
-- row-level, so there is no way to say "invoices.edit may move the balance and
-- nothing else". Widening it would hand over the account.
--
-- SO, PLAINLY: AFTER THIS MIGRATION, CASH-MODE RECEIPTS WORK FOR AN
-- invoices.edit-ONLY OPERATOR AND BANK-MODE RECEIPTS STILL REFUSE. On GGS the
-- one accounting user holds both keys, so nothing breaks today.
--
-- THE ESCAPE HATCH, LOGGED AND NOT BUILT: if receipts clerks should never hold
-- accounting.edit, the balance leg alone can move behind a narrow SECURITY
-- DEFINER helper gated on invoices.edit OR accounting.edit. That gives up
-- nothing about the branch — bank_accounts carries no branch_scope — and keeps
-- every branch-scoped write under invoker. It costs one definer function and
-- restates one permission rule, so it is worth doing only if the need is real.

-- ---------------------------------------------------------------------------
-- 1. The audit row for a receipt follows the receipt's own key.
-- ---------------------------------------------------------------------------
do $$
declare
  v_old text := '(has_perm(''accounting.edit''::text) OR (has_perm(''expenses.edit''::text) AND (kind = ''expense''::text) AND (bank_account_id IS NULL)))';
  v_n   int;
begin
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'bank_transactions'
     and policyname like 'perm_write%';
  if v_n <> 3 then
    raise exception
      '0369 REFUSED: expected 3 perm_write policies on bank_transactions, found %. The widening below assumes the shape 0312 left.', v_n;
  end if;
end $$;

drop policy if exists perm_write_ins on public.bank_transactions;
create policy perm_write_ins on public.bank_transactions for insert
  with check (
    has_perm('accounting.edit')
    or (has_perm('expenses.edit') and kind = 'expense' and bank_account_id is null)
    -- 0369: a receipt's own audit row is part of recording the receipt.
    or (has_perm('invoices.edit') and kind = 'receipt')
  );

drop policy if exists perm_write_upd on public.bank_transactions;
create policy perm_write_upd on public.bank_transactions for update
  using (
    has_perm('accounting.edit')
    or (has_perm('expenses.edit') and kind = 'expense' and bank_account_id is null)
    or (has_perm('invoices.edit') and kind = 'receipt')
  )
  with check (
    has_perm('accounting.edit')
    or (has_perm('expenses.edit') and kind = 'expense' and bank_account_id is null)
    or (has_perm('invoices.edit') and kind = 'receipt')
  );

drop policy if exists perm_write_del on public.bank_transactions;
create policy perm_write_del on public.bank_transactions for delete
  using (
    has_perm('accounting.edit')
    or (has_perm('expenses.edit') and kind = 'expense' and bank_account_id is null)
    or (has_perm('invoices.edit') and kind = 'receipt')
  );

-- ---------------------------------------------------------------------------
-- 2. The function stops acting on the caller's behalf and starts acting AS
--    them. Surgery on one word: the whole body is carried across unread.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def  text;
  v_hits int;
  a_sec  text := chr(10) || ' SECURITY DEFINER' || chr(10);
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_invoice_payment';
  if v_def is null then raise exception '0369 REFUSED: record_invoice_payment does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_sec, ''))) / length(a_sec);
  if v_hits <> 1 then
    raise exception
      '0369 REFUSED: the SECURITY DEFINER marker appears % time(s), expected exactly 1.', v_hits;
  end if;

  -- Removed, not replaced with SECURITY INVOKER: invoker is the default, and
  -- pg_get_functiondef will keep emitting nothing there, so a later reader sees
  -- the same absence this migration created.
  execute replace(v_def, a_sec, chr(10));
  raise notice '0369: record_invoice_payment is now SECURITY INVOKER.';
end $$;

comment on function public.record_invoice_payment(uuid, numeric, date, text, uuid, text, numeric, uuid, uuid) is
  '0369: SECURITY INVOKER. Records a receipt against a client''s open invoices, oldest first, and moves the cash or bank balance. Invoker on purpose: invoices and invoice_payments carry branch_scope, and a definer body switched it off — a branched user could pay any invoice in the company. NOTE THE ALLOCATION: a branched caller now settles only their own region''s oldest invoices. An invoices.edit-only operator can record Cash receipts; Bank receipts still need accounting.edit, because bank_accounts'' UPDATE policy governs the whole row and cannot be narrowed to the balance.';

-- ---------------------------------------------------------------------------
-- PROOF 1: it is invoker, and the detector agrees.
--
-- The same one-word defence 0364 gave record_expense. A later create-or-replace
-- adding SECURITY DEFINER would compile, work, pass every test, and silently
-- switch branch_scope back off.
-- ---------------------------------------------------------------------------
do $$
declare v_def boolean; v_flagged int;
begin
  select p.prosecdef into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_invoice_payment';
  if v_def then
    raise exception '0369 FAILED: record_invoice_payment is still SECURITY DEFINER.';
  end if;

  select count(*) into v_flagged from public.branch_guard_gaps()
   where function_name = 'record_invoice_payment';
  if v_flagged <> 0 then
    raise exception
      '0369 FAILED: branch_guard_gaps() still reports record_invoice_payment (% row(s)).', v_flagged;
  end if;
  raise notice '0369: invoker confirmed and branch_guard_gaps() no longer reports it.';
end $$;

-- ---------------------------------------------------------------------------
-- PROOF 2: the widened policy admits a receipt row for invoices.edit and still
-- refuses everything else it refused before.
--
-- Asserted against the POLICY TEXT rather than by attempting writes: this
-- session connects as an owner and bypasses RLS entirely, so an attempted
-- insert here would succeed regardless and prove nothing. Saying so rather than
-- writing a probe that cannot fail.
-- ---------------------------------------------------------------------------
do $$
declare v_n int;
begin
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'bank_transactions'
     and policyname like 'perm_write%'
     and coalesce(qual, '') || coalesce(with_check, '') like '%receipt%';
  if v_n <> 3 then
    raise exception
      '0369 FAILED: % of 3 bank_transactions write policies mention the receipt carve-out.', v_n;
  end if;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'bank_transactions'
     and policyname like 'perm_write%'
     and coalesce(qual, '') || coalesce(with_check, '') like '%expenses.edit%';
  if v_n <> 3 then
    raise exception
      '0369 FAILED: the expenses.edit carve-out was lost from % of 3 policies while widening.', 3 - v_n;
  end if;
  raise notice '0369: receipt carve-out present on all three write policies, expense carve-out intact.';
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
    raise exception '0369 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
