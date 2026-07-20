-- Inter-Region & HO–Region Loan Accounts (spec section 7).
--
-- A running balance per region pair (Head Office is a party). Funding posts
-- Dr Inter-region Receivable (lender) / Cr Inter-region Payable (borrower),
-- both region-tagged, and shifts the cash entitlement (§8 reads these).
-- Repayments net it down; the consolidated balance nets to zero. Funding
-- requires COO approval via the §2 engine. D2: no interest by default, but the
-- markup field exists so policy can change without a migration.

-- Receivable (lender's asset) / payable (borrower's liability) accounts.
insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side,
   system_key, system_account, active)
select c.id, v.code, v.name, v.atype::public.account_type,
       v.side::public.account_normal_side, v.key, true, true
  from public.companies c
  cross join (values
    ('1400', 'Inter-region Receivable', 'asset',     'debit',  'interregion_receivable'),
    ('2500', 'Inter-region Payable',    'liability', 'credit', 'interregion_payable')
  ) as v(code, name, atype, side, key)
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = v.key
 );

do $$ begin
  create type public.interregion_txn_type as enum ('funding', 'repayment');
exception when duplicate_object then null; end $$;

create table if not exists public.interregion_transactions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  lender_branch_id   uuid not null references public.branches(id),
  borrower_branch_id uuid not null references public.branches(id),
  txn_type         public.interregion_txn_type not null,
  amount           numeric(16,2) not null check (amount > 0),
  txn_date         date not null default current_date,
  -- D2: internal markup, defaulted off; policy can switch it on.
  markup_pct       numeric(6,3) not null default 0,
  -- Optional settlement rule (spec §7): auto-deduct from the borrower's future
  -- collection entitlement until cleared.
  auto_settle_from_collections boolean not null default false,
  approval_request_id uuid references public.approval_requests(id),
  notes            text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  constraint different_parties check (lender_branch_id <> borrower_branch_id)
);

create index if not exists idx_irt_company on public.interregion_transactions(company_id, txn_date);
create index if not exists idx_irt_pair on public.interregion_transactions(lender_branch_id, borrower_branch_id);

drop trigger if exists trg_aaa_irt_fill_company on public.interregion_transactions;
create trigger trg_aaa_irt_fill_company
  before insert on public.interregion_transactions
  for each row execute function public.fill_company_id();

alter table public.interregion_transactions enable row level security;
drop policy if exists "ssa_all" on public.interregion_transactions;
create policy "ssa_all" on public.interregion_transactions for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.interregion_transactions;
create policy "company_members" on public.interregion_transactions for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Post the double entry. Funding: lender gains a receivable, borrower a
-- payable. Repayment reverses the direction. Region-tagged to each party so a
-- regional balance sheet shows what it is owed / owes.
create or replace function public.journal_on_interregion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_recv uuid; v_pay uuid;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'interregion_transactions', old.id, old.txn_date);
    return old;
  end if;

  if new.txn_type = 'funding' then
    -- lender: DR receivable (tagged lender) ; borrower: CR payable (tagged borrower)
    perform public.post_journal(
      new.company_id, new.txn_date,
      'Inter-region funding',
      'interregion_transactions', new.id, false,
      jsonb_build_array(
        jsonb_build_object('key','interregion_receivable','debit',new.amount,'credit',0,'region',new.lender_branch_id),
        jsonb_build_object('key','interregion_payable','debit',0,'credit',new.amount,'region',new.borrower_branch_id)),
      new.lender_branch_id);
  else
    -- repayment: borrower clears payable (DR payable), lender clears receivable (CR receivable)
    perform public.post_journal(
      new.company_id, new.txn_date,
      'Inter-region repayment',
      'interregion_transactions', new.id, false,
      jsonb_build_array(
        jsonb_build_object('key','interregion_payable','debit',new.amount,'credit',0,'region',new.borrower_branch_id),
        jsonb_build_object('key','interregion_receivable','debit',0,'credit',new.amount,'region',new.lender_branch_id)),
      new.borrower_branch_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_yyy_interregion_journal on public.interregion_transactions;
create trigger trg_yyy_interregion_journal
  after insert or delete on public.interregion_transactions
  for each row execute function public.journal_on_interregion();

-- Fund a region. Requires an approved inter-region-funding request (COO gate,
-- §2). Records the transaction, which posts the journal via the trigger.
create or replace function public.fund_region(
  p_company_id uuid, p_lender uuid, p_borrower uuid, p_amount numeric,
  p_approval_request_id uuid, p_auto_settle boolean default false, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_action_approved('interregion_transactions', p_approval_request_id, 'interregion_funding')
     and not exists (select 1 from public.approval_requests
                      where id = p_approval_request_id and action_key = 'interregion_funding'
                        and status in ('approved','auto_approved')) then
    raise exception 'inter-region funding requires an approved request (COO sign-off)'
      using errcode = '42501';
  end if;

  insert into public.interregion_transactions
    (company_id, lender_branch_id, borrower_branch_id, txn_type, amount,
     auto_settle_from_collections, approval_request_id, notes, created_by)
  values
    (p_company_id, p_lender, p_borrower, 'funding', p_amount, p_auto_settle,
     p_approval_request_id, p_notes, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Running statement per pair, directional net balance. Positive = the "a" side
-- is a net lender to the "b" side.
create or replace view public.interregion_balances
  with (security_invoker = true) as
  select t.company_id,
         least(t.lender_branch_id, t.borrower_branch_id)    as region_a,
         greatest(t.lender_branch_id, t.borrower_branch_id) as region_b,
         sum(case
               when t.txn_type = 'funding' and t.lender_branch_id < t.borrower_branch_id then  t.amount
               when t.txn_type = 'funding' and t.lender_branch_id > t.borrower_branch_id then -t.amount
               when t.txn_type = 'repayment' and t.borrower_branch_id < t.lender_branch_id then  t.amount
               else -t.amount
             end) as net_a_owed_by_b
    from public.interregion_transactions t
   group by t.company_id, least(t.lender_branch_id, t.borrower_branch_id),
            greatest(t.lender_branch_id, t.borrower_branch_id);

-- Net position per region (owed to it minus what it owes). Consolidates to
-- zero across a company by construction.
create or replace function public.interregion_net_position(p_company_id uuid, p_branch_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(
    case
      when txn_type = 'funding'   and lender_branch_id   = p_branch_id then  amount
      when txn_type = 'funding'   and borrower_branch_id = p_branch_id then -amount
      when txn_type = 'repayment' and lender_branch_id   = p_branch_id then -amount
      when txn_type = 'repayment' and borrower_branch_id = p_branch_id then  amount
      else 0
    end), 0)
  from public.interregion_transactions
  where company_id = p_company_id;
$$;
