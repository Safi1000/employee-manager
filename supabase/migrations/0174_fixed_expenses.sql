-- 0174: fixed (recurring monthly) expenses.
--
-- Rent, utilities, internet, office salaries paid to a vendor — costs that
-- recur every month at a known amount. Re-typing them on the 1st is clerical
-- work that nobody remembers to do, so the month closes with real spend
-- missing from the P&L.
--
-- Two tables, deliberately:
--
--   fixed_expenses           the TEMPLATE. Created exactly like an expense
--                            (same category / client / vendor / mode / amount),
--                            but with no date — it describes what recurs.
--
--   fixed_expense_instances  ONE ROW PER TEMPLATE PER MONTH, raised on the 1st
--                            and sitting at 'pending' until someone approves or
--                            denies it.
--
-- The instance is a SNAPSHOT, not a view of the template. Editing the template
-- next March must not rewrite what was approved last January, and an instance
-- is routinely edited before approval anyway (the electricity bill is never
-- exactly the estimate). So every field the expense needs is copied down at
-- generation time and lived on from there.
--
-- Nothing hits the ledger until approval. A pending or denied instance is not
-- an expense: it has no row in public.expenses, contributes nothing to the P&L,
-- moves no cash and no bank balance. Approval is what creates the real expense,
-- and the instance keeps a pointer to it.

-- ---------------------------------------------------------------------------
-- 1. The template
-- ---------------------------------------------------------------------------
create table if not exists public.fixed_expenses (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,

  -- Same shape as an expense, minus expense_date (that is what recurs).
  category_id      uuid references public.expense_categories(id) on delete set null,
  pl_category      public.expense_pl_category not null default 'operating_expense',
  client_id        uuid references public.clients(id) on delete set null,
  branch_id        uuid references public.branches(id) on delete set null,
  vendor_id        uuid references public.vendors(id) on delete set null,
  description      text,
  amount           numeric(14,2) not null check (amount > 0),

  -- Cheque is deliberately absent. A cheque expense must name ONE specific
  -- pending cheque, which cannot be known months ahead — a recurring template
  -- has no cheque to point at. Approve the instance as Bank or Payable and
  -- settle it with a cheque through the normal payables flow.
  payment_mode     text not null check (payment_mode in ('Cash','Bank','Payable')),
  bank_account_id  uuid references public.bank_accounts(id) on delete set null,
  -- Payable only: which day of the month the invoice falls due.
  due_day          smallint check (due_day between 1 and 28),
  notes            text,

  -- Window. start_month is the first month that raises an instance; generation
  -- never reaches back before it, so adding a template today cannot conjure
  -- twelve months of unapproved history. end_month closes the series.
  start_month      date not null,
  end_month        date,
  is_active        boolean not null default true,

  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint fixed_expenses_window check (end_month is null or end_month >= start_month),
  -- Both months are stored as the 1st so every comparison is a plain date test.
  constraint fixed_expenses_start_is_first check (date_trunc('month', start_month)::date = start_month),
  constraint fixed_expenses_end_is_first check (end_month is null or date_trunc('month', end_month)::date = end_month)
);

create index if not exists fixed_expenses_company_idx
  on public.fixed_expenses (company_id, is_active);

-- ---------------------------------------------------------------------------
-- 2. The monthly instance
-- ---------------------------------------------------------------------------
create table if not exists public.fixed_expense_instances (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  fixed_expense_id  uuid not null references public.fixed_expenses(id) on delete cascade,
  period_month      date not null,

  -- Snapshot of the template, editable until approval.
  category_id       uuid references public.expense_categories(id) on delete set null,
  pl_category       public.expense_pl_category not null default 'operating_expense',
  client_id         uuid references public.clients(id) on delete set null,
  branch_id         uuid references public.branches(id) on delete set null,
  vendor_id         uuid references public.vendors(id) on delete set null,
  description       text,
  amount            numeric(14,2) not null check (amount > 0),
  payment_mode      text not null check (payment_mode in ('Cash','Bank','Payable')),
  bank_account_id   uuid references public.bank_accounts(id) on delete set null,
  due_date          date,
  notes             text,

  status            text not null default 'pending'
                      check (status in ('pending','approved','denied')),
  -- Set only once approved. This is the ONLY link between a fixed expense and
  -- the real ledger; while it is null the instance has cost nothing.
  expense_id        uuid references public.expenses(id) on delete set null,
  decision_note     text,
  decided_by        uuid references auth.users(id),
  decided_at        timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint fixed_expense_instances_unique unique (fixed_expense_id, period_month),
  constraint fixed_expense_instances_month_is_first
    check (date_trunc('month', period_month)::date = period_month),
  -- An approved instance must point at its expense; a pending or denied one
  -- must not. This is the invariant that keeps "approved" and "in the P&L" the
  -- same statement.
  constraint fixed_expense_instances_expense_matches_status check (
    (status = 'approved' and expense_id is not null)
    or (status <> 'approved' and expense_id is null)
  )
);

