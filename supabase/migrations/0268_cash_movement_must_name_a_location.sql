-- 0268 — Cash cannot be posted to an unnamed box.
--
-- LAST in the sequence, deliberately. A NOT NULL before 0263 gave payslips a
-- column and 0264 pointed the readers at it would have been a rule about a field
-- nobody could fill. Every writer now has a column, and the application was
-- always collecting the value — the gap was never data entry, it was that the
-- readers named a different column.
--
-- SHAPE: a CHECK, not NOT NULL. A location is required only where cash actually
-- moves. Bank and Cheque rows have no custodian and never should; NOT NULL would
-- force a meaningless value onto every one of them.
--
-- SCOPED TO WHERE THE POSTING HAPPENS:
--   expenses, invoice_payments, advances  posting is immediate, so
--                                         payment_mode = 'Cash' is the trigger
--   payslips                              cash moves on DISBURSEMENT, so the
--                                         condition is Cash AND disbursed.
--                                         8 of 10 cash payslips are undisbursed
--                                         and hold no custodian; requiring one
--                                         before the money moves would block
--                                         ordinary payroll generation.
--
-- THE ONE VIOLATION was the period-split fixture receipt (category 3 of the G2
-- investigation) — a cash payment with no custodian, which record_invoice_payment
-- via the Cash Custody path would never produce. It is repaired here, guarded to
-- SANDBOX TESTING ORG so this cannot quietly rewrite real data, and anything
-- outside the sandbox raises instead. Repairing it also trips the repost set that
-- 0264 installed, so the row's journal entry re-posts onto the custodian account
-- by the ordinary path rather than by anything special-cased here.

do $$
declare
  v_co  uuid;
  v_loc uuid;
  v_n   int;
begin
  select id into v_co from public.companies where name = 'SANDBOX TESTING ORG';

  select count(*) into v_n from public.invoice_payments
   where payment_mode = 'Cash' and custodian_location_id is null
     and (v_co is null or company_id <> v_co);
  if v_n > 0 then
    raise exception
      '% cash payment(s) outside the sandbox have no custodian location — these are real rows and must be resolved by hand, not repaired by a migration',
      v_n using errcode = '23514';
  end if;

  if v_co is not null then
    select id into v_loc from public.cash_locations
     where company_id = v_co and is_active is not false
       and custodian_employee_id is not null
     order by name limit 1;

    if v_loc is not null then
      update public.invoice_payments
         set custodian_location_id = v_loc
       where company_id = v_co
         and payment_mode = 'Cash'
         and custodian_location_id is null;
    end if;
  end if;
end $$;

do $$ begin
  alter table public.expenses
    add constraint expenses_cash_names_a_location
    check (payment_mode <> 'Cash' or custodian_location_id is not null);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.invoice_payments
    add constraint invoice_payments_cash_names_a_location
    check (payment_mode <> 'Cash' or custodian_location_id is not null);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.advances
    add constraint advances_cash_names_a_location
    check (payment_mode <> 'Cash' or custodian_location_id is not null);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.payslips
    add constraint payslips_disbursed_cash_names_a_location
    check (payment_mode <> 'Cash' or not disbursed or custodian_location_id is not null);
exception when duplicate_object then null; end $$;