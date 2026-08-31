-- 0269 — G3. The cheque lifecycle: keyed to STATE, posted at issuance,
-- with an Unpresented Cheques liability and a backfill that is the same code
-- path as the trigger.
--
-- WHY, IN ONE PARAGRAPH
--
-- journal_on_cheque posted on the `pending -> cleared` TRANSITION. Two cheques
-- (5,000 each) cleared on 2026-08-28 before 0221 was applied; their transition
-- was spent before the rule existed, nothing has updated them since, and they
-- will never post. A rule keyed to an observed change cannot repair a row whose
-- change already happened. Every posting rule in this file is therefore keyed to
-- the row's CURRENT STATE: it computes what the state requires, compares that to
-- what is posted, and reconciles the difference. Run it once or a hundred times,
-- on a fresh row or a five-year-old one, and the answer is the same.
--
-- THE BACKFILL RULE (new standing rule, docs/LEDGER_MASTER_FINDINGS.md §9.6)
--
--   Any migration installing a posting rule must state its backfill, or state
--   why none is needed.
--
-- 0221 stated neither. It escaped consequence on seven of eight source tables
-- only because those tables had no qualifying rows yet — an accident of the
-- sandbox timeline, not a property of the design. This migration enforces the
-- rule two ways: the backfill below is a loop over sync_cheque_journal(), the
-- very function the trigger calls, so a backfill cannot drift from the rule it
-- backfills; and `every_source_row_posted` joins ledger_checks so that the next
-- unbackfilled rule is red the day it ships rather than found by looking.
--
-- THE MODEL
--
--   Payment cheque, issued   the ITEM posts   Dr expense / AP / salaries payable
--                                             Cr Unpresented Cheques      (2150)
--   Payment cheque, cleared  the CHEQUE posts Dr Unpresented Cheques
--                                             Cr Bank <this account>
--   Cash cheque, cleared     the CHEQUE posts Dr Cash — <custodian>
--                                             Cr Bank <this account>
--   Bounced / cancelled / reverted to pending: the entry is reversed.
--
-- WHERE THIS DEPARTS FROM THE BRIEF, AND WHY — stated rather than quietly done.
--
-- The brief says post at issuance for every cheque. That is implemented for
-- PAYMENT cheques, through the item, which is where the debit actually lives. A
-- CASH cheque posts nothing at issuance, because at issuance nothing has been
-- exchanged: the custodian does not hold the money until the cheque is drawn,
-- and `treasury.cash_balance` agrees — it rises at clearing, not at issue.
-- Posting Dr Cash / Cr Unpresented Cheques at issuance would make
-- custodian_held_operational() red for every pending cash cheque, which is a
-- check going red because the ledger asserts something the world does not.
--
-- The alternative — a Cash in Transit asset debited at issue and relieved at
-- clearing — is a coherent treatment and it is NOT adopted here, because
-- choosing it is accounting policy and policy is not mine to invent
-- (CLAUDE.md). RAISED, NOT RESOLVED: should an outgoing cash cheque recognise
-- an in-transit asset between issue and clearing?
--
-- CONSEQUENCE, STATED SO IT IS NOT DISCOVERED LATER: `bank_accounts.balance`
-- falls when the cheque is WRITTEN (cheque_apply_balance, on INSERT), and the
-- GL bank falls when it CLEARS. Between those two moments they differ by the
-- outstanding amount. That is not a defect — it is the classic bank
-- reconciliation item, and 0271's per-account check treats it as one by name
-- rather than tolerating an unexplained gap.
--
-- INCOMING cheques are untouched. An incoming cheque creates its
-- invoice_payments row at clearing (cheque_apply_balance), and that row posts
-- itself through journal_on_invoice_payment. Posting the cheque as well would
-- double count. sync_cheque_journal() reverses anything an incoming cheque has,
-- so the rule holds in both directions rather than merely returning early.

-- ---------------------------------------------------------------------------
-- 1. The account. Code 2150 is free: 2100 Salaries Payable, 2200 WHT Payable.
--    Pattern follows ensure_bad_debt_account (0236) deliberately —
--    seed_chart_of_accounts() is a 70-line literal list and is not rewritten to
--    add one row.
-- ---------------------------------------------------------------------------

