-- ============================================================================
-- ADDITIVE migration.
-- 1) expenses.branch_id + advances.branch_id columns; backfill to Head Office
--    (preferring client.branch_id, then employee.branch_id).
-- 2) Cheque capacity guard: total of payslips/expenses/advances/invoice_payments
--    linked to a payment cheque can never exceed the cheque amount.
-- 3) Storage bucket `cheque-attachments` + RLS for authenticated CRUD.
-- ============================================================================

-- 1. branch_id columns
alter table public.expenses
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.advances
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

-- Backfill expenses: client's branch first; office expenses (no client) -> Head Office.
update public.expenses e
   set branch_id = c.branch_id
  from public.clients c
 where c.id = e.client_id
   and e.branch_id is null
   and c.branch_id is not null;

update public.expenses e
   set branch_id = b.id
  from public.branches b
 where b.is_head_office = true
   and e.branch_id is null;

-- Backfill advances: employee branch first; client branch second; Head Office last.
update public.advances a
   set branch_id = e.branch_id
  from public.employees e
 where e.id = a.employee_id
   and a.branch_id is null
   and e.branch_id is not null;

update public.advances a
   set branch_id = c.branch_id
  from public.clients c
 where c.id = a.client_id
   and a.branch_id is null
   and c.branch_id is not null;

update public.advances a
   set branch_id = b.id
  from public.branches b
 where b.is_head_office = true
   and a.branch_id is null;

-- Branch RLS for the new columns: extend the existing branch_scope policies.
drop policy if exists "branch_scope" on public.expenses;
create policy "branch_scope" on public.expenses as restrictive for all
  using (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id()
    or (branch_id is null and (
      expenses.client_id is null
      or exists (select 1 from public.clients c where c.id = expenses.client_id and c.branch_id = public.current_branch_id())
    )))
  with check (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id()
    or (branch_id is null and (
      expenses.client_id is null
      or exists (select 1 from public.clients c where c.id = expenses.client_id and c.branch_id = public.current_branch_id())
    )));

drop policy if exists "branch_scope" on public.advances;
create policy "branch_scope" on public.advances as restrictive for all
  using (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id()
    or (branch_id is null and exists (
      select 1 from public.employees e where e.id = advances.employee_id and e.branch_id = public.current_branch_id()
    )))
  with check (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id()
    or (branch_id is null and exists (
      select 1 from public.employees e where e.id = advances.employee_id and e.branch_id = public.current_branch_id()
    )));

-- 2. Cheque capacity guard
create or replace function public.assert_cheque_capacity(p_cheque uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  chq_amount numeric(14,2);
  total numeric(14,2);
begin
  if p_cheque is null then return; end if;
  select amount into chq_amount from public.cheques where id = p_cheque;
  if chq_amount is null then return; end if;

  select coalesce(sum(amount), 0) into total from (
    select net_salary as amount from public.payslips where cheque_id = p_cheque
    union all
    select amount from public.expenses where cheque_id = p_cheque
    union all
    select amount from public.advances where cheque_id = p_cheque
    union all
    select amount from public.invoice_payments where cheque_id = p_cheque
  ) s;

  if total > chq_amount then
    raise exception 'Cheque capacity exceeded: linked items total PKR % > cheque amount PKR %', total, chq_amount;
  end if;
end;
$$;

create or replace function public.check_cheque_capacity_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.cheque_id is not null then
    perform public.assert_cheque_capacity(NEW.cheque_id);
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_payslips_cheque_capacity on public.payslips;
create trigger trg_payslips_cheque_capacity
  after insert or update of cheque_id, net_salary on public.payslips
  for each row execute function public.check_cheque_capacity_trigger();

drop trigger if exists trg_expenses_cheque_capacity on public.expenses;
create trigger trg_expenses_cheque_capacity
  after insert or update of cheque_id, amount on public.expenses
  for each row execute function public.check_cheque_capacity_trigger();

drop trigger if exists trg_advances_cheque_capacity on public.advances;
create trigger trg_advances_cheque_capacity
  after insert or update of cheque_id, amount on public.advances
  for each row execute function public.check_cheque_capacity_trigger();

drop trigger if exists trg_invoice_payments_cheque_capacity on public.invoice_payments;
create trigger trg_invoice_payments_cheque_capacity
  after insert or update of cheque_id, amount on public.invoice_payments
  for each row execute function public.check_cheque_capacity_trigger();

-- 3. Cheque attachments bucket
insert into storage.buckets (id, name, public)
values ('cheque-attachments', 'cheque-attachments', false)
on conflict (id) do nothing;

-- Authenticated users can read/write within their own folders (cheque_id prefix).
drop policy if exists "cheque_attachments_read" on storage.objects;
create policy "cheque_attachments_read" on storage.objects for select
  to authenticated using (bucket_id = 'cheque-attachments');

drop policy if exists "cheque_attachments_insert" on storage.objects;
create policy "cheque_attachments_insert" on storage.objects for insert
  to authenticated with check (bucket_id = 'cheque-attachments');

drop policy if exists "cheque_attachments_update" on storage.objects;
create policy "cheque_attachments_update" on storage.objects for update
  to authenticated using (bucket_id = 'cheque-attachments');

drop policy if exists "cheque_attachments_delete" on storage.objects;
create policy "cheque_attachments_delete" on storage.objects for delete
  to authenticated using (bucket_id = 'cheque-attachments');
