-- 0346 — an approved expense is locked.
--
-- WHAT EXISTS ALREADY, because the brief asked and the answer changes the build.
--
--   1. `expenses` HAS NO APPROVAL AT ALL. The approval path in Expenses.tsx —
--      openDecision, decisionTarget, status 'pending'/'approved'/'denied' — is
--      on `fixed_expense_instances`, the monthly entries a fixed-expense
--      TEMPLATE raises. Approving one of those CREATES an expense. It says
--      nothing about the expense afterwards, and an ordinary hand-entered
--      expense never touches it.
--
--   2. `payable_status` CANNOT CARRY THIS, and it is worth saying why rather
--      than just adding a column. Its values are 'Pending' / 'Paid'; it is set
--      only when payment_mode = 'Payable' and is NULL on every Cash, Bank and
--      Cheque expense. It answers "has the vendor been paid", which is a
--      PAYMENT question. Approval here is explicitly a REVIEW and explicitly
--      NOT a payment gate — cash may already have left with a custodian. Two
--      different questions with different answer sets; one column cannot hold
--      both, and overloading it would make 'Paid' silently mean 'reviewed'.
--
-- So approval gets its own two columns, and the lock is enforced here rather
-- than in the screen, because the screen is not the only writer.
--
-- WHAT LOCKING MEANS. Once approved: no UPDATE, no DELETE. A correction is a
-- reversal — the same discipline as the period lock (0322), applied to a
-- document rather than a month. Unapproving is the way back, it is audited, and
-- it is the ONLY field an approved expense will accept.
--
-- WHY UNAPPROVE IS PERMITTED AT ALL. Same shape as un-archiving before
-- deleting: a lock nobody can lift is not a control, it is a defect waiting for
-- a maintenance session. The escape is narrow, visible and recorded.

alter table public.expenses
  add column if not exists approved_at   timestamptz,
  add column if not exists approved_by   uuid references public.profiles(id),
  add column if not exists unapproved_at timestamptz,
  add column if not exists unapproved_by uuid references public.profiles(id);

comment on column public.expenses.approved_at is
  '0346: when the expense was reviewed and locked. NOT a payment date — payable_status answers payment. Non-null means UPDATE and DELETE are refused until it is unapproved.';
comment on column public.expenses.approved_by is
  '0346: who approved it. Held after unapproval too, so the audit trail survives the lock being lifted.';
comment on column public.expenses.unapproved_at is
  '0346: when the lock was last lifted. Kept so that an approve/unapprove/re-approve cycle is visible rather than looking like a first approval.';

create index if not exists expenses_approved_idx
  on public.expenses (company_id, approved_at)
  where approved_at is not null;

