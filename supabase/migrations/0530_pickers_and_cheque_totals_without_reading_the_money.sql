-- 0530 — the bank picker and the cheque totals, without reading the money
--
-- Step one of locking down who can READ invoices, client receipts, bank
-- balances and the ledger (asked 2026-10-21; the read gates themselves are
-- 0531). Some screens read those tables for something smaller than the money:
--
--   * Expenses, Payroll, Payroll adjustments and the receivables / payables
--     tabs fill a bank picker from bank_accounts — `select *`, balances
--     included — for people who may pay from a bank but have no business
--     seeing what is in it.
--   * Expenses and Payroll add up, per cheque, what is already linked to it
--     across payslips, expenses, advances and invoice_payments, so a cheque is
--     not over-used. That reads every client receipt that came by cheque.
--   * Expenses and the receivables / payables tabs start their month picker at
--     the first journal entry, which reads the ledger to learn one date.
--
-- Four functions answer just those questions. Nothing else changes: no policy
-- moves here, and the screens fall back to their old reads until this is
-- applied, so the order of the app release and this migration does not matter.
--
--   bank_account_options(p_company_id)  id, bank name, last four digits, type,
--                                       active, owner — no balance
--   cheque_linked_amounts(p_company_id) cheque id, amount already linked
--   bank_can_cover(p_bank_account_id,   true / false — does the account hold at
--                  p_amount)            least this much. The screens refuse a
--                                       payment the bank cannot cover (nothing in
--                                       the database does: apply_money_delta has
--                                       no such check), and someone without
--                                       banks.view must keep that guard without
--                                       being shown the balance.
--   ledger_start_date(p_company_id)     the date of the first journal entry
--
-- All four SECURITY DEFINER (they must see the rows a gated caller cannot)
-- and so all carry the tenant guard; all are read-only and STABLE.

create or replace function public.bank_account_options(p_company_id uuid)
returns table(id uuid, bank_name text, account_last4 text, account_type text, active boolean, owner_type text, owner_partner_id uuid, owner_client_id uuid)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0530. What a bank picker needs and nothing more: no balance, and only
  -- the last four digits of the number.
  return query
  select b.id, b.bank_name::text, right(coalesce(b.account_number, ''), 4)::text,
         b.account_type::text, coalesce(b.active, true), b.owner_type::text, b.owner_partner_id, b.owner_client_id
    from public.bank_accounts b
   where b.company_id = p_company_id
   order by b.bank_name;
end $function$;

create or replace function public.cheque_linked_amounts(p_company_id uuid)
returns table(cheque_id uuid, linked numeric)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0530. Per cheque, what is already linked to it — the sum the Expenses and
  -- Payroll screens built from four tables, so they no longer read receipts.
  return query
  select x.cheque_id, sum(x.amount)::numeric
    from (
      select p.cheque_id, p.net_salary::numeric amount from public.payslips p where p.company_id = p_company_id and p.cheque_id is not null
      union all
      select e.cheque_id, e.amount::numeric from public.expenses e where e.company_id = p_company_id and e.cheque_id is not null
      union all
      select a.cheque_id, a.amount::numeric from public.advances a where a.company_id = p_company_id and a.cheque_id is not null
      union all
      select i.cheque_id, i.amount::numeric from public.invoice_payments i where i.company_id = p_company_id and i.cheque_id is not null
    ) x
   group by x.cheque_id;
end $function$;

create or replace function public.bank_can_cover(p_bank_account_id uuid, p_amount numeric)
returns boolean
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_company uuid; v_balance numeric;
begin
  select b.company_id, b.balance into v_company, v_balance from public.bank_accounts b where b.id = p_bank_account_id;
  if v_company is null then return false; end if;
  -- tenant guard [resolved]: p_bank_account_id's own company must be the
  -- caller's. Spelled with the parameter, which is what tenant_guard_gaps()
  -- reads for; asserting on v_company is the same check, invisible to it.
  perform public.assert_same_company((select b2.company_id from public.bank_accounts b2 where b2.id = p_bank_account_id));
  return coalesce(v_balance, 0) >= coalesce(p_amount, 0);
end $function$;

create or replace function public.ledger_start_date(p_company_id uuid)
returns date
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0530. Where the month pickers begin; one date, not the ledger.
  return (select min(j.entry_date)::date from public.journal_entries j where j.company_id = p_company_id);
end $function$;

revoke all on function public.bank_account_options(uuid) from public, anon;
revoke all on function public.cheque_linked_amounts(uuid) from public, anon;
grant execute on function public.bank_account_options(uuid) to authenticated;
grant execute on function public.cheque_linked_amounts(uuid) to authenticated;
revoke all on function public.bank_can_cover(uuid, numeric) from public, anon;
grant execute on function public.bank_can_cover(uuid, numeric) to authenticated;
revoke all on function public.ledger_start_date(uuid) from public, anon;
grant execute on function public.ledger_start_date(uuid) to authenticated;

do $$
declare v_n int; v_who text;
begin
  if to_regprocedure('public.bank_account_options(uuid)') is null or to_regprocedure('public.cheque_linked_amounts(uuid)') is null
     or to_regprocedure('public.bank_can_cover(uuid,numeric)') is null or to_regprocedure('public.ledger_start_date(uuid)') is null then
    raise exception '0530 REFUSED: a function is missing after create.';
  end if;
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ') into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then raise exception '0530 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who; end if;
end $$;