create index if not exists fixed_expense_instances_period_idx
  on public.fixed_expense_instances (company_id, period_month, status);
create index if not exists fixed_expense_instances_template_idx
  on public.fixed_expense_instances (fixed_expense_id);

-- ---------------------------------------------------------------------------
-- 3. Generation
-- ---------------------------------------------------------------------------
-- Idempotent by construction: the unique (fixed_expense_id, period_month) plus
-- ON CONFLICT DO NOTHING means running it twice, or ten times, on the 1st is
-- the same as running it once. That is what lets the app call it on page load
-- as well as pg_cron calling it monthly — whichever happens first wins, the
-- other is a no-op, and a missed cron run repairs itself the next time anyone
-- opens the page.
--
-- Editing an already-raised instance is therefore safe: it is never rewritten
-- from the template afterwards.
create or replace function public.generate_fixed_expense_instances(p_month date default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_month date := date_trunc('month', coalesce(p_month, current_date))::date;
  v_count integer;
begin
  insert into public.fixed_expense_instances (
    company_id, fixed_expense_id, period_month,
    category_id, pl_category, client_id, branch_id, vendor_id,
    description, amount, payment_mode, bank_account_id, due_date, notes, status
  )
  select
    f.company_id, f.id, v_month,
    f.category_id, f.pl_category, f.client_id, f.branch_id, f.vendor_id,
    f.description, f.amount, f.payment_mode, f.bank_account_id,
    case when f.payment_mode = 'Payable'
         then v_month + ((coalesce(f.due_day, 1) - 1) || ' days')::interval
         else null end::date,
    f.notes, 'pending'
  from public.fixed_expenses f
  where f.is_active
    and f.start_month <= v_month
    and (f.end_month is null or f.end_month >= v_month)
  on conflict (fixed_expense_id, period_month) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end $function$;

revoke execute on function public.generate_fixed_expense_instances(date) from public, anon;
grant execute on function public.generate_fixed_expense_instances(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
alter table public.fixed_expenses enable row level security;
alter table public.fixed_expense_instances enable row level security;

drop policy if exists company_members on public.fixed_expenses;
create policy company_members on public.fixed_expenses
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

drop policy if exists ssa_all on public.fixed_expenses;
create policy ssa_all on public.fixed_expenses
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());

drop policy if exists company_members on public.fixed_expense_instances;
create policy company_members on public.fixed_expense_instances
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

drop policy if exists ssa_all on public.fixed_expense_instances;
create policy ssa_all on public.fixed_expense_instances
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());

-- ---------------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------------
drop trigger if exists trg_aaa_fixed_expenses_fill_company on public.fixed_expenses;
create trigger trg_aaa_fixed_expenses_fill_company
before insert on public.fixed_expenses
for each row execute function public.fill_company_id();

drop trigger if exists trg_fixed_expenses_updated_at on public.fixed_expenses;
create trigger trg_fixed_expenses_updated_at
before update on public.fixed_expenses
for each row execute function public.touch_updated_at();

drop trigger if exists trg_aaa_fixed_expense_instances_fill_company on public.fixed_expense_instances;
create trigger trg_aaa_fixed_expense_instances_fill_company
before insert on public.fixed_expense_instances
for each row execute function public.fill_company_id();

drop trigger if exists trg_fixed_expense_instances_updated_at on public.fixed_expense_instances;
create trigger trg_fixed_expense_instances_updated_at
before update on public.fixed_expense_instances
for each row execute function public.touch_updated_at();

-- Approving one of these spends money, so both the template and every decision
-- on it are auditable.
drop trigger if exists trg_zzz_fixed_expenses_audit on public.fixed_expenses;
create trigger trg_zzz_fixed_expenses_audit
after insert or update or delete on public.fixed_expenses
for each row execute function public.log_audit_change();

drop trigger if exists trg_zzz_fixed_expense_instances_audit on public.fixed_expense_instances;
create trigger trg_zzz_fixed_expense_instances_audit
after insert or update or delete on public.fixed_expense_instances
for each row execute function public.log_audit_change();

-- ---------------------------------------------------------------------------
-- 6. Monthly raise, 00:05 on the 1st
-- ---------------------------------------------------------------------------
-- Belt and braces with the app-side call. Cron guarantees the instances exist
-- even in a month nobody opens the page; the app-side call guarantees they
-- exist even if cron is unavailable or the run was missed.
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('raise-fixed-expenses');
  end if;
exception when others then
  null;
end $cron$;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'raise-fixed-expenses',
      '5 0 1 * *',
      $job$ select public.generate_fixed_expense_instances(current_date); $job$
    );
  end if;
end $cron$;