create or replace function public.ensure_unpresented_cheques_account(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  select id into v_id from public.chart_of_accounts
   where company_id = p_company_id and system_key = 'unpresented_cheques'
   limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side,
     system_key, active, system_account, is_control)
  values
    (p_company_id, '2150', 'Unpresented Cheques', 'liability', 'credit',
     'unpresented_cheques', true, true, false)
  returning id into v_id;

  return v_id;
end;
$function$;

comment on function public.ensure_unpresented_cheques_account(uuid) is
  'Liability for outgoing cheques written but not yet cleared. Credited by the item the cheque pays, debited when the cheque clears.';

do $$
declare r record;
begin
  for r in select id from public.companies loop
    perform public.ensure_unpresented_cheques_account(r.id);
  end loop;
end $$;

create or replace function public.auto_unpresented_cheques_account_on_company_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.ensure_unpresented_cheques_account(new.id);
  return new;
end;
$function$;

drop trigger if exists trg_unpresented_cheques_account on public.companies;
create trigger trg_unpresented_cheques_account
  after insert on public.companies
  for each row execute function public.auto_unpresented_cheques_account_on_company_insert();

-- ---------------------------------------------------------------------------
-- 2. Resolve the GL account for a NAMED bank account, not the bank control.
--
--    Every bank sub-account in the sandbox holds exactly its opening balance
--    and nothing else: all bank postings land on the undifferentiated control.
--    That is the same misrouting G2 closed on the cash side, and the subtree
--    check cannot see it because parent/child misrouting cancels inside the
--    subtree. Cheque clearing is the first path to route to the named account;
--    0271 measures the rest.
-- ---------------------------------------------------------------------------

create or replace function public.bank_account_gl(p_company_id uuid, p_bank_account_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    (select cl.coa_account_id from public.cash_locations cl
      where cl.company_id = p_company_id and cl.bank_account_id = p_bank_account_id
        and cl.coa_account_id is not null limit 1),
    public.coa_id(p_company_id, 'bank'));
$function$;

comment on function public.bank_account_gl(uuid, uuid) is
  'GL account for one named bank account (its BANK-type cash_location sub-account), falling back to the bank control when no sub-account exists.';

-- ---------------------------------------------------------------------------
-- 3. The lifecycle itself. ONE function, called by the trigger AND by the
--    backfill, so the two cannot disagree.
--
--    It does not ask "what changed". It asks "what should be posted for this
--    row as it stands", compares that to what IS posted, and acts only on a
--    difference. Idempotent by construction: calling it twice in a row posts
--    nothing the second time, which is what makes it safe as a backfill.
-- ---------------------------------------------------------------------------

