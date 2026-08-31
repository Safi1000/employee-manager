-- 0263 — Give payslips somewhere to put the custodian, and recover the two
-- values that are currently only knowable by luck.
--
-- payslips is the one table in the cash chain with NO custodian column.
-- PayrollManagement.tsx computes custodianLocId at disbursement and writes it
-- into bank_transactions.reference_id — a uuid in a text column, on a row that
-- exists for a different purpose. Every cash payroll disbursement's location is
-- therefore recoverable only by string-matching a description. That is not a
-- foundation, and category 2 of the G2 investigation is recoverable today only
-- because the sandbox is small.
--
-- This must land BEFORE 0264 repoints post_payslip_disbursement, because that
-- repoint needs a column to read.
--
-- The backfill is asserted, not assumed: it matches on employee code AND
-- amount, then refuses to proceed if any payslip matched more than one
-- bank_transactions row. A silent multi-match would attribute someone's cash to
-- the wrong custodian, which is the defect this whole sequence exists to fix.

alter table public.payslips
  add column if not exists custodian_location_id uuid references public.cash_locations(id);

comment on column public.payslips.custodian_location_id is
  'Cash location whose custodian physically handed out this payslip''s net pay. Written by the disbursement path for payment_mode = Cash. Added by 0263; before it, the value existed only inside bank_transactions.reference_id.';

create index if not exists idx_payslips_custodian_loc
  on public.payslips (custodian_location_id) where custodian_location_id is not null;

-- Refuse an ambiguous backfill.
do $$
declare v_bad int;
begin
  select count(*) into v_bad from (
    select ps.id
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
      join public.bank_transactions bt
        on bt.kind = 'payroll'
       and bt.company_id = ps.company_id
       and bt.reference_id is not null
       and bt.description like '%' || e.employee_code || '%'
       and abs(bt.cash_delta) = ps.net_salary
     where ps.payment_mode = 'Cash' and ps.disbursed
     group by ps.id having count(*) > 1
  ) x;
  if v_bad > 0 then
    raise exception
      '% payslip(s) match more than one payroll bank_transactions row — backfilling would guess at a custodian. Resolve by hand.',
      v_bad using errcode = '23514';
  end if;
end $$;

update public.payslips ps
   set custodian_location_id = sub.loc
  from (
    select ps2.id,
           (select cl.id from public.cash_locations cl where cl.id::text = bt.reference_id) as loc
      from public.payslips ps2
      join public.employees e on e.id = ps2.employee_id
      join public.bank_transactions bt
        on bt.kind = 'payroll'
       and bt.company_id = ps2.company_id
       and bt.reference_id is not null
       and bt.description like '%' || e.employee_code || '%'
       and abs(bt.cash_delta) = ps2.net_salary
     where ps2.payment_mode = 'Cash' and ps2.disbursed
  ) sub
 where ps.id = sub.id
   and sub.loc is not null
   and ps.custodian_location_id is distinct from sub.loc;