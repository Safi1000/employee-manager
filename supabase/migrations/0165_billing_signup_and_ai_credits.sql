-- 0165: self-serve signup, Stripe billing, guard caps and AI credits.
--
-- Until now a company could only be created by a super-super-admin, and the
-- subscription was a date typed in by hand (companies.subscription_expires_at +
-- subscription_payments). This migration adds the machinery for an org to sign
-- itself up, pay, and be held to what it paid for:
--
--   * companies gains the plan it bought and its Stripe identifiers.
--   * signup_intents holds a would-be org BEFORE payment. Nothing is created in
--     auth.users or companies until Stripe confirms the money, which is the
--     "no sign-up without payment" rule expressed as data rather than as UI.
--   * a guard-cap trigger refuses employees past the paid headcount + buffer.
--   * ai_usage / ai_credit_ledger meter the AI assistant against the monthly
--     credit the plan includes, with prepaid top-ups when it runs out.
--
-- Money note: the landing page quotes PKR, but Stripe charges USD (Stripe has
-- no Pakistani merchant country). Every row that represents money therefore
-- stores BOTH sides plus the rate used, so an old charge can always be
-- explained even after the rate is changed.

-- ---------------------------------------------------------------------------
-- 1. The plan a company is on
-- ---------------------------------------------------------------------------
alter table public.companies
  -- Guards paid for. NULL = legacy/manually-created company with no cap, which
  -- is what every existing row is: the cap must not switch on retroactively.
  add column if not exists guard_limit integer,
  -- Grace headroom over guard_limit. The app warns inside the buffer; the
  -- trigger below refuses past it.
  add column if not exists guard_buffer integer not null default 5,
  add column if not exists plan_care boolean not null default false,
  add column if not exists plan_price_pkr numeric(12,2),
  add column if not exists plan_price_usd_cents integer,
  add column if not exists plan_fx_rate numeric(12,4),
  -- Mirrors the Stripe subscription's status so the app never has to call
  -- Stripe to render a screen.
  add column if not exists billing_status text,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists current_period_end timestamptz,
  -- AI credit, in PKR. monthly = the plan's allotment, reset each renewal;
  -- used = spent this period; topup = purchased credit, which carries over.
  add column if not exists ai_credit_monthly numeric(12,2) not null default 0,
  add column if not exists ai_credit_used numeric(12,4) not null default 0,
  add column if not exists ai_credit_topup numeric(12,4) not null default 0;

alter table public.companies
  drop constraint if exists companies_billing_status_check;
alter table public.companies
  add constraint companies_billing_status_check check (
    billing_status is null or billing_status in
      ('trialing','active','past_due','canceled','incomplete','unpaid')
  );

create unique index if not exists companies_stripe_customer_idx
  on public.companies (stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists companies_stripe_subscription_idx
  on public.companies (stripe_subscription_id) where stripe_subscription_id is not null;

comment on column public.companies.guard_limit is
  'Billable guards paid for. NULL means no cap (legacy company created by SSA).';
comment on column public.companies.guard_buffer is
  'Guards allowed over guard_limit before inserts are refused. The app warns inside this window.';

-- ---------------------------------------------------------------------------
-- 2. signup_intents — a paid-for org that does not exist yet
-- ---------------------------------------------------------------------------
-- Deliberately NOT storing a password. The visitor pays first; Stripe redirects
-- back with the token; only then do they choose a password, and only then is
-- anything created. A leaked intent row therefore exposes contact details, not
-- an account.
create table if not exists public.signup_intents (
  id uuid primary key default gen_random_uuid(),
  -- Random secret handed to the browser and returned after checkout. Separate
  -- from id so that guessing a row id is not enough to claim the org.
  token text not null unique,
  email text not null,
  full_name text,
  company_name text not null,

  -- What they bought.
  guards integer not null check (guards >= 1),
  care boolean not null default false,
  amount_pkr numeric(12,2) not null,
  amount_usd_cents integer not null,
  fx_rate numeric(12,4) not null,
  ai_credit_monthly numeric(12,2) not null default 0,

  stripe_customer_id text,
  stripe_checkout_session_id text,
  stripe_subscription_id text,

  -- pending  → checkout created, money not confirmed
  -- paid     → Stripe confirmed; the ONLY state signup-complete will act on
  -- claimed  → company + super admin created; token is spent
  -- expired  → never paid, or superseded
  status text not null default 'pending'
    check (status in ('pending','paid','claimed','expired')),
  company_id uuid references public.companies(id) on delete set null,

  created_at timestamptz not null default now(),
  paid_at timestamptz,
  claimed_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours'
);

create index if not exists signup_intents_email_idx on public.signup_intents (lower(email));
create index if not exists signup_intents_session_idx on public.signup_intents (stripe_checkout_session_id);

-- No policies at all: only the service role (edge functions) may touch this.
-- RLS on with zero policies = deny everything for anon and authenticated.
alter table public.signup_intents enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Stripe webhook log — the idempotency guard
-- ---------------------------------------------------------------------------
-- Stripe retries deliveries and can deliver the same event more than once.
-- Inserting the event id first, and treating a unique violation as "already
-- handled", is what stops a retry from granting a second month of credit.
create table if not exists public.billing_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  type text not null,
  company_id uuid references public.companies(id) on delete set null,
  payload jsonb,
  handled boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);
