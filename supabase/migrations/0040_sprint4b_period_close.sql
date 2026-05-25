-- Sprint 4 — Part B: Period close + lock.
-- Spec section 6.5 + 8.4: once a month is closed by an admin, no transaction
-- in that period can be edited or created. Corrections require a new
-- transaction dated outside the closed period (a reversing entry pattern).

-- ---------------------------------------------------------------------------
-- 1. accounting_periods table — one row per (company_id, period_month).
--    period_month is the first-of-month date (e.g. 2026-05-01).
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_periods (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  period_month  date not null,
  closed_by     uuid references public.profiles(id) on delete set null,
  closed_at     timestamptz not null default now(),
  note          text,
  unique (company_id, period_month)
);

create index if not exists idx_periods_company on public.accounting_periods(company_id);
create index if not exists idx_periods_month on public.accounting_periods(company_id, period_month);

drop trigger if exists trg_aaa_periods_fill_company on public.accounting_periods;
create trigger trg_aaa_periods_fill_company
  before insert on public.accounting_periods
  for each row execute function public.fill_company_id();

alter table public.accounting_periods enable row level security;
drop policy if exists "ssa_all" on public.accounting_periods;
create policy "ssa_all" on public.accounting_periods for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.accounting_periods;
create policy "company_members" on public.accounting_periods for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 2. Helper: is_period_closed(company_id, ts) — true if the month containing
--    ts has been closed for that company.
-- ---------------------------------------------------------------------------
create or replace function public.is_period_closed(p_company_id uuid, p_date date)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.accounting_periods
    where company_id = p_company_id
      and period_month = date_trunc('month', p_date)::date
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Guard function: raises if the affected row falls in a closed period.
--    Reads NEW for INSERT/UPDATE, OLD for DELETE. The "affected date" column
--    name is passed via TG_ARGV[0] so one function works for all tables.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_period_lock()
returns trigger language plpgsql as $$
declare
  v_date_col text;
  v_new_date date;
  v_old_date date;
  v_company  uuid;
begin
  v_date_col := tg_argv[0];

  -- Skip when running outside any authenticated company context (e.g. server
  -- maintenance). Trust the caller in that case.
  if public.current_company_id() is null and not public.is_ssa_unscoped() then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    execute format('select ($1).%I::date, ($1).company_id', v_date_col)
      into v_old_date, v_company using old;
    if public.is_period_closed(v_company, v_old_date) then
      raise exception 'Period for % is closed. Deleting this row is not allowed; post a reversing entry in an open period instead.', v_old_date
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  -- INSERT or UPDATE
  execute format('select ($1).%I::date, ($1).company_id', v_date_col)
    into v_new_date, v_company using new;
  if public.is_period_closed(v_company, v_new_date) then
    raise exception 'Period for % is closed. New / edited rows in a closed month are not allowed; pick a later date or reopen the month first.', v_new_date
      using errcode = 'P0001';
  end if;

  -- For UPDATE, also block moving a row OUT of a closed month (editing the date).
  if tg_op = 'UPDATE' then
    execute format('select ($1).%I::date', v_date_col)
      into v_old_date using old;
    if v_old_date is distinct from v_new_date
       and public.is_period_closed(v_company, v_old_date) then
      raise exception 'Source period for % is closed. Moving a row out of a closed month requires reopening it first.', v_old_date
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Attach the guard to every financial table, keyed by its "when did it
--    happen" column.
-- ---------------------------------------------------------------------------
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('invoices',          'invoice_date'),
      ('invoice_payments',  'payment_date'),
      ('expenses',          'expense_date'),
      ('payslips',          'period_month'),
      ('advances',          'advance_date'),
      ('cheques',           'cheque_date')
    ) as t(tbl, col)
  loop
    execute format('drop trigger if exists trg_%I_period_lock on public.%I', spec.tbl, spec.tbl);
    execute format(
      'create trigger trg_%I_period_lock
         before insert or update or delete on public.%I
         for each row execute function public.enforce_period_lock(%L)',
      spec.tbl, spec.tbl, spec.col
    );
  end loop;
end$$;