create or replace function public.sync_cheque_journal(p_cheque_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ch        record;
  v_want    boolean;
  v_date    date;
  v_dr      uuid;
  v_cr      uuid;
  v_branch  uuid;
  v_desc    text;
  v_live    record;
  v_have    boolean := false;
begin
  select * into ch from public.cheques where id = p_cheque_id;
  if not found then return 'no such cheque'; end if;

  -- What the CURRENT state requires. No reference to any previous state.
  if ch.direction <> 'outgoing' then
    v_want := false;                       -- posts via invoice_payments instead
  else
    v_want := (ch.status = 'cleared');     -- issuance is the item's entry, not the cheque's
  end if;

  v_date := coalesce(ch.cleared_at::date, ch.cheque_date);
  v_cr   := public.bank_account_gl(ch.company_id, ch.bank_account_id);

  if ch.cheque_type = 'cash' then
    select cl.coa_account_id, cl.branch_id into v_dr, v_branch
      from public.cash_locations cl where cl.id = ch.custodian_location_id;
    if v_dr is null then
      v_dr := public.cash_account_for(ch.company_id, ch.custodian_location_id);
    end if;
    v_desc := 'Cash cheque #' || coalesce(ch.cheque_number, '') || ' cleared to custodian';
  else
    v_dr := public.ensure_unpresented_cheques_account(ch.company_id);
    v_desc := 'Payment cheque #' || coalesce(ch.cheque_number, '') || ' cleared';
  end if;

  if v_dr is null or v_cr is null then
    v_want := false;                       -- unresolvable account: post nothing rather than half an entry
  end if;

  -- What IS posted: the live (un-reversed) entry for this cheque, reduced to
  -- the four facts that decide whether it still describes the row.
  select je.entry_date as entry_date,
         -- max() has no uuid form; text is a faithful ordering for equality use
         max(case when jl.debit  > 0 then jl.account_id::text end)::uuid as dr,
         max(case when jl.credit > 0 then jl.account_id::text end)::uuid as cr,
         sum(jl.debit) as amount
    into v_live
    from public.journal_entries je
    join public.journal_lines jl on jl.journal_entry_id = je.id
   where je.company_id = ch.company_id
     and je.source_table = 'cheques' and je.source_id = ch.id
     and je.is_reversal = false
     and not exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id)
   group by je.id, je.entry_date;
  v_have := found;

  if v_want and v_have
     and v_live.entry_date = v_date and v_live.dr = v_dr
     and v_live.cr = v_cr and v_live.amount = ch.amount then
    return 'unchanged';
  end if;

  if v_have then
    perform public.reverse_journal_for_source(ch.company_id, 'cheques', ch.id, v_live.entry_date);
  end if;

  if not v_want then
    return case when v_have then 'reversed' else 'nothing to post' end;
  end if;

  perform public.post_journal(
    ch.company_id, v_date, v_desc, 'cheques', ch.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_dr, 'debit', ch.amount, 'credit', 0),
      jsonb_build_object('account_id', v_cr, 'debit', 0,         'credit', ch.amount)),
    coalesce(v_branch, ch.branch_id));

  return case when v_have then 'reposted' else 'posted' end;
end;
$function$;

comment on function public.sync_cheque_journal(uuid) is
  'Reconciles one cheque''s journal entry to its CURRENT state. Idempotent. Called by trg_yyy_cheques_journal and by every backfill — trigger and backfill are the same code by construction.';

create or replace function public.journal_on_cheque()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(
      old.company_id, 'cheques', old.id, coalesce(old.cleared_at::date, old.cheque_date));
    return old;
  end if;
  perform public.sync_cheque_journal(new.id);
  return new;
end;
$function$;

-- INSERT joins the trigger. Without it a row created already-cleared — which is
-- exactly how a backdated cheque is entered — never posts at all.
drop trigger if exists trg_yyy_cheques_journal on public.cheques;
create trigger trg_yyy_cheques_journal
  after insert or update or delete on public.cheques
  for each row execute function public.journal_on_cheque();

-- ---------------------------------------------------------------------------
-- 4. Supersede "payment cheques post nothing". Four call sites credited `bank`
--    for a cheque payment, i.e. treated a written cheque as money already gone
--    from the bank. They now credit the liability, which the cheque relieves
--    when it clears.
--
--    AFFECTED CALL SITES, all four reported:
--      journal_on_expense           payment_mode in ('Bank','Cheque') -> bank
--      journal_on_advance           else-branch                       -> bank
--      journal_on_fixed_asset       payment_mode in ('Bank','Cheque') -> bank
--      post_payslip_disbursement    else-branch                       -> bank
--
--    NOT changed, and why:
--      journal_on_invoice_payment    an INCOMING cheque's invoice_payments row
--                                    is created BY cheque_apply_balance at
--                                    clearing, so Dr bank is already correct.
--      journal_on_expense_settlement paid_via has no 'Cheque' value.
--
--    post_payslip_disbursement additionally dated cheque payments to the
--    CLEARING date — a second, incompatible answer to the same problem (defer
--    the whole posting rather than route it through a liability). That is
--    superseded: the disbursement posts at disbursed_at like every other mode,
--    and the cheque moves it to bank when it clears.
--
--    FORWARD ONLY, and this was checked rather than assumed: there are ZERO
--    rows with payment_mode = 'Cheque' in expenses, advances, payslips,
--    fixed_assets or invoice_payments across the whole database. Nothing needs
--    reposting. Had that not been true this migration would carry the repost,
--    per its own backfill rule.
-- ---------------------------------------------------------------------------

create or replace function public.cheque_or_bank_key(p_payment_mode text)
returns text
language sql
immutable
as $function$
  select case when p_payment_mode = 'Cheque' then 'unpresented_cheques' else 'bank' end;