alter table public.billing_events enable row level security;

drop policy if exists ssa_read_billing_events on public.billing_events;
create policy ssa_read_billing_events on public.billing_events
  for select using (public.is_super_super_admin());

-- ---------------------------------------------------------------------------
-- 4. AI metering
-- ---------------------------------------------------------------------------
create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  thread_id uuid,
  model text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  cost_usd numeric(12,6) not null default 0,
  cost_pkr numeric(12,4) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_company_date_idx on public.ai_usage (company_id, created_at desc);
alter table public.ai_usage enable row level security;

drop policy if exists members_read_ai_usage on public.ai_usage;
create policy members_read_ai_usage on public.ai_usage
  for select using (company_id = public.current_company_id() or public.is_super_super_admin());

-- Every movement of credit, so a balance can always be explained.
create table if not exists public.ai_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('monthly_grant','topup','usage','adjustment','expiry')),
  -- Positive adds credit, negative spends it. PKR, because that is the unit the
  -- customer was quoted in.
  amount_pkr numeric(12,4) not null,
  monthly_after numeric(12,4),
  topup_after numeric(12,4),
  description text,
  ai_usage_id uuid references public.ai_usage(id) on delete set null,
  stripe_reference text,
  created_at timestamptz not null default now()
);
create index if not exists ai_credit_ledger_company_idx on public.ai_credit_ledger (company_id, created_at desc);
alter table public.ai_credit_ledger enable row level security;

drop policy if exists members_read_ai_ledger on public.ai_credit_ledger;
create policy members_read_ai_ledger on public.ai_credit_ledger
  for select using (company_id = public.current_company_id() or public.is_super_super_admin());

-- ---------------------------------------------------------------------------
-- 5. Billable headcount
-- ---------------------------------------------------------------------------
-- What the customer is charged for. office_staff is back-office and is not a
-- guard, so it is excluded; armed, gunman, reliever and client-posted guards
-- all count. 'On Leave' still counts — the guard is still on the books and
-- still occupies a slot.
create or replace function public.billable_guard_count(p_company uuid)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- category and status are enums; compared as text so this function keeps
  -- working if a new value is added to either type.
  select count(*)::integer
  from public.employees e
  where e.company_id = p_company
    and coalesce(e.category::text, '') <> 'office_staff'
    and coalesce(e.status::text, 'Active') <> 'Inactive'
$function$;

comment on function public.billable_guard_count(uuid) is
  'Guards a company is billed for: everything except office_staff, excluding Inactive.';

-- Refuse an insert that pushes a company past guard_limit + guard_buffer.
-- AFTER, not BEFORE, so the new row is included in the count — a BEFORE trigger
-- would let the company land exactly one guard over every time.
create or replace function public.enforce_guard_limit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_limit integer;
  v_buffer integer;
  v_count integer;
begin
  -- Only rows that consume a slot can breach the cap. This also means
  -- deactivating or deleting a guard is never blocked.
  if coalesce(new.category::text, '') = 'office_staff'
     or coalesce(new.status::text, 'Active') = 'Inactive' then
    return null;
  end if;

  select c.guard_limit, coalesce(c.guard_buffer, 0)
    into v_limit, v_buffer
  from public.companies c
  where c.id = new.company_id;

  -- No plan on file (every company created before self-serve signup): no cap.
  if v_limit is null then
    return null;
  end if;

  v_count := public.billable_guard_count(new.company_id);

  if v_count > v_limit + v_buffer then
    raise exception
      'guard_limit_exceeded: your plan covers % guards (plus a % guard buffer) and you now have %. Upgrade your plan to add more.',
      v_limit, v_buffer, v_count
      using errcode = 'check_violation';
  end if;

  return null;
end;
$function$;

drop trigger if exists trg_enforce_guard_limit on public.employees;
create trigger trg_enforce_guard_limit
  after insert or update of category, status, company_id on public.employees
  for each row execute function public.enforce_guard_limit();

-- ---------------------------------------------------------------------------
-- 6. AI credit arithmetic
-- ---------------------------------------------------------------------------
-- Spendable credit = what is left of this period's allotment, plus top-ups.
-- Top-ups carry over between periods; the monthly allotment does not.
create or replace function public.ai_credit_available(p_company uuid)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $function$
  select greatest(coalesce(c.ai_credit_monthly, 0) - coalesce(c.ai_credit_used, 0), 0)
       + coalesce(c.ai_credit_topup, 0)
  from public.companies c
  where c.id = p_company
