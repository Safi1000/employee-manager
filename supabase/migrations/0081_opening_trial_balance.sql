-- Opening trial balance (spec section 4.4).
--
-- "One balanced opening TB loaded at cutover: bank balances, receivables,
-- valued assets, inventory, payables & statutory liabilities, partner capital,
-- balancing equity. Dr must equal Cr. Figures produced by management; the
-- system needs an opening-balance import that posts them as the opening
-- journal."
--
-- Shape: a batch of lines that can be staged, reviewed and corrected while in
-- draft, then posted once as a single journal entry. Two rules do the work:
--
--   * Dr must equal Cr before anything posts. Not a warning — the post is
--     refused. An opening TB that doesn't balance is the one thing that would
--     re-break the ledger section 4 just repaired.
--   * A batch posts exactly once. Re-posting is refused rather than
--     duplicating equity, which is the classic way opening balances get
--     silently doubled.
--
-- Lines carry a region, so regional opening balances land in the right
-- regional P&L/balance sheet from day one instead of everything piling onto
-- head office.

do $$ begin
  create type public.opening_batch_status as enum ('draft', 'posted', 'voided');
exception when duplicate_object then null; end $$;

create table if not exists public.opening_balance_batches (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  as_of_date   date not null,
  description  text,
  status       public.opening_batch_status not null default 'draft',
  posted_at    timestamptz,
  posted_by    uuid,
  journal_entry_id uuid references public.journal_entries(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.opening_balance_lines (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references public.opening_balance_batches(id) on delete cascade,
  account_id  uuid not null references public.chart_of_accounts(id) on delete restrict,
  branch_id   uuid references public.branches(id),
  debit       numeric(16,2) not null default 0,
  credit      numeric(16,2) not null default 0,
  notes       text,
  constraint ob_positive check (debit >= 0 and credit >= 0),
  constraint ob_one_side check (debit = 0 or credit = 0)
);

create index if not exists idx_ob_batch_company on public.opening_balance_batches(company_id);
create index if not exists idx_ob_lines_batch   on public.opening_balance_lines(batch_id);

-- Only one posted opening batch per company: a second one would mean the
-- business had two cutovers, which it didn't.
create unique index if not exists idx_ob_one_posted_per_company
  on public.opening_balance_batches (company_id) where status = 'posted';

drop trigger if exists trg_aaa_ob_fill_company on public.opening_balance_batches;
create trigger trg_aaa_ob_fill_company
  before insert on public.opening_balance_batches
  for each row execute function public.fill_company_id();

alter table public.opening_balance_batches enable row level security;
drop policy if exists "ssa_all" on public.opening_balance_batches;
create policy "ssa_all" on public.opening_balance_batches for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.opening_balance_batches;
create policy "company_members" on public.opening_balance_batches for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

alter table public.opening_balance_lines enable row level security;
drop policy if exists "ssa_all" on public.opening_balance_lines;
create policy "ssa_all" on public.opening_balance_lines for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "via_batch" on public.opening_balance_lines;
create policy "via_batch" on public.opening_balance_lines for all
  using (exists (
    select 1 from public.opening_balance_batches b
     where b.id = batch_id and b.company_id = public.current_company_id()))
  with check (exists (
    select 1 from public.opening_balance_batches b
     where b.id = batch_id and b.company_id = public.current_company_id()));

-- A draft is editable; a posted batch is history and is not.
create or replace function public.guard_posted_opening_batch()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_status public.opening_batch_status;
begin
  select status into v_status from public.opening_balance_batches
   where id = coalesce(new.batch_id, old.batch_id);
  if v_status = 'posted' then
    raise exception 'opening batch is already posted and cannot be edited'
      using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_ob_lines_guard on public.opening_balance_lines;
create trigger trg_ob_lines_guard
  before insert or update or delete on public.opening_balance_lines
  for each row execute function public.guard_posted_opening_batch();

-- ---------------------------------------------------------------------------
-- Validation, callable from the UI so the imbalance is visible before anyone
-- tries to post.
-- ---------------------------------------------------------------------------

create or replace function public.opening_batch_totals(p_batch_id uuid)
returns table (total_debit numeric, total_credit numeric, difference numeric)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(debit), 0),
         coalesce(sum(credit), 0),
         coalesce(sum(debit), 0) - coalesce(sum(credit), 0)
    from public.opening_balance_lines where batch_id = p_batch_id;
$$;

-- ---------------------------------------------------------------------------
-- Post the batch as the opening journal.
-- ---------------------------------------------------------------------------

create or replace function public.post_opening_balances(p_batch_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  b        record;
  v_diff   numeric;
  v_count  integer;
  v_lines  jsonb;
  v_entry  uuid;
begin
  select * into b from public.opening_balance_batches where id = p_batch_id;
  if not found then
    raise exception 'opening batch % not found', p_batch_id using errcode = '23503';
  end if;
  if b.status = 'posted' then
    raise exception 'opening batch % is already posted', p_batch_id using errcode = '23505';
  end if;
  if b.status = 'voided' then
    raise exception 'opening batch % is voided', p_batch_id using errcode = '23514';
  end if;

  select count(*) into v_count from public.opening_balance_lines where batch_id = p_batch_id;
  if v_count = 0 then
    raise exception 'opening batch % has no lines', p_batch_id using errcode = '23514';
  end if;

  select difference into v_diff from public.opening_batch_totals(p_batch_id);
  if v_diff <> 0 then
    raise exception 'opening trial balance does not balance: debits minus credits = %', v_diff
      using errcode = '23514',
            hint = 'Dr must equal Cr before the opening journal can post.';
  end if;

  -- Every line already names its account and region, so this hands
  -- post_journal explicit account_ids rather than system keys.
  select jsonb_agg(
           jsonb_build_object(
             'account_id', l.account_id,
             'debit',      l.debit,
             'credit',     l.credit,
             'region',     coalesce(l.branch_id, public.head_office_region(b.company_id))
           ))
    into v_lines
    from public.opening_balance_lines l
   where l.batch_id = p_batch_id;

  v_entry := public.post_journal(
    b.company_id,
    b.as_of_date,
    coalesce(b.description, 'Opening trial balance'),
    'opening_balance_batches', b.id, false,
    v_lines,
    public.head_office_region(b.company_id)
  );

  update public.opening_balance_batches
     set status = 'posted',
         posted_at = now(),
         posted_by = auth.uid(),
         journal_entry_id = v_entry,
         updated_at = now()
   where id = p_batch_id;

  return v_entry;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trial balance straight off the ledger, per region. This is what "the chart
-- of accounts activates" means in practice: one query, always balanced.
-- ---------------------------------------------------------------------------

create or replace view public.trial_balance
  with (security_invoker = true) as
  select je.company_id,
         a.id           as account_id,
         a.account_code,
         a.account_name,
         a.account_type,
         a.parent_id,
         jl.branch_id,
         br.name        as region_name,
         sum(jl.debit)  as total_debit,
         sum(jl.credit) as total_credit,
         sum(jl.debit) - sum(jl.credit) as net_debit
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
    left join public.branches br on br.id = jl.branch_id
   group by je.company_id, a.id, a.account_code, a.account_name, a.account_type,
            a.parent_id, jl.branch_id, br.name;