$function$;

comment on function public.cheque_or_bank_key(text) is
  'Credit key for an outgoing settlement: a cheque is a liability until it clears, anything else leaves the bank at once. One place, so the four posting functions cannot drift apart.';

create or replace function public.journal_on_expense()
returns trigger
language plpgsql
as $function$
declare
  v_exp_key  text;
  v_cr_line  jsonb;
  v_cat_name text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'expenses', old.id, old.expense_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.payment_mode is distinct from new.payment_mode
       or old.category_id is distinct from new.category_id
       or old.branch_id is distinct from new.branch_id
       or old.custodian_location_id is distinct from new.custodian_location_id
       or old.expense_date is distinct from new.expense_date then   -- 0258
      perform public.reverse_journal_for_source(new.company_id, 'expenses', new.id, old.expense_date);
    else
      return new;
    end if;
  end if;

  select name into v_cat_name from public.expense_categories where id = new.category_id;
  v_exp_key := public.map_expense_to_coa_key(coalesce(v_cat_name, ''), new.pl_category::text, new.client_id);

  v_cr_line := case
    when new.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.custodian_location_id),
      'debit', 0, 'credit', new.amount)
    when new.payment_mode in ('Bank', 'Cheque') then jsonb_build_object(
      'key', public.cheque_or_bank_key(new.payment_mode), 'debit', 0, 'credit', new.amount)
    else jsonb_build_object('key', 'ap', 'debit', 0, 'credit', new.amount)
  end;

  perform public.post_journal(
    new.company_id, new.expense_date,
    coalesce(v_cat_name, 'Expense') || coalesce(' — ' || new.description, ''),
    'expenses', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', v_exp_key, 'debit', new.amount, 'credit', 0)
    ) || jsonb_build_array(v_cr_line),
    new.branch_id
  );
  return new;
end;
$function$;

create or replace function public.journal_on_advance()
returns trigger
language plpgsql
as $function$
declare v_cr_line jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'advances', old.id, old.advance_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- Every field the posting below reads. See 0256 before shortening this.
    if old.amount           is distinct from new.amount
       or old.branch_id        is distinct from new.branch_id
       or old.custodian_location_id is distinct from new.custodian_location_id
       or old.payment_mode     is distinct from new.payment_mode
       or old.advance_date     is distinct from new.advance_date
       or old.employee_id      is distinct from new.employee_id
       or old.client_id        is distinct from new.client_id then
      perform public.reverse_journal_for_source(new.company_id, 'advances', new.id, old.advance_date);
    else
      return new;
    end if;
  end if;

  v_cr_line := case
    when new.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.custodian_location_id),
      'debit', 0, 'credit', new.amount)
    else jsonb_build_object('key', public.cheque_or_bank_key(new.payment_mode),
                            'debit', 0, 'credit', new.amount)
  end;

  perform public.post_journal(
    new.company_id, new.advance_date,
    'Employee advance',
    'advances', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'employee_advances_receivable',
                         'debit', new.amount, 'credit', 0,
                         'employee_id', new.employee_id,
                         'client_id', new.client_id)
    ) || jsonb_build_array(v_cr_line),
    new.branch_id
  );
  return new;
end;
$function$;

create or replace function public.journal_on_fixed_asset()
returns trigger
language plpgsql
as $function$
declare v_cr_key text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'fixed_assets', old.id, old.acquisition_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.cost is distinct from new.cost
       or old.category is distinct from new.category
       or old.payment_mode is distinct from new.payment_mode
       or old.branch_id is distinct from new.branch_id
       or old.acquisition_date is distinct from new.acquisition_date then   -- 0258
      perform public.reverse_journal_for_source(new.company_id, 'fixed_assets', new.id, old.acquisition_date);
    else
      return new;
    end if;
  end if;

  v_cr_key := case
    when new.payment_mode = 'Cash' then 'cash'
    when new.payment_mode in ('Bank', 'Cheque') then public.cheque_or_bank_key(new.payment_mode)
    else 'ap'
  end;

  perform public.post_journal(
    new.company_id, new.acquisition_date,
    'Asset purchase — ' || new.name,
    'fixed_assets', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', public.fa_coa_key(new.category), 'debit', new.cost, 'credit', 0),
      jsonb_build_object('key', v_cr_key,                        'debit', 0,        'credit', new.cost)
    ),
    new.branch_id
  );
  return new;
