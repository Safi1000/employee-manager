-- 0272 — Bank-to-bank transfers reach the ledger.
--
-- THE DEFECT, AND WHY NOTHING CAUGHT IT
--
-- A bank-to-bank transfer is two `bank_transactions` rows sharing a
-- `transfer_pair_id`: one leg with a negative `account_delta` (source) and one
-- positive (destination). Both operational balances move. Nothing posts —
-- `bank_transactions` has no journal trigger and no posting function, and
-- `journal_entries` has never held a transfer source table.
--
-- It was invisible to every existing check by construction:
--
--   bank_control_equals_bank_accounts       both accounts are inside the bank
--                                           subtree, so the error nets to zero
--                                           within the aggregate
--   bank_accounts_equal_transaction_deltas  both legs ARE in the transaction
--                                           log, so the operational side
--                                           reconciles perfectly
--
-- An aggregate check cannot see an error that nets to zero inside its own
-- aggregate. 0271's per-account check is what surfaced it: `ss` at −990,000 and
-- Meezan 990,000 too high.
--
-- THE POSTING
--
--   Dr  Bank — <destination account>    amount
--   Cr  Bank — <source account>         amount
--
-- dated at the transfer, and routed to the NAMED sub-accounts via
-- bank_account_gl(). Posting to the bank control on both sides would be a
-- balanced entry that changes nothing and reports success — the failure mode
-- this whole series exists to stop.
--
-- Same rule as custody transfers, which have posted correctly since 0079.
--
-- STATE-KEYED, LIKE 0269. sync_bank_transfer_journal() computes what the pair
-- requires, compares it to the live entry on four facts, and acts only on a
-- difference. The trigger calls it; the backfill is a loop over it. A half
-- pair — one leg inserted, the other not yet — posts NOTHING and is not an
-- error: the state simply does not yet warrant an entry, and the second leg's
-- trigger call completes it.
--
-- BACKFILL: yes, below, over every complete pair. Stated per the standing rule
-- introduced by 0269.

create or replace function public.sync_bank_transfer_journal(p_pair_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_co      uuid;
  v_amount  numeric;
  v_date    date;
  v_src     uuid;
  v_dst     uuid;
  v_dr      uuid;
  v_cr      uuid;
  v_want    boolean := false;
  v_live    record;
  v_have    boolean := false;
begin
  -- The pair, as it currently stands. Exactly two legs, netting to zero, with
  -- one negative and one positive side — anything else is not a transfer this
  -- function knows how to post, and it says so by posting nothing.
  select bt.company_id,
         max(case when bt.account_delta < 0 then bt.bank_account_id::text end)::uuid,
         max(case when bt.account_delta > 0 then bt.bank_account_id::text end)::uuid,
         max(abs(bt.account_delta)),
         min(bt.created_at)::date,
         count(*) = 2 and sum(bt.account_delta) = 0
                     and count(*) filter (where bt.account_delta < 0) = 1
                     and count(*) filter (where bt.account_delta > 0) = 1
    into v_co, v_src, v_dst, v_amount, v_date, v_want
    from public.bank_transactions bt
   where bt.transfer_pair_id = p_pair_id and bt.kind = 'transfer'
   group by bt.company_id;

  if v_co is null then
    return 'no legs';
  end if;

  if coalesce(v_want, false) then
    v_dr := public.bank_account_gl(v_co, v_dst);
    v_cr := public.bank_account_gl(v_co, v_src);
    if v_dr is null or v_cr is null or v_dr = v_cr or coalesce(v_amount, 0) = 0 then
      -- Same account both sides, or an unresolvable one: an entry here would be
      -- balanced, meaningless and reported as a success.
      v_want := false;
    end if;
  end if;

  select je.entry_date as entry_date,
         max(case when jl.debit  > 0 then jl.account_id::text end)::uuid as dr,
         max(case when jl.credit > 0 then jl.account_id::text end)::uuid as cr,
         sum(jl.debit) as amount
    into v_live
    from public.journal_entries je
    join public.journal_lines jl on jl.journal_entry_id = je.id
   where je.company_id = v_co
     and je.source_table = 'bank_transfers' and je.source_id = p_pair_id
     and je.is_reversal = false
     and not exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id)
   group by je.id, je.entry_date;
  v_have := found;

  if v_want and v_have
     and v_live.entry_date = v_date and v_live.dr = v_dr
     and v_live.cr = v_cr and v_live.amount = v_amount then
    return 'unchanged';
  end if;

  if v_have then
    perform public.reverse_journal_for_source(v_co, 'bank_transfers', p_pair_id, v_live.entry_date);
  end if;

  if not v_want then
    return case when v_have then 'reversed' else 'nothing to post' end;
  end if;

  perform public.post_journal(
    v_co, v_date, 'Bank transfer', 'bank_transfers', p_pair_id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_dr, 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', v_cr, 'debit', 0,        'credit', v_amount)),
    null);

  return case when v_have then 'reposted' else 'posted' end;
