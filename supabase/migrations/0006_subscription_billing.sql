-- ============================================================================
-- Subscription billing (SSA-only):
-- - companies.subscription_expires_at: when subscription runs out (NULL = unlimited).
-- - subscription_payments: audit log of manual payments / days added.
-- - add_subscription_payment(): SSA-only RPC that logs a payment, extends
--   expiry, and reactivates the company.
-- - enforce_subscription_expiry(): idempotent sweep that deactivates expired
--   companies. Called from the frontend on app load.
-- ============================================================================

alter table public.companies
  add column if not exists subscription_expires_at date;

create table if not exists public.subscription_payments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  amount        numeric(14,2) not null check (amount >= 0),
  days_added    integer not null check (days_added > 0),
  payment_date  date not null default current_date,
  notes         text,
  recorded_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists subscription_payments_company_idx
  on public.subscription_payments(company_id);

alter table public.subscription_payments enable row level security;
drop policy if exists "ssa_only_all" on public.subscription_payments;
create policy "ssa_only_all" on public.subscription_payments for all
  using (public.is_super_super_admin())
  with check (public.is_super_super_admin());

create or replace function public.add_subscription_payment(
  p_company_id    uuid,
  p_amount        numeric,
  p_days          integer,
  p_payment_date  date default current_date,
  p_notes         text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role public.user_role;
  current_expiry date;
  base_date date;
  new_expiry date;
begin
  select role into caller_role from public.profiles where id = auth.uid();
  if caller_role is null or caller_role <> 'super_super_admin' then
    raise exception 'only super_super_admin can manage subscriptions';
  end if;
  if p_days is null or p_days <= 0 then
    raise exception 'days must be positive';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'amount must be non-negative';
  end if;

  select subscription_expires_at into current_expiry
  from public.companies where id = p_company_id;

  base_date := greatest(coalesce(current_expiry, current_date), current_date);
  new_expiry := base_date + (p_days || ' days')::interval;

  insert into public.subscription_payments
    (company_id, amount, days_added, payment_date, notes, recorded_by)
  values
    (p_company_id, p_amount, p_days, p_payment_date, p_notes, auth.uid());

  update public.companies
  set subscription_expires_at = new_expiry,
      active = true,
      updated_at = now()
  where id = p_company_id;
end;
$$;

create or replace function public.enforce_subscription_expiry()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.companies
  set active = false,
      updated_at = now()
  where active = true
    and subscription_expires_at is not null
    and subscription_expires_at < current_date;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function public.enforce_subscription_expiry() to authenticated;
grant execute on function public.add_subscription_payment(uuid, numeric, integer, date, text) to authenticated;
