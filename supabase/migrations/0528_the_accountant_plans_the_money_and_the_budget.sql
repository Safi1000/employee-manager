-- 0528 — the accountant's plan: expected money in and out, and a monthly budget
--
-- Asked for 2026-10-20 ("planning ... expected dates ... compare with actual")
-- and listed as needing new tables on 2026-10-21. Two tables, both entered by
-- people and read by the Accountant page's Planning section and the P&L's
-- budget column. Neither posts anything, moves any balance or feeds the ledger:
-- a plan is a statement of intent, and the comparison is always plan against
-- what the ledger already says happened.
--
--   cash_plan     one expected receipt or payment: which way, what kind, for
--                 whom, how much, by when; marked done (with what actually
--                 happened) or dropped. The Planning section lists the month's
--                 expected items against the ledger's actual movements by kind.
--   budget_lines  a monthly amount per chart-of-accounts line (and optionally
--                 per region): the "Budget" column beside Actual on the P&L.
--
-- ACCESS. Two new keys, granted person by person like accountant.view:
--   planning.view  read both tables
--   planning.edit  write them
-- Both are added to public.permission_keys here AND to PERMISSION_GROUPS in
-- src/app/lib/supabase.ts in the same change, so every_demanded_permission_is_
-- grantable stays green (CLAUDE.md, "A key the grant screen cannot offer").
--
-- SHAPE, matching the tables beside it: company_members + ssa_all permissive,
-- a restrictive branch scope for region-locked users, restrictive read/write
-- gates on the keys; fill_company_id first, region from the client where there
-- is one, company-not-archived, updated_at, and the audit trigger.
--
-- A column a user must fill is not done until a user can fill it: the screens
-- that write both tables land in the same change as this file (Accountant ▸
-- Planning, Financial Reports ▸ Budget).
--
-- Idempotent: create if not exists, policies and triggers dropped and recreated
-- by name, keys on conflict do nothing.

-- ---------------------------------------------------------------------------
-- 1. Keys
-- ---------------------------------------------------------------------------
insert into public.permission_keys (key, grp, label) values
  ('planning.view', 'Reports & Finance', 'See the cash plan and budget (Accountant ▸ Planning)'),
  ('planning.edit', 'Reports & Finance', 'Add and change the cash plan and budget')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. cash_plan
-- ---------------------------------------------------------------------------
create table if not exists public.cash_plan (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  branch_id      uuid references public.branches(id),
  direction      text not null check (direction in ('in', 'out')),
  kind           text not null check (kind in ('client_receipt', 'salaries', 'expense', 'vendor', 'advance', 'partner', 'tax', 'loan', 'other')),
  client_id      uuid references public.clients(id) on delete set null,
  vendor_id      uuid references public.vendors(id) on delete set null,
  description    text not null check (length(trim(description)) > 0),
  expected_date  date not null,
  amount         numeric(14,2) not null check (amount > 0),
  status         text not null default 'expected' check (status in ('expected', 'done', 'dropped')),
  actual_date    date,
  actual_amount  numeric(14,2) check (actual_amount is null or actual_amount >= 0),
  notes          text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- "Done" says what happened; "expected" and "dropped" carry no actuals.
  constraint cash_plan_actuals_only_when_done check (status = 'done' or (actual_date is null and actual_amount is null))
);
create index if not exists cash_plan_company_date on public.cash_plan (company_id, expected_date);

comment on table public.cash_plan is
  '0528. Expected receipts and payments, entered by the accountant. A plan, never a posting: nothing reads it into the ledger. Accountant ▸ Planning compares it with the ledger''s actual movements by kind.';

-- ---------------------------------------------------------------------------
-- 3. budget_lines
-- ---------------------------------------------------------------------------
create table if not exists public.budget_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  branch_id     uuid references public.branches(id),
  period_month  date not null check (period_month = date_trunc('month', period_month)::date),
  account_id    uuid not null references public.chart_of_accounts(id),
  amount        numeric(14,2) not null,
  notes         text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- One figure per account per month per region (no region = the whole company).
