-- ============================================================================
-- ADDITIVE migration. No data loss.
-- 1) inventory_items.branch_id + issuances.branch_id (backfilled to Head Office /
--    inherited from employee/client).
-- 2) clients.auto_invoice_withholding (WHT amount applied by run_auto_invoices).
-- 3) cheques.cheque_type ('payment' | 'cash'). Default 'payment' for existing rows.
-- 4) Cash-cheque clearance bumps treasury.cash_balance (bank stays deducted).
-- 5) Payment-cheque clearance requires the sum of linked payslips/expenses/
--    advances to equal the cheque amount exactly.
-- 6) Branch RLS scope extended to inventory_items + issuances.
-- ============================================================================

-- ---------- 1. Inventory branches ----------
alter table public.inventory_items
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.issuances
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

-- Backfill inventory_items to each company's Head Office.
update public.inventory_items i
   set branch_id = b.id
  from public.branches b, public.locations l
 where l.id = i.location_id
   and b.company_id = l.company_id
   and b.is_head_office = true
   and i.branch_id is null;

-- Items with no location_id (rare) — fall back to first Head Office (single-company default).
update public.inventory_items i
   set branch_id = b.id
  from public.branches b
 where b.is_head_office = true
   and i.branch_id is null;

-- Backfill issuances from employee branch first, else client branch, else Head Office.
update public.issuances iss
   set branch_id = sub.branch_id
  from (
    select i.id as iss_id,
           coalesce(e.branch_id, c.branch_id) as branch_id
      from public.issuances i
      left join public.employees e on e.id = i.employee_id
      left join public.clients c on c.id = i.client_id
     where i.branch_id is null
  ) sub
 where iss.id = sub.iss_id
   and iss.branch_id is null
   and sub.branch_id is not null;

update public.issuances iss
   set branch_id = b.id
  from public.branches b
 where b.is_head_office = true
   and iss.branch_id is null;

-- Branch-scoped RLS for inventory_items + issuances.
drop policy if exists "branch_scope" on public.inventory_items;
create policy "branch_scope" on public.inventory_items as restrictive for all
  using (not public.is_branched_user() or branch_id = public.current_branch_id() or public.is_super_super_admin())
  with check (not public.is_branched_user() or branch_id = public.current_branch_id() or public.is_super_super_admin());

drop policy if exists "branch_scope" on public.issuances;
create policy "branch_scope" on public.issuances as restrictive for all
  using (not public.is_branched_user() or branch_id = public.current_branch_id() or public.is_super_super_admin())
  with check (not public.is_branched_user() or branch_id = public.current_branch_id() or public.is_super_super_admin());

-- ---------- 2. Client auto-invoice withholding tax ----------
alter table public.clients
  add column if not exists auto_invoice_withholding numeric(14,2) not null default 0
    check (auto_invoice_withholding >= 0);

