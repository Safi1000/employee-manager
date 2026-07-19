-- Partnership as equity (spec section 4.3).
--
--   Contribution      Dr Bank/Cash        Cr Partner Capital
--   Drawing           Dr Partner Capital  Cr Bank/Cash
--   Profit allocation Dr Retained Earnings Cr Partner Capital
--
-- partner_account_entries has 24 rows that post nothing to the journal: the
-- partner ledger is one of the "islands" section 4 names. Partner capital is
-- real equity and belongs on the balance sheet, not in a side table.
--
-- Each partner gets a capital account under the Owners Equity control, the
-- same sub-ledger shape cash locations use in 0079. Sum(partner capital) is
-- then a rollup of Owners Equity rather than a number only the Partners screen
-- knows.
--
-- Region: a BRANCH-scoped partner's postings carry that branch, so an RMD
-- partner's capital movements land in their region (spec §4.3: "RMD partners
-- allocate on BRANCH/REGION profit"). COMPANY-scoped partners post to head
-- office.

-- ---------------------------------------------------------------------------
-- 1. Opening Balance Equity — the cutover plug.
--
-- OPENING entries are a partner's capital as at cutover: they have no cash
-- movement behind them, so the debit side is the opening-balance plug that
-- §4.4's opening trial balance also posts against. When both the partner
-- openings and management's opening TB are loaded and consistent, this account
-- nets to zero. If it doesn't, the opening figures disagree with the partner
-- ledger — which is exactly the kind of thing this account exists to expose,
-- rather than silently absorbing it into retained earnings.
-- ---------------------------------------------------------------------------

insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side,
   system_key, system_account, active)
select c.id, '3200', 'Opening Balance Equity', 'equity', 'credit',
       'opening_balance_equity', true, true
  from public.companies c
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = 'opening_balance_equity'
 );

-- ---------------------------------------------------------------------------
-- 2. A capital account per partner, under the Owners Equity control.
-- ---------------------------------------------------------------------------

alter table public.partners
  add column if not exists coa_account_id uuid references public.chart_of_accounts(id);

create or replace function public.allocate_partner_capital_account(
  p_company_id uuid,
  p_name       text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_parent      uuid;
  v_parent_code text;
  v_code        text;
  v_seq         integer := 0;
  v_acct        uuid;
begin
  select id, account_code into v_parent, v_parent_code
    from public.chart_of_accounts
   where company_id = p_company_id and system_key = 'equity';

  if v_parent is null then return null; end if;

  loop
    v_seq := v_seq + 1;
    v_code := v_parent_code || '.' || lpad(v_seq::text, 2, '0');
    exit when not exists (
      select 1 from public.chart_of_accounts
       where company_id = p_company_id and account_code = v_code
    );
    if v_seq > 500 then
      raise exception 'could not allocate a partner capital code under %', v_parent_code;
    end if;
  end loop;

  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side,
     parent_id, system_account, active, notes)
  values
    (p_company_id, v_code, p_name || ' — Capital', 'equity', 'credit',
     v_parent, true, true, 'Partner capital sub-ledger')
  returning id into v_acct;

  return v_acct;
end;
$$;

create or replace function public.ensure_partner_capital_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.coa_account_id is null then
    new.coa_account_id := public.allocate_partner_capital_account(new.company_id, new.name);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ccc_partner_capital_account on public.partners;
create trigger trg_ccc_partner_capital_account
  before insert on public.partners
  for each row execute function public.ensure_partner_capital_account();