$function$;

-- Spend credit. Drains the monthly allotment first so purchased top-ups are
-- kept for last — the customer's own money should outlive the freebie.
-- Returns false and writes nothing when there is not enough credit.
create or replace function public.ai_credit_spend(
  p_company uuid,
  p_amount numeric,
  p_description text default null,
  p_usage_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_monthly numeric;
  v_used numeric;
  v_topup numeric;
  v_free numeric;
  v_from_monthly numeric;
  v_from_topup numeric;
begin
  if p_amount is null or p_amount <= 0 then
    return true;
  end if;

  -- Lock the row: two AI calls landing at once must not both see the last
  -- rupee of credit and both spend it.
  select coalesce(ai_credit_monthly,0), coalesce(ai_credit_used,0), coalesce(ai_credit_topup,0)
    into v_monthly, v_used, v_topup
  from public.companies
  where id = p_company
  for update;

  if not found then
    return false;
  end if;

  v_free := greatest(v_monthly - v_used, 0);
  if v_free + v_topup < p_amount then
    return false;
  end if;

  v_from_monthly := least(v_free, p_amount);
  v_from_topup := p_amount - v_from_monthly;

  update public.companies
     set ai_credit_used = v_used + v_from_monthly,
         ai_credit_topup = v_topup - v_from_topup,
         updated_at = now()
   where id = p_company;

  insert into public.ai_credit_ledger
    (company_id, kind, amount_pkr, monthly_after, topup_after, description, ai_usage_id)
  values
    (p_company, 'usage', -p_amount,
     greatest(v_monthly - (v_used + v_from_monthly), 0), v_topup - v_from_topup,
     p_description, p_usage_id);

  return true;
end;
$function$;

-- Add purchased credit. Never expires, so it is written to the top-up bucket.
create or replace function public.ai_credit_topup(
  p_company uuid,
  p_amount numeric,
  p_reference text default null,
  p_description text default null
)
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_topup numeric;
begin
  update public.companies
     set ai_credit_topup = coalesce(companies.ai_credit_topup, 0) + p_amount,
         updated_at = now()
   where id = p_company
  returning companies.ai_credit_topup into v_topup;

  insert into public.ai_credit_ledger
    (company_id, kind, amount_pkr, topup_after, description, stripe_reference)
  values (p_company, 'topup', p_amount, v_topup,
          coalesce(p_description, 'AI credit top-up'), p_reference);

  return v_topup;
end;
$function$;

-- Start a new billing period: the unused part of the monthly allotment is
-- forfeited (it is an allowance, not a balance) and the meter goes back to zero.
create or replace function public.ai_credit_reset_period(
  p_company uuid,
  p_monthly numeric default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_monthly numeric;
  v_used numeric;
  v_new numeric;
begin
  select coalesce(ai_credit_monthly,0), coalesce(ai_credit_used,0)
    into v_monthly, v_used
  from public.companies where id = p_company for update;

  if not found then return; end if;

  v_new := coalesce(p_monthly, v_monthly);

  -- Record the forfeit explicitly rather than letting the number quietly change.
  if v_monthly - v_used > 0 then
    insert into public.ai_credit_ledger (company_id, kind, amount_pkr, description)
    values (p_company, 'expiry', -(v_monthly - v_used),
            'Unused monthly AI credit forfeited at period end');
  end if;

  update public.companies
     set ai_credit_monthly = v_new,
         ai_credit_used = 0,
         updated_at = now()
   where id = p_company;

  insert into public.ai_credit_ledger
    (company_id, kind, amount_pkr, monthly_after, description)
  values (p_company, 'monthly_grant', v_new, v_new, 'Monthly AI credit granted');
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. What the app needs to render the billing screen, in one call
-- ---------------------------------------------------------------------------
create or replace function public.billing_summary()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'company_id', c.id,
    'company_name', c.name,
    'billing_status', c.billing_status,
    'active', c.active,
    'guard_limit', c.guard_limit,
    'guard_buffer', c.guard_buffer,
    'guards_used', public.billable_guard_count(c.id),
    'plan_care', c.plan_care,
    'plan_price_pkr', c.plan_price_pkr,
    'current_period_end', c.current_period_end,
    'subscription_expires_at', c.subscription_expires_at,
    'has_subscription', c.stripe_subscription_id is not null,
    'ai_credit_monthly', c.ai_credit_monthly,
    'ai_credit_used', c.ai_credit_used,
    'ai_credit_topup', c.ai_credit_topup,
    'ai_credit_available', public.ai_credit_available(c.id)
  )
  from public.companies c
  where c.id = public.current_company_id()
$function$;

grant execute on function public.billing_summary() to authenticated;
grant execute on function public.billable_guard_count(uuid) to authenticated;
grant execute on function public.ai_credit_available(uuid) to authenticated;
