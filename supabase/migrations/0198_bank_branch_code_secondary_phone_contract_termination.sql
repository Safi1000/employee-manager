-- 0198: three fields the forms now ask for and had nowhere to store.
--
-- 1. employees.bank_branch_code — the bank's branch code. Pakistani salary
--    transfers are quoted as bank + branch code + account number; we captured
--    the first and third and left the office to look the branch up by hand on
--    every disbursement run. Joins the required set alongside the other bank
--    fields, so a record can't reach payroll half-banked.
--
-- 2. employees.secondary_phone — an alternate number. Optional: it exists
--    because a guard's own phone is off as often as it is on, and the emergency
--    contact is the wrong person to call about a shift.
--
-- 3. contracts.termination_date — the date a contract was actually terminated.
--    Status could be moved to 'terminated' with no record of WHEN, which left
--    billing and notice-period questions unanswerable after the fact.
--
-- All three are nullable: existing rows predate the rule, and the UI (not a
-- NOT NULL constraint) is what enforces them going forward, so historic records
-- stay readable and are fixed on their next edit.

alter table public.employees
  add column if not exists bank_branch_code text,
  add column if not exists secondary_phone  text;

comment on column public.employees.bank_branch_code is
  'Bank branch code for salary transfer. Required by the employee form (see missingRequiredFields).';
comment on column public.employees.secondary_phone is
  'Optional alternate contact number for the employee. Not the emergency contact.';

alter table public.contracts
  add column if not exists termination_date date;

comment on column public.contracts.termination_date is
  'Date the contract was terminated. Required by the contract editor whenever status = terminated.';
