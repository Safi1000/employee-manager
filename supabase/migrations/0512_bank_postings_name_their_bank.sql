-- 0512 — A bank posting names its bank. The control account takes nothing.
--
-- Reported 2026-10-09: PKR 678,784 withdrawn from Askari to a custodian. The
-- custodian's cash went up; Askari, on Treasury, did not go down.
--
-- bank_accounts.balance DID move (1,054,275 → 375,491). The journal did not:
-- record_bank_to_custodian credited {'key':'bank'}, which resolves to 1010
-- "Bank Accounts" — the CONTROL — not 1010.02 "Askari Bank". Treasury reads
-- cash_location_balances, which sums journal lines on each bank's own account,
-- so Askari's line never saw the withdrawal. Nothing raised; the entry
-- balanced; the defect looked like success.
--
-- Same shape, written by hand in four more places, all of which have a bank id
-- in hand and threw it away:
--   journal_on_cash_deposit        (cash_deposits.bank_account_id)
--   journal_on_expense_settlement  (expenses.paid_bank_account_id)
--   journal_on_partner_entry       (partner_account_entries.bank_account_id)
--   record_inventory_purchase      (p_bank_account_id / p_custodian_location_id)
-- Seven live entries had landed on 1010 since 2026-09-02.
--
-- What this does:
--   1. Surgery on those five bodies (live definition, anchor asserted once):
--      resolve the bank's own account through bank_account_gl(), and the
--      custodian's through cash_account_for().
--   2. Reclass the seven entries: Dr/Cr 1010 against the right bank account,
--      posted under the ORIGINAL source_table/source_id so that a later
--      reverse_journal_for_source reverses the reclass together with the
--      original and leaves both accounts whole.
--   3. The permanent part — a BEFORE INSERT guard on journal_lines that refuses
--      a line on a control account that has sub-accounts (1010 bank, 1000
--      cash). The next function that forgets to name its bank raises instead of
--      posting to an account no screen reads.
--
-- Exempt from the guard:
--   • reversals — they mirror the original's lines verbatim, and the seven
--     historical entries above must stay reversible;
--   • maintenance sessions, as for enforce_journal_immutable.
--   • DEFERRED: 'reserve_funding' (fund_reserve), 'bonus_reserve_funding'
--     (accrue_bonus_reserve) and 'fixed_assets_disposal' (dispose_fixed_asset).
--     None takes a bank or custodian argument, so none can name one; none has
--     ever posted. If they are to post to a specific bank, the change is: add
--     p_bank_account_id (and p_custodian_location_id for disposal in Cash),
--     resolve through bank_account_gl()/cash_account_for(), then drop the
--     source from v_exempt below.

-- 1. Surgery ---------------------------------------------------------------
do $$
declare
  r record; v_def text; v_hits int;
begin
  for r in select * from (values
    ('public.record_bank_to_custodian(uuid,uuid,numeric,date,text)',
     $a$jsonb_build_object('key',        'bank',  'debit', 0,        'credit', p_amount)$a$,
     $b$jsonb_build_object('account_id', public.bank_account_gl(v_company, p_bank_account_id), 'debit', 0, 'credit', p_amount)$b$),
    ('public.journal_on_cash_deposit()',
     $a$jsonb_build_object('key', 'bank', 'debit', new.amount, 'credit', 0)$a$,
     $b$jsonb_build_object('account_id', public.bank_account_gl(new.company_id, new.bank_account_id), 'debit', new.amount, 'credit', 0)$b$),
    ('public.journal_on_expense_settlement()',
     $a$else jsonb_build_object('key', 'bank', 'debit', 0, 'credit', new.amount)$a$,
     $b$else jsonb_build_object('account_id', public.bank_account_gl(new.company_id, new.paid_bank_account_id), 'debit', 0, 'credit', new.amount)$b$),
    ('public.journal_on_partner_entry()',
     $a$else jsonb_build_object('key', 'bank')$a$,
     $b$else jsonb_build_object('account_id', public.bank_account_gl(new.company_id, new.bank_account_id))$b$),
    ('public.record_inventory_purchase(date,jsonb,text,uuid,uuid,uuid,uuid,text)',
     $a$v_jlines := v_jlines || jsonb_build_object('key', v_credit, 'debit', 0, 'credit', v_total);$a$,
     $b$v_jlines := v_jlines || case v_credit
    when 'bank' then jsonb_build_object('account_id', public.bank_account_gl(v_co, p_bank_account_id), 'debit', 0, 'credit', v_total)
    when 'cash' then jsonb_build_object('account_id', public.cash_account_for(v_co, p_custodian_location_id), 'debit', 0, 'credit', v_total)
    else jsonb_build_object('key', v_credit, 'debit', 0, 'credit', v_total)
  end;$b$)
  ) as t(fn, anchor, repl)
  loop
    v_def := pg_get_functiondef(r.fn::regprocedure);
    if position(r.repl in v_def) > 0 then
      continue;   -- already applied (replay)
    end if;
    v_hits := (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor);
    if v_hits <> 1 then
      raise exception '0512 REFUSED: % anchor appears % times, expected 1.', r.fn, v_hits;
    end if;
    execute replace(v_def, r.anchor, r.repl);
  end loop;
