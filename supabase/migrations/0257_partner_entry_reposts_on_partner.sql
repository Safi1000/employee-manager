-- 0257 — journal_on_partner_entry reposts when the entry changes partner.
--
-- NOT APPLIED TO PRODUCTION. Dev only.
--
-- THE DEFECT
--
-- The posting resolves the partner row and uses it twice:
--
--   select * into p from public.partners where id = new.partner_id;
--   v_capital := p.coa_account_id;                     -- WHICH capital account
--   v_region  := case when p.scope = 'BRANCH' then ... -- WHICH region
--
-- and the repost condition compared amount, type, payment_method,
-- cash_location_id and bank_account_id. `partner_id` — the input that selects
-- the account the money lands in — was not among them.
--
-- Reassigning an entry from one partner to another therefore left the equity
-- posting on the first partner's capital account. Measured on dev, open month,
-- rolled back:
--
--   PARTNER entry credited: 5fdf4919…   (= partner 1 capital)
--   reassigned to partner 2 (capital a6091960…)
--     credited now        : 5fdf4919…   <-- STILL PARTNER 1
--
-- This is not a stale figure. It is money attributed to the wrong person, in
-- the ledger F4 computes partner remuneration from, with no error raised and
-- nothing in the row to show for it. The entry says partner 2; the general
-- ledger says partner 1; both are internally consistent.
--
-- HAS IT HAPPENED: NO, AND THERE IS NOTHING IT COULD HAVE HAPPENED TO.
--
-- partner_account_entries is EMPTY on both environments — 0 rows on prod, 0 on
-- dev. Every derived figure is therefore 0.00:
--
--   entries total                    prod 0    dev 0
--   entries whose posting names a
--     different partner than the row  prod 0    dev 0
--   rupees misattributed             prod 0.00 dev 0.00
--   partners with no capital account  prod 0    dev 0
--
-- The intended check was the audit log, and it cannot answer this: THIS TABLE
-- HAS NO AUDIT TRIGGER. advances, cheques, expenses, invoices and payslips all
-- carry log_audit_change; partner_account_entries carries only fill_company_id
-- and the journal trigger. The table holding partner capital movements is the
-- one table in this group whose history is not recorded. That is reported here
-- and not fixed here — adding an audit trigger is its own change.
--
-- So the state check above is what was run instead, and it is the better
-- question anyway: not "was a partner_id ever edited" but "does any posting
-- disagree with the row it came from". Zero, on both.
--
-- The fix is prospective, and urgent for that reason: F4 is about to start
-- writing these rows.
--
-- WHAT IS NOT FIXED HERE
--
-- The posting also depends on three columns of the PARTNERS row — coa_account_id,
-- scope and branch_id — none of which live on the entry. Changing a partner's
-- capital account or moving them between scopes does not repost the entries
-- already posted against them. That is a cross-table staleness, a different
-- shape from this one, and it needs its own decision. Recorded in
-- docs/REPOST_SET_AUDIT.md.
--
-- `date` is deliberately absent from the condition below. It is one of the eight
-- date columns fixed as a class in 0258; splitting it out here would make this
-- migration look like it fixed the general defect when it fixes one instance.

create or replace function public.journal_on_partner_entry()
returns trigger
language plpgsql
as $function$
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
       or old.bank_account_id is distinct from new.bank_account_id
       -- 0257. Selects the capital account AND the region. Without it a
       -- reassignment left the equity on the previous partner permanently.
       or old.partner_id is distinct from new.partner_id then
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
$function$;

comment on function public.journal_on_partner_entry() is
  'Posts a partner capital movement. Reposts on partner_id (0257) because that column selects both the capital account and the region - without it, reassigning an entry left the equity on the previous partner permanently. Still does NOT repost when the PARTNERS row itself changes coa_account_id, scope or branch_id; see docs/REPOST_SET_AUDIT.md.';