end;
$function$;

create or replace function public.post_payslip_disbursement(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ps       record;
  v_client uuid;
  v_date   date;
  v_cr     jsonb;
  v_dim    jsonb;
begin
  -- tenant guard [resolved]: owning company looked up from p_id via public.payslips (0242)
  if p_id is not null then perform public.assert_same_company((select company_id from public.payslips where id = p_id)); end if;

  select * into ps from public.payslips where id = p_id;
  if not found or not ps.disbursed or coalesce(ps.net_salary, 0) = 0 then return; end if;

  select e.client_id into v_client from public.employees e where e.id = ps.employee_id;
  v_dim := jsonb_build_object('employee_id', ps.employee_id, 'client_id', v_client);

  -- 0269: a cheque disbursement posts on the SAME date as every other mode and
  -- routes through Unpresented Cheques. It previously deferred the whole entry
  -- to the clearing date, which was a second and incompatible answer to the
  -- question this liability now answers, and which left a disbursed payslip
  -- with no entry at all for as long as the cheque stayed pending.
  v_date := coalesce(ps.disbursed_at::date, ps.period_month);

  v_cr := case
    when ps.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(ps.company_id, ps.custodian_location_id),
      'debit', 0, 'credit', ps.net_salary)
    else jsonb_build_object('key', public.cheque_or_bank_key(ps.payment_mode),
                            'debit', 0, 'credit', ps.net_salary)
  end;

  perform public.post_journal(
    ps.company_id, v_date,
    'Payroll disbursed — ' || left(ps.period_month::text, 7),
    'payslips_disbursement', ps.id, false,
    jsonb_build_array(
      v_dim || jsonb_build_object('key', 'salaries_payable', 'debit', ps.net_salary, 'credit', 0)
    ) || jsonb_build_array(v_dim || v_cr),
    ps.branch_id);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. T16 FLIP, BY NAME. Clearing is now a CURRENT-period event — it posts at
--    cleared_at, not at cheque_date — so `status` and `cleared_at` join the
--    cheques carve-out. Before 0269, permitting them would have moved a posting
--    into a closed month and left the journal lock to refuse it, which is the
--    wrong-lock pathology. That is no longer the case.
--
--    supabase/tests/period_lock.sql T16 is inverted in the same change, so the
--    test is turned deliberately rather than discovered to have started failing.
--
--    The list is edited PROGRAMMATICALLY rather than by retyping 90 lines of
--    enforce_period_lock, for the reason 0264 gives: retyping a body to change
--    one literal is how a body silently loses a line.
-- ---------------------------------------------------------------------------

do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enforce_period_lock';

  if v_def is null or v_def !~ 'c_cheque_open' then
    raise exception '0269: enforce_period_lock has no c_cheque_open list to extend';
  end if;

  if position('''cleared_at''' in v_def) > 0 then
    raise notice '0269: cheque carve-out already extended; leaving as is';
    return;
  end if;

  v_new := replace(v_def,
    '  c_cheque_open constant text[] := array[' || chr(10) || '    ''notes'', ''updated_at'',',
    '  -- 0269: status/cleared_at ADDED. Clearing posts at cleared_at, in the' || chr(10) ||
    '  -- open month, so the carve-out no longer admits a posting to a closed one.' || chr(10) ||
    '  c_cheque_open constant text[] := array[' || chr(10) ||
    '    ''notes'', ''updated_at'', ''status'', ''cleared_at'',');

  if v_new = v_def then
    raise exception '0269: could not locate the c_cheque_open literal to extend';
  end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- 6. THE BACKFILL. The same function the trigger calls, over every cheque that
--    has ever existed. This is what 0221 owed and did not pay.
-- ---------------------------------------------------------------------------

