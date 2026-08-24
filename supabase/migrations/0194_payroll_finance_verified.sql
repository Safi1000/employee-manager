-- 0194: permanent "Finance Verified" state for a Payroll Run scope.
--
-- A scope reaches phase='finance_verify' via "Send to Finance" (still reversible
-- with Back to Review). Finance Verify is the PERMANENT sign-off: it stamps
-- finance_verified_at and can never be undone or reversed. Once stamped:
--   • Payroll Management shows the client (only finance-verified clients appear).
--   • OPS un-verify + Back to Review / Back to Draft lock forever (enforced below).
alter table public.payroll_run_phases add column if not exists finance_verified_at timestamptz;
alter table public.payroll_run_phases add column if not exists finance_verified_by uuid references auth.users(id);

-- Permanence: once finance_verified_at is set, the row can't be deleted, and its
-- phase / verification stamp can't be changed. No path back to any earlier state.
create or replace function public.enforce_finance_verify_lock() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    if OLD.finance_verified_at is not null then
      raise exception 'This scope is Finance Verified and locked — it cannot be reversed.';
    end if;
    return OLD;
  end if;
  -- UPDATE: a finance-verified row is frozen (phase can't move, stamp can't clear).
  if OLD.finance_verified_at is not null
     and (NEW.finance_verified_at is distinct from OLD.finance_verified_at
          or NEW.phase is distinct from OLD.phase) then
    raise exception 'This scope is Finance Verified and locked — it cannot be reversed.';
  end if;
  return NEW;
end $$;

drop trigger if exists trg_finance_verify_lock on public.payroll_run_phases;
create trigger trg_finance_verify_lock
  before update or delete on public.payroll_run_phases
  for each row execute function public.enforce_finance_verify_lock();