-- ---------------------------------------------------------------------------
-- The lock.
--
-- Written as a BEFORE trigger so the refusal happens before the journal
-- triggers repost anything. The transition test is on OLD, not NEW: what is
-- forbidden is changing a row that WAS approved.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_expense_approval_lock()
returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'DELETE' then
    if old.approved_at is not null then
      raise exception
        'Expense of % dated % was approved on % and cannot be deleted. Unapprove it first, or post a correcting reversal — an approved expense is a reviewed document.',
        old.amount, old.expense_date, to_char(old.approved_at, 'YYYY-MM-DD');
    end if;
    return old;
  end if;

  -- INSERT: nothing to protect yet. An expense may legitimately be created
  -- already approved (the fixed-expense instance path stamps it on creation).
  if tg_op = 'INSERT' then
    return new;
  end if;

  if old.approved_at is null then
    return new;                      -- not locked; ordinary edit
  end if;

  -- Locked. The ONLY permitted transition is unapproval, and it must clear
  -- approved_at while touching nothing else.
  if new.approved_at is null then
    if new.amount            is distinct from old.amount
    or new.expense_date      is distinct from old.expense_date
    or new.category_id       is distinct from old.category_id
    or new.client_id         is distinct from old.client_id
    or new.vendor_id         is distinct from old.vendor_id
    or new.description       is distinct from old.description
    or new.payment_mode      is distinct from old.payment_mode
    or new.bank_account_id   is distinct from old.bank_account_id
    or new.custodian_location_id is distinct from old.custodian_location_id
    or new.branch_id         is distinct from old.branch_id
    or new.pl_category       is distinct from old.pl_category then
      raise exception
        'Unapproving an expense and editing it are two separate steps. Unapprove it first, then edit — otherwise the change is invisible to whoever approved it.';
    end if;

    new.unapproved_at := now();
    new.unapproved_by := auth.uid();
    return new;
  end if;

  -- Still approved, and something changed. Refuse, naming the field so the
  -- message is actionable rather than "not allowed".
  if new.amount is distinct from old.amount then
    raise exception 'Expense was approved on % — its amount cannot be changed from % to %. Unapprove it first, or post a correcting reversal.',
      to_char(old.approved_at, 'YYYY-MM-DD'), old.amount, new.amount;
  end if;
  if new.expense_date is distinct from old.expense_date then
    raise exception 'Expense was approved on % — its date cannot be changed. Unapprove it first.',
      to_char(old.approved_at, 'YYYY-MM-DD');
  end if;
  if new.category_id is distinct from old.category_id then
    raise exception 'Expense was approved on % — its category cannot be changed. The category decides which account it posts to, so this would move a reviewed figure to a different line of the P&L. Unapprove it first.',
      to_char(old.approved_at, 'YYYY-MM-DD');
  end if;
  if new.payment_mode         is distinct from old.payment_mode
  or new.bank_account_id      is distinct from old.bank_account_id
  or new.custodian_location_id is distinct from old.custodian_location_id
  or new.client_id            is distinct from old.client_id
  or new.vendor_id            is distinct from old.vendor_id
  or new.branch_id            is distinct from old.branch_id
  or new.pl_category          is distinct from old.pl_category
  or new.description          is distinct from old.description then
    raise exception 'Expense was approved on % and is locked. Unapprove it first — an approved expense is a reviewed document, and a silent edit is exactly what approval is meant to prevent.',
      to_char(old.approved_at, 'YYYY-MM-DD');
  end if;

  -- Everything else (receipt attachment, notes, payable_status, paid_at) is
  -- deliberately still writable: paying a vendor and attaching a receipt do
  -- not change what was reviewed, and blocking them would make approval a
  -- payment gate, which the ruling says it is not.
  return new;
end;
$fn$;

comment on function public.enforce_expense_approval_lock() is
  '0346: an approved expense refuses UPDATE of every field that changes what was reviewed, and refuses DELETE. Unapproval is the one permitted transition and must arrive alone. Payment fields (payable_status, paid_at, paid_via, receipt) stay writable BY DESIGN — approval is a review, not a payment gate.';

drop trigger if exists trg_expense_approval_lock on public.expenses;
create trigger trg_expense_approval_lock
  before update or delete on public.expenses
  for each row execute function public.enforce_expense_approval_lock();

-- ---------------------------------------------------------------------------
-- Probe. Rollback only.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co  uuid;
  v_id  uuid;
  v_msg text;
begin
  select id into v_co from public.companies order by created_at limit 1;
  if v_co is null then raise notice '0346: no company to probe; skipped.'; return; end if;

  begin
    insert into public.expenses (company_id, amount, expense_date, payment_mode, pl_category, description)
    values (v_co, 100, current_date, 'Payable', 'operating_expense', '0346 probe')
    returning id into v_id;

    update public.expenses set amount = 200 where id = v_id;   -- unapproved: fine

    update public.expenses set approved_at = now() where id = v_id;

    begin
      update public.expenses set amount = 300 where id = v_id;
      raise exception '0346 FAILED: an approved expense accepted an amount change.';
    exception when others then
      v_msg := sqlerrm;
      if v_msg like '0346 FAILED%' then raise; end if;
      if v_msg not like '%approved%' then
        raise exception '0346 FAILED: the refusal did not name approval — got %', v_msg;
      end if;
    end;

    begin
      delete from public.expenses where id = v_id;
      raise exception '0346 FAILED: an approved expense was deleted.';
    exception when others then
      v_msg := sqlerrm;
      if v_msg like '0346 FAILED%' then raise; end if;
      if v_msg not like '%cannot be deleted%' then
        raise exception '0346 FAILED: the delete refusal was the wrong one — got %', v_msg;
      end if;
    end;

    -- Payment fields still move while approved. This is the ruling, tested.
    update public.expenses set payable_status = 'Paid', paid_at = now() where id = v_id;

    -- Unapprove, alone, is permitted; then the edit lands.
    update public.expenses set approved_at = null where id = v_id;
    update public.expenses set amount = 400 where id = v_id;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0346: probe passed — locked against edit and delete, open to payment and unapproval.';
  end;
end $$;