do $$
declare r record; v_res text; v_posted int := 0; v_other int := 0;
begin
  for r in select id, cheque_number, amount from public.cheques loop
    v_res := public.sync_cheque_journal(r.id);
    if v_res in ('posted', 'reposted') then
      v_posted := v_posted + 1;
      raise notice '0269 backfill: cheque % (%) -> %', r.cheque_number, r.amount, v_res;
    else
      v_other := v_other + 1;
    end if;
  end loop;
  raise notice '0269 backfill: % posted/reposted, % unchanged or not applicable', v_posted, v_other;
end $$;

-- ---------------------------------------------------------------------------
-- 7. THE CHECK THAT STOPS THE NEXT UNBACKFILLED RULE.
--
--    Every source row a posting rule covers must have a live journal entry. Red
--    means either a rule shipped without its backfill, or a rule silently
--    declined to post. Both are the defect this migration exists for.
--
--    The eight tables are named explicitly rather than derived, because a
--    derived list would quietly shrink if a source_table string changed, and the
--    check would then go green by forgetting.
-- ---------------------------------------------------------------------------

create or replace function public.unposted_source_rows(p_company_id uuid)
returns table(src_table text, src_id uuid, amount numeric, dated date)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with src as (
    select 'cheques'::text t, c.id, c.amount, c.cheque_date d
      from public.cheques c
     where c.company_id = p_company_id and c.direction = 'outgoing' and c.status = 'cleared'
    union all
    select 'expenses', e.id, e.amount, e.expense_date from public.expenses e where e.company_id = p_company_id
    union all
    select 'invoice_payments', p.id, p.amount, p.payment_date from public.invoice_payments p where p.company_id = p_company_id
    union all
    select 'advances', a.id, a.amount, a.advance_date from public.advances a where a.company_id = p_company_id
    union all
    select 'invoices', i.id, i.invoice_amount, i.invoice_date from public.invoices i where i.company_id = p_company_id
    union all
    select 'custody_transfers', t.id, t.amount, t."date" from public.custody_transfers t where t.company_id = p_company_id
    union all
    select 'partner_account_entries', pe.id, pe.amount, pe."date" from public.partner_account_entries pe where pe.company_id = p_company_id
    union all
    select 'cash_deposits', cd.id, cd.amount, cd.deposit_date from public.cash_deposits cd where cd.company_id = p_company_id
  )
  select s.t, s.id, s.amount, s.d
    from src s
   where not exists (
     select 1 from public.journal_entries je
      where je.company_id = p_company_id
        and je.source_table = s.t and je.source_id = s.id
        and je.is_reversal = false
        and not exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id))
   order by s.d, s.t;
$function$;

comment on function public.unposted_source_rows(uuid) is
  'Source rows a posting rule covers that have no live journal entry. Non-empty means a rule shipped without a backfill, or declined to post. See 0269 section 7.';

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric,
              difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with real_checks as (
    select b.check_name, b.expected, b.actual, b.difference, b.passed
      from public.ledger_checks_base(p_company_id) b
     where b.check_name <> 'checks_evaluated'
    union all
    select 'cash_per_location_gl_equals_operational'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.custodian_held_operational(p_company_id) h
     where abs(h.difference) > 0.005
    union all
    select 'every_source_row_posted'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.unposted_source_rows(p_company_id)
  )
  select * from real_checks
  union all
  -- 14 = the number of REAL checks (0266's 13, plus every_source_row_posted).
  -- The function returns one more row than this — the canary itself. Bump the
  -- constant deliberately when adding a check; never to make this row green.
  select 'checks_evaluated'::text,
         14::numeric,
         (select count(*) from real_checks)::numeric,
         (select count(*) from real_checks)::numeric - 14,
         (select count(*) from real_checks) = 14;
$function$;

-- Prove the canary rather than trusting it: 14 real checks + the canary row,
-- and the canary must agree, on a real company.
do $$
declare v_n int; v_ok boolean;
begin
  select count(*) into v_n from public.ledger_checks(
    (select id from public.companies order by created_at limit 1));
  if v_n <> 15 then
    raise exception '0269: ledger_checks returns % rows, 15 expected (14 checks + canary)', v_n;
  end if;
  select passed into v_ok from public.ledger_checks(
    (select id from public.companies order by created_at limit 1))
   where check_name = 'checks_evaluated';
  if not coalesce(v_ok, false) then
    raise exception '0269: checks_evaluated is red after the bump';
  end if;
end $$;