end;
$function$;

comment on function public.sync_bank_transfer_journal(uuid) is
  'Reconciles one bank-to-bank transfer pair''s journal entry to the pair''s CURRENT state. Idempotent. Called by trg_yyy_bank_transactions_journal and by every backfill — trigger and backfill are the same code by construction.';

create or replace function public.journal_on_bank_transaction()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_pair uuid;
begin
  v_pair := case when tg_op = 'DELETE' then old.transfer_pair_id else new.transfer_pair_id end;
  if v_pair is null then
    return coalesce(new, old);
  end if;
  if coalesce(case when tg_op = 'DELETE' then old.kind else new.kind end, '') <> 'transfer' then
    return coalesce(new, old);
  end if;
  perform public.sync_bank_transfer_journal(v_pair);
  return coalesce(new, old);
end;
$function$;

drop trigger if exists trg_yyy_bank_transactions_journal on public.bank_transactions;
create trigger trg_yyy_bank_transactions_journal
  after insert or update or delete on public.bank_transactions
  for each row execute function public.journal_on_bank_transaction();

-- ---------------------------------------------------------------------------
-- The backfill, over every complete pair.
-- ---------------------------------------------------------------------------

do $$
declare r record; v_res text; v_posted int := 0; v_other int := 0;
begin
  for r in select distinct transfer_pair_id as p from public.bank_transactions
            where kind = 'transfer' and transfer_pair_id is not null loop
    v_res := public.sync_bank_transfer_journal(r.p);
    if v_res in ('posted', 'reposted') then
      v_posted := v_posted + 1;
      raise notice '0272 backfill: transfer pair % -> %', r.p, v_res;
    else
      v_other := v_other + 1;
      raise notice '0272 backfill: transfer pair % -> %', r.p, v_res;
    end if;
  end loop;
  raise notice '0272 backfill: % posted/reposted, % other', v_posted, v_other;
end $$;

-- ---------------------------------------------------------------------------
-- Bring transfers under every_source_row_posted, so the guard covers the rule.
-- A rule outside the check that guards rules is a rule with no guard.
--
-- The other eight branches are unchanged from 0269; only the ninth is new.
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
    union all
    -- 0272. A complete, balanced transfer pair is a movement and must post.
    select 'bank_transfers', bt.transfer_pair_id, max(abs(bt.account_delta)), min(bt.created_at)::date
      from public.bank_transactions bt
     where bt.company_id = p_company_id and bt.kind = 'transfer'
       and bt.transfer_pair_id is not null
     group by bt.transfer_pair_id
    having count(*) = 2 and sum(bt.account_delta) = 0
       and count(*) filter (where bt.account_delta < 0) = 1
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

-- Prove the backfill landed and the guard now covers transfers.
do $$
declare v_co uuid := (select id from public.companies where name = 'SANDBOX TESTING ORG');
        v_unposted int; v_entries int;
begin
  if v_co is null then return; end if;
  select count(*) into v_entries from public.journal_entries
   where company_id = v_co and source_table = 'bank_transfers' and not is_reversal;
  select count(*) into v_unposted from public.unposted_source_rows(v_co) u where u.src_table = 'bank_transfers';
  raise notice '0272: % transfer entries posted, % transfer pairs still unposted', v_entries, v_unposted;
  if v_unposted > 0 then
    raise exception '0272: % transfer pairs remain unposted after the backfill', v_unposted;
  end if;
end $$;