end $$;

-- 2. Reclass the seven ------------------------------------------------------
do $$
declare
  m record; v_bank uuid; v_gl uuid; v_name text; v_date date; v_n int := 0;
begin
  for m in
    select je.id, je.company_id, je.entry_date, je.source_table, je.source_id,
           jl.debit, jl.credit, jl.branch_id, jl.account_id as control_id
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where a.system_key = 'bank' and a.is_control
       and exists (select 1 from public.chart_of_accounts c where c.parent_id = a.id)
       and not je.is_reversal
       and not exists (select 1 from public.journal_entries rv where rv.reversal_of_entry_id = je.id)
       and not exists (select 1 from public.journal_entries rc
                        where rc.source_table = je.source_table and rc.source_id = je.source_id
                          and rc.description like '%(0512)%')
  loop
    v_bank := case m.source_table
      when 'cash_deposits'           then (select bank_account_id from public.cash_deposits where id = m.source_id)
      when 'partner_account_entries' then (select bank_account_id from public.partner_account_entries where id = m.source_id)
      when 'expense_settlements'     then (select coalesce(e.paid_bank_account_id, e.bank_account_id,
                                                  (select bt.bank_account_id from public.bank_transactions bt
                                                    where bt.reference_id = e.id::text and bt.bank_account_id is not null
                                                    order by bt.created_at desc limit 1))
                                             from public.expenses e where e.id = m.source_id)
      when 'custody_float'           then (select bt.bank_account_id from public.bank_transactions bt
                                            where bt.kind = 'withdraw_to_cash' and bt.reference_id = m.source_id::text
                                              and bt.amount = m.credit
                                            order by bt.created_at desc limit 1)
    end;
    if v_bank is null then
      raise exception '0512 REFUSED: cannot tell which bank % % (entry %) moved.', m.source_table, m.source_id, m.id;
    end if;
    select cl.coa_account_id, b.bank_name into v_gl, v_name
      from public.bank_accounts b
      join public.cash_locations cl on cl.bank_account_id = b.id and cl.coa_account_id is not null
     where b.id = v_bank limit 1;
    if v_gl is null then
      raise exception '0512 REFUSED: bank % has no ledger account of its own.', v_bank;
    end if;

    v_date := case when public.is_period_closed(m.company_id, m.entry_date) then current_date else m.entry_date end;

    perform public.post_journal(
      m.company_id, v_date,
      'Reclass to ' || v_name || ' — had posted to the Bank Accounts control (0512)',
      m.source_table, m.source_id, false,
      jsonb_build_array(
        jsonb_build_object('account_id', m.control_id, 'debit', m.credit, 'credit', m.debit),
        jsonb_build_object('account_id', v_gl,         'debit', m.debit,  'credit', m.credit)),
      m.branch_id);
    v_n := v_n + 1;
  end loop;
  raise notice '0512: % entr(y/ies) reclassed', v_n;
end $$;

-- 3. The guard ------------------------------------------------------------
create or replace function public.refuse_control_account_posting()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_exempt constant text[] := array['reserve_funding', 'bonus_reserve_funding', 'fixed_assets_disposal'];  -- DEFERRED, see 0512
  a  record;
  je record;
begin
  if public.is_maintenance_session() then return new; end if;

  select ca.account_code, ca.account_name into a
    from public.chart_of_accounts ca
   where ca.id = new.account_id and ca.is_control
     and exists (select 1 from public.chart_of_accounts c where c.parent_id = ca.id and c.active);
  if a.account_code is null then return new; end if;

  select is_reversal, source_table into je from public.journal_entries where id = new.journal_entry_id;
  if je.is_reversal or je.source_table = any (v_exempt) then return new; end if;

  raise exception
    'A journal line cannot post to the control account % "%" — it has an account per bank/custodian, and a posting here moves no balance any screen shows. Name the specific account (bank_account_gl / cash_account_for). Source: %. Nothing has been recorded.',
    a.account_code, a.account_name, coalesce(je.source_table, '?')
    using errcode = '23514';
end;
$$;

comment on function public.refuse_control_account_posting() is
  '0512. Refuses journal lines on a control account that has sub-accounts (1010 bank, 1000 cash). Exempt: reversals, maintenance sessions, and DEFERRED reserve_funding / bonus_reserve_funding / fixed_assets_disposal, which take no bank argument — the change if they should name a bank is to add p_bank_account_id and drop them from v_exempt.';

drop trigger if exists trg_journal_lines_no_control_posting on public.journal_lines;
create trigger trg_journal_lines_no_control_posting
  before insert on public.journal_lines
  for each row execute function public.refuse_control_account_posting();

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0512 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
