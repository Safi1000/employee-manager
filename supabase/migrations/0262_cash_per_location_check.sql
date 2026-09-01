-- 0262 — A per-location cash check that compares the GL to the OPERATIONAL
-- record, not to itself. See supabase/migrations/0262_cash_per_location_check.sql
-- for the full rationale; the short form:
--
-- cash_control_equals_cash_locations (0259) compares the control subtree to
-- sum(cash_location_balances.balance), and that view is itself derived from
-- journal_lines. Both sides are the GL. It measures "lines on the parent that
-- are on no child" — real and useful, and exactly the 595,990.13 — but it
-- cannot see a location whose GL disagrees with the cash actually held.
--
-- custodian_held_operational() mirrors src/app/lib/custodian.ts term for term.
-- Custodian locations only; BANK-type belongs to bank_control_equals_bank_accounts.
-- EXPECTED RED ON ARRIVAL — five posting paths read a column nothing writes.

create or replace function public.custodian_held_operational(p_company_id uuid)
returns table(cash_location_id uuid, location_name text,
              operational numeric, gl numeric, difference numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with loc as (
    select cl.id, cl.name, cl.opening_balance, cl.coa_account_id
      from public.cash_locations cl
     where cl.company_id = p_company_id
       and cl.is_active is not false
       and (cl.custodian_employee_id is not null or cl.custodian_partner_id is not null)
  ),
  op as (
    select l.id,
           l.opening_balance
         + coalesce((select sum(t.amount) from public.custody_transfers t
                      where t.company_id = p_company_id and t.to_location_id = l.id), 0)
         - coalesce((select sum(t.amount) from public.custody_transfers t
                      where t.company_id = p_company_id and t.from_location_id = l.id), 0)
         + coalesce((select sum(p.amount) from public.invoice_payments p
                      where p.payment_mode = 'Cash' and p.custodian_location_id = l.id), 0)
         - coalesce((select sum(e.amount) from public.expenses e
                      where e.custodian_location_id = l.id), 0)
         - coalesce((select sum(a.amount) from public.advances a
                      where a.payment_mode = 'Cash' and a.custodian_location_id = l.id), 0)
         + coalesce((select sum(c.amount) from public.cheques c
                      where c.cheque_type = 'cash' and c.status = 'cleared'
                        and c.custodian_location_id = l.id), 0)
         + coalesce((select sum(b.cash_delta) from public.bank_transactions b
                      where b.kind in ('withdraw_to_cash', 'payroll')
                        and b.reference_id = l.id::text), 0)
         + coalesce((select sum(case when pe.type = 'CONTRIBUTION' then pe.amount
                                     else -pe.amount end)
                       from public.partner_account_entries pe
                      where pe.payment_method = 'CASH' and pe.cash_location_id = l.id), 0)
           as operational
      from loc l
  ),
  gl as (
    select l.id,
           l.opening_balance
         + coalesce((select sum(jl.debit - jl.credit) from public.journal_lines jl
                      where jl.account_id = l.coa_account_id), 0) as gl
      from loc l
  )
  select l.id, l.name,
         round(op.operational, 2),
         round(gl.gl, 2),
         round(gl.gl - op.operational, 2)
    from loc l join op on op.id = l.id join gl on gl.id = l.id
   order by l.name;
$function$;

comment on function public.custodian_held_operational(uuid) is
  'Per custodian cash location: the OPERATIONAL held-cash figure (mirroring src/app/lib/custodian.ts term for term) beside the GL balance on that location''s account. Difference = gl - operational.';

-- 0259's body is RENAMED, not retyped — a second copy would drift from the
-- first. Guarded so a re-run is a no-op.
do $$ begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'ledger_checks_base') then
    alter function public.ledger_checks(uuid) rename to ledger_checks_base;
  end if;
end $$;

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric,
              difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select * from public.ledger_checks_base(p_company_id)
  union all
  select 'cash_per_location_gl_equals_operational'::text,
         0::numeric,
         count(*)::numeric,
         count(*)::numeric,
         count(*) = 0
    from public.custodian_held_operational(p_company_id) h
   where abs(h.difference) > 0.005;
$function$;