create unique index if not exists budget_lines_one_per_account_month
  on public.budget_lines (company_id, period_month, account_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

comment on table public.budget_lines is
  '0528. A monthly budget per chart-of-accounts line, optionally per region. Read beside the trial balance as the P&L''s Budget column; never posted.';

-- ---------------------------------------------------------------------------
-- 4. Row-level security, the same shape as the tables beside them
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['cash_plan', 'budget_lines'] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists company_members on public.%I', t);
    execute format('create policy company_members on public.%I for all using (company_id = (select public.current_company_id())) with check (company_id = (select public.current_company_id()))', t);

    execute format('drop policy if exists ssa_all on public.%I', t);
    execute format('create policy ssa_all on public.%I for all using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()))', t);

    -- A region-locked user sees their region's lines and the company-wide ones.
    execute format('drop policy if exists branch_scope on public.%I', t);
    execute format('create policy branch_scope on public.%I as restrictive for all using ((not (select public.is_branched_user())) or (select public.is_super_super_admin()) or branch_id is null or branch_id = (select public.current_branch_id())) with check ((not (select public.is_branched_user())) or (select public.is_super_super_admin()) or branch_id is null or branch_id = (select public.current_branch_id()))', t);

    execute format('drop policy if exists perm_read on public.%I', t);
    execute format('create policy perm_read on public.%I as restrictive for select using ((select public.has_perm(''planning.view'')) or (select public.has_perm(''planning.edit'')))', t);

    execute format('drop policy if exists perm_write_ins on public.%I', t);
    execute format('create policy perm_write_ins on public.%I as restrictive for insert with check ((select public.has_perm(''planning.edit'')))', t);
    execute format('drop policy if exists perm_write_upd on public.%I', t);
    execute format('create policy perm_write_upd on public.%I as restrictive for update using ((select public.has_perm(''planning.edit''))) with check ((select public.has_perm(''planning.edit'')))', t);
    execute format('drop policy if exists perm_write_del on public.%I', t);
    execute format('create policy perm_write_del on public.%I as restrictive for delete using ((select public.has_perm(''planning.edit'')))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Triggers, the same set and order as fixed_expenses / renewal_pipeline
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['cash_plan', 'budget_lines'] loop
    execute format('drop trigger if exists trg_aaa_%1$s_fill_company on public.%1$I', t);
    execute format('create trigger trg_aaa_%1$s_fill_company before insert on public.%1$I for each row execute function public.fill_company_id()', t);
    execute format('drop trigger if exists trg_company_not_archived on public.%I', t);
    execute format('create trigger trg_company_not_archived before insert or delete or update on public.%I for each row execute function public.enforce_company_not_archived()', t);
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$I', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$I for each row execute function public.touch_updated_at()', t);
    execute format('drop trigger if exists trg_zzz_%1$s_audit on public.%1$I', t);
    execute format('create trigger trg_zzz_%1$s_audit after insert or delete or update on public.%1$I for each row execute function public.log_audit_change()', t);
  end loop;
end $$;

-- A receipt from a client sits in that client's region, as on every table that names one.
drop trigger if exists trg_bbb_cash_plan_region on public.cash_plan;
create trigger trg_bbb_cash_plan_region before insert or update of client_id, company_id on public.cash_plan
  for each row execute function public.inherit_region_from_client_col();

-- ---------------------------------------------------------------------------
-- 6. Asserts — on the things that can break
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  -- RLS really on (a table without it is open to every signed-in user).
  select count(*) into v_n from pg_class
   where oid in ('public.cash_plan'::regclass, 'public.budget_lines'::regclass) and relrowsecurity;
  if v_n <> 2 then raise exception '0528 REFUSED: row-level security is not enabled on both planning tables (% of 2).', v_n; end if;

  -- The write gate is restrictive on both (a permissive one would widen access, not narrow it).
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename in ('cash_plan', 'budget_lines')
     and policyname in ('perm_read', 'perm_write_ins', 'perm_write_upd', 'perm_write_del') and permissive = 'RESTRICTIVE';
  if v_n <> 8 then raise exception '0528 REFUSED: expected 8 restrictive permission policies, found %.', v_n; end if;

  -- Every key a policy demands is grantable.
  select count(*), string_agg(key::text, ', ') into v_n, v_who from public.permission_key_gaps();
  if v_n <> 0 then raise exception '0528 REFUSED: permission_key_gaps() reports %: %', v_n, v_who; end if;

  -- Tenant guards still clean.
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ') into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then raise exception '0528 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who; end if;
end $$;