-- Update the run_auto_invoices function to use the WHT.
create or replace function public.run_auto_invoices(p_run_date date default current_date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  period_start date;
  inv_number text;
  issued int := 0;
begin
  for rec in
    select c.id as client_id, c.company_id, c.auto_invoice_amount, c.advance_payment,
           c.contract_start, c.contract_end,
           coalesce(c.auto_invoice_withholding, 0) as wht
      from public.clients c
     where c.auto_invoice_enabled = true
       and coalesce(c.auto_invoice_amount, 0) > 0
  loop
    if rec.advance_payment then
      period_start := date_trunc('month', p_run_date)::date;
    else
      period_start := (date_trunc('month', p_run_date) - interval '1 month')::date;
    end if;

    if rec.contract_start is not null and period_start < rec.contract_start then
      continue;
    end if;
    if rec.contract_end is not null and period_start > rec.contract_end then
      continue;
    end if;

    if exists (
      select 1 from public.invoices
       where client_id = rec.client_id
         and invoice_date = period_start
         and invoice_amount = rec.auto_invoice_amount
    ) then
      continue;
    end if;

    inv_number := public.next_invoice_number(rec.company_id, period_start);

    insert into public.invoices (
      client_id, invoice_number, invoice_date, invoice_amount,
      withholding_tax, amount_received, status, notes
    ) values (
      rec.client_id, inv_number, period_start, rec.auto_invoice_amount,
      rec.wht, 0, 'Pending',
      'Auto-issued for ' || to_char(period_start, 'Mon YYYY')
    );
    issued := issued + 1;
  end loop;
  return issued;
end;
$$;

-- ---------- 3. Cheque type ----------
do $$ begin
  create type public.cheque_type as enum ('payment', 'cash');
exception when duplicate_object then null; end $$;

alter table public.cheques
  add column if not exists cheque_type public.cheque_type not null default 'payment';

-- ---------- 4 + 5. Trigger updates ----------
-- Validation + side-effects on cheque status transitions.
-- INSERT/DELETE balance handling stays in cheque_apply_balance; we extend the BEFORE UPDATE
-- to enforce clearance rules and bump treasury on cash-cheque clearance.
create or replace function public.cheque_apply_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_total numeric(14,2) := 0;
  trea_id uuid;
begin
  if TG_OP = 'INSERT' then
    update public.bank_accounts
       set balance = balance - NEW.amount,
           updated_at = now()
     where id = NEW.bank_account_id;
    return NEW;
  elsif TG_OP = 'DELETE' then
    if OLD.status = 'pending' then
      update public.bank_accounts
         set balance = balance + OLD.amount,
             updated_at = now()
       where id = OLD.bank_account_id;
      -- A pending cash cheque hasn't yet credited the treasury, so nothing to undo there.
    elsif OLD.status = 'cleared' and OLD.cheque_type = 'cash' then
      -- Cleared cash cheque was reversed: bank stays as-is (already deducted),
      -- but we must undo the treasury credit to keep books square.
      update public.treasury
         set cash_balance = cash_balance - OLD.amount,
             updated_at = now();
    end if;
    return OLD;
  elsif TG_OP = 'UPDATE' then
    if NEW.amount <> OLD.amount or NEW.bank_account_id <> OLD.bank_account_id then
      raise exception 'Cheque amount and bank account cannot be changed after creation';
    end if;
    if NEW.cheque_type <> OLD.cheque_type then
      raise exception 'Cheque type cannot be changed after creation';
    end if;

    -- Clearance transition: pending -> cleared
    if NEW.status = 'cleared' and OLD.status = 'pending' then
      if NEW.cheque_type = 'payment' then
        -- Sum of linked items must equal cheque amount exactly.
        select coalesce(sum(amount), 0) into linked_total from (
          select net_salary as amount from public.payslips where cheque_id = NEW.id
          union all
          select amount from public.expenses where cheque_id = NEW.id
          union all
          select amount from public.advances where cheque_id = NEW.id
          union all
          select amount from public.invoice_payments where cheque_id = NEW.id
        ) s;
        if linked_total <> NEW.amount then
          raise exception 'Cannot clear payment cheque: linked items total PKR % but cheque is PKR %',
            linked_total, NEW.amount;
        end if;
      elsif NEW.cheque_type = 'cash' then
        -- Cash cheque clearance: bump treasury cash by the cheque amount.
        select id into trea_id from public.treasury limit 1;
        if trea_id is null then
          raise exception 'No treasury row exists; cannot apply cash cheque clearance';
        end if;
        update public.treasury
           set cash_balance = cash_balance + NEW.amount,
               updated_at = now()
         where id = trea_id;
      end if;

      if NEW.cleared_at is null then
        NEW.cleared_at := now();
      end if;
    end if;

    -- Reverse clearance: cleared -> pending
    if NEW.status = 'pending' and OLD.status = 'cleared' then
      if NEW.cheque_type = 'cash' then
        -- Undo the treasury credit.
        update public.treasury
           set cash_balance = cash_balance - NEW.amount,
               updated_at = now();
      end if;
      NEW.cleared_at := null;
    end if;

    return NEW;
  end if;
  return null;
end;
$$;