do $$
declare r record;
begin
  for r in select * from public.partners where coa_account_id is null loop
    update public.partners
       set coa_account_id = public.allocate_partner_capital_account(r.company_id, r.name)
     where id = r.id;
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 3. The posting itself.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_partner_entry()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  p          record;
  v_capital  uuid;
  v_region   uuid;
  v_cash     jsonb;
  v_lines    jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'partner_account_entries', old.id, old.date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.type is distinct from new.type
       or old.payment_method is distinct from new.payment_method
       or old.cash_location_id is distinct from new.cash_location_id
       or old.bank_account_id is distinct from new.bank_account_id then
      perform public.reverse_journal_for_source(new.company_id, 'partner_account_entries', new.id, old.date);
    else
      return new;
    end if;
  end if;

  select * into p from public.partners where id = new.partner_id;
  if not found or p.coa_account_id is null then
    return new;  -- no capital account to post to; leave the ledger untouched
  end if;

  v_capital := p.coa_account_id;

  -- A branch-scoped partner's equity movements belong to their region.
  v_region := case
    when p.scope = 'BRANCH' then coalesce(p.branch_id, public.head_office_region(new.company_id))
    else public.head_office_region(new.company_id)
  end;

  -- FUEL_CARD is a company-settled benefit, so the money still leaves the
  -- bank — it is a bank credit like any other non-cash settlement.
  v_cash := case
    when new.payment_method = 'CASH' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id))
    else jsonb_build_object('key', 'bank')
  end;

  v_lines := case new.type
    when 'CONTRIBUTION' then jsonb_build_array(
      v_cash    || jsonb_build_object('debit', new.amount, 'credit', 0),
      jsonb_build_object('account_id', v_capital, 'debit', 0, 'credit', new.amount))
    when 'DRAWING' then jsonb_build_array(
      jsonb_build_object('account_id', v_capital, 'debit', new.amount, 'credit', 0),
      v_cash    || jsonb_build_object('debit', 0, 'credit', new.amount))
    when 'PROFIT_ALLOCATION' then jsonb_build_array(
      jsonb_build_object('key', 'retained_earnings', 'debit', new.amount, 'credit', 0),
      jsonb_build_object('account_id', v_capital,    'debit', 0, 'credit', new.amount))
    when 'OPENING' then jsonb_build_array(
      jsonb_build_object('key', 'opening_balance_equity', 'debit', new.amount, 'credit', 0),
      jsonb_build_object('account_id', v_capital,         'debit', 0, 'credit', new.amount))
  end;

  if v_lines is null then
    return new;
  end if;

  perform public.post_journal(
    new.company_id, new.date,
    p.name || ' — ' || new.type || coalesce(' — ' || new.description, ''),
    'partner_account_entries', new.id, false,
    v_lines,
    v_region
  );
  return new;
end;
$$;

drop trigger if exists trg_yyy_partner_entries_journal on public.partner_account_entries;
create trigger trg_yyy_partner_entries_journal
  after insert or update or delete on public.partner_account_entries
  for each row execute function public.journal_on_partner_entry();

-- ---------------------------------------------------------------------------
-- 4. Bring the 24 existing partner entries onto the ledger.
--    They were never posted, so there is nothing to reverse — this is a
--    first posting, not a restatement.
-- ---------------------------------------------------------------------------

do $$
declare
  e         record;
  p         record;
  v_region  uuid;
  v_cash    jsonb;
  v_lines   jsonb;
begin
  for e in
    select pae.* from public.partner_account_entries pae
     where not exists (
       select 1 from public.journal_entries je
        where je.source_table = 'partner_account_entries' and je.source_id = pae.id
     )
     order by pae.date
  loop
    select * into p from public.partners where id = e.partner_id;
    continue when p.coa_account_id is null;

    v_region := case
      when p.scope = 'BRANCH' then coalesce(p.branch_id, public.head_office_region(e.company_id))
      else public.head_office_region(e.company_id)
    end;

    v_cash := case
      when e.payment_method = 'CASH' then jsonb_build_object(
        'account_id', public.cash_account_for(e.company_id, e.cash_location_id))
      else jsonb_build_object('key', 'bank')
    end;

    v_lines := case e.type
      when 'CONTRIBUTION' then jsonb_build_array(
        v_cash || jsonb_build_object('debit', e.amount, 'credit', 0),
        jsonb_build_object('account_id', p.coa_account_id, 'debit', 0, 'credit', e.amount))
      when 'DRAWING' then jsonb_build_array(
        jsonb_build_object('account_id', p.coa_account_id, 'debit', e.amount, 'credit', 0),
        v_cash || jsonb_build_object('debit', 0, 'credit', e.amount))
      when 'PROFIT_ALLOCATION' then jsonb_build_array(
        jsonb_build_object('key', 'retained_earnings',  'debit', e.amount, 'credit', 0),
        jsonb_build_object('account_id', p.coa_account_id, 'debit', 0, 'credit', e.amount))
      when 'OPENING' then jsonb_build_array(
        jsonb_build_object('key', 'opening_balance_equity', 'debit', e.amount, 'credit', 0),
        jsonb_build_object('account_id', p.coa_account_id,  'debit', 0, 'credit', e.amount))
    end;

    continue when v_lines is null;

    perform public.post_journal(
      e.company_id, e.date,
      p.name || ' — ' || e.type || coalesce(' — ' || e.description, ''),
      'partner_account_entries', e.id, false,
      v_lines,
      v_region
    );
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 5. Partner capital straight off the ledger.
-- ---------------------------------------------------------------------------

create or replace view public.partner_capital_balances
  with (security_invoker = true) as
  select p.id as partner_id,
         p.company_id,
         p.name,
         p.scope,
         p.branch_id,
         b.name as region_name,
         p.coa_account_id,
         -- Equity is credit-normal, so a positive balance is credits over debits.
         coalesce(sum(jl.credit - jl.debit), 0) as capital_balance
    from public.partners p
    left join public.branches b on b.id = p.branch_id
    left join public.journal_lines jl on jl.account_id = p.coa_account_id
   group by p.id, p.company_id, p.name, p.scope, p.branch_id, b.name, p.coa_account_id;
