-- 0655 — a small reconciliation difference can be written off as rounding
--
-- Found 10–11 Nov 2026 on Askari. iNet paid October salaries Rs 3 less in
-- total than Bastion recorded (per-transfer rounding), so the statement stood
-- Rs 3 above the books. Reconcile parked +3 in Bank Suspense (correct). The
-- only way out of suspense was clear_bank_suspense (0534), which is built for
-- "the missing entry has now been recorded": it takes the parked amount back
-- OUT of the bank so it is not counted twice. Used for rounding, it undid the
-- adjustment — the bank fell back 3 below the statement — and the next
-- reconcile parked +3 again. Askari now agrees with its statement (11 Nov,
-- difference 0) but Rs 3 sits in Bank Suspense with nowhere to go, and suspense
-- "should return to zero" (0534).
--
-- A rounding difference has no missing entry to record. It is income or a cost
-- of its own, and the bank figure was right. So:
--   1. ensure_rounding_account(company) — 6950 Rounding Differences (expense,
--      normal debit; a gain shows as a credit). DECIDED 11 Nov 2026 (Shayan):
--      "yes create".
--   2. write_off_bank_suspense(reconciliation, note) — moves a parked amount
--      from Bank Suspense to Rounding Differences. The bank does NOT move
--      (no apply_money_delta), which is the whole difference from clearing.
--      Same refusals as clear_bank_suspense (not parked, already cleared, no
--      note), same row marked cleared, so the screen's "parked" list empties.
--      REFUSES anything above Rs 100: rounding is small, and a write-off that
--      could absorb a real missing payment would hide exactly what suspense
--      exists to keep visible. Above that, find the entry and clear.
--
-- clear_bank_suspense is not touched: one author (0534) and still the right
-- tool for a found entry.
--
-- Asserted on what can break: writing off Askari's parked Rs 3 (inside a block
-- rolled back by a sentinel) leaves the Askari balance unchanged to the paisa,
-- empties Bank Suspense of that reconciliation's 3, and puts 3 on the credit
-- side of Rounding Differences. A write-off of Rs 101 is refused with its own
-- message.

create or replace function public.ensure_rounding_account(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select id into v_id from public.chart_of_accounts
   where company_id = p_company_id and system_key = 'rounding_differences'
   limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side,
     system_key, active, system_account, notes)
  values
    (p_company_id, '6950', 'Rounding Differences', 'expense', 'debit',
     'rounding_differences', true, true,
     'Small bank differences written off from Bank Suspense (0655). A gain is a credit.')
  returning id into v_id;

  return v_id;
end $function$;

revoke all on function public.ensure_rounding_account(uuid) from public, anon, authenticated;

create or replace function public.write_off_bank_suspense(p_reconciliation_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r public.bank_reconciliations; v_desc text; v_je uuid; v_n int; v_round uuid;
begin
  -- Permission: every signed-in caller; skipped for trusted backend (auth.uid()
  -- null) and inside a trigger, exactly like disburse_payslip.
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  if p_reconciliation_id is not null then
    perform public.assert_same_company((select company_id from public.bank_reconciliations where id = p_reconciliation_id));
  end if;

  select * into r from public.bank_reconciliations where id = p_reconciliation_id for update;
  if r.id is null then raise exception 'That reconciliation does not exist. Nothing has been recorded.'; end if;
  if not r.posted_to_suspense then raise exception 'This reconciliation parked nothing in suspense. Nothing has been recorded.'; end if;
  if r.cleared_at is not null then raise exception 'This suspense amount was already cleared. Nothing has been recorded.'; end if;
  if nullif(btrim(p_note), '') is null then
    raise exception 'Say what the difference was. Nothing has been recorded.';
  end if;
  if abs(r.difference) > 100 then
    raise exception 'Rs % is too large to write off as rounding (the limit is Rs 100). Find the entry, record it, then clear. Nothing has been recorded.',
      to_char(abs(r.difference), 'FM999,999,990.00') using errcode = '23514';
  end if;

  v_round := public.ensure_rounding_account(r.company_id);
  v_desc := format('Rounding written off (reconciliation %s): %s', to_char(r.statement_date, 'DD Mon YYYY'), btrim(p_note));

  -- difference > 0: the statement was above the books, suspense holds a credit;
  -- debit it back to zero and credit Rounding Differences (a gain). < 0: mirror.
  v_je := public.post_journal(r.company_id, current_date, v_desc, 'bank_reconciliations', r.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', public.bank_suspense_account(r.company_id),
                         'debit', greatest(r.difference, 0), 'credit', greatest(-r.difference, 0)),
      jsonb_build_object('account_id', v_round,
                         'debit', greatest(-r.difference, 0), 'credit', greatest(r.difference, 0))));

  update public.bank_reconciliations
     set cleared_at = now(), cleared_by = auth.uid(), clear_journal_id = v_je, clear_note = btrim(p_note)
   where id = r.id and cleared_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The suspense amount could not be written off. Nothing has been recorded.'; end if;
end $function$;

comment on function public.write_off_bank_suspense(uuid, text) is
  '0655: write a reconciliation''s parked suspense (at most Rs 100) off to 6950 Rounding Differences. The bank does not move — '
  'unlike clear_bank_suspense, which is for a found entry. DECIDED 11 Nov 2026 (Shayan).';

revoke all on function public.write_off_bank_suspense(uuid, text) from public, anon;
grant execute on function public.write_off_bank_suspense(uuid, text) to authenticated;

do $mig$
declare
  r       public.bank_reconciliations;
  v_bal0  numeric;
  v_bal1  numeric;
  v_susp  numeric;
  v_rnd   numeric;
  v_msg   text;
  v_ok    boolean := false;
begin
  select * into r from public.bank_reconciliations br
   where br.posted_to_suspense and br.cleared_at is null and br.difference = 3
     and br.bank_account_id = (select id from public.bank_accounts where account_number = '03410420001645')
   order by br.reconciled_at desc limit 1;

  if r.id is null then
    raise notice '0655: Askari''s parked Rs 3 is no longer open; the rolled-back test is skipped, the refusal test still runs.';
  else
    select balance into v_bal0 from public.bank_accounts where id = r.bank_account_id;
    begin
      perform public.write_off_bank_suspense(r.id, '0655 test — rolled back');
      select balance into v_bal1 from public.bank_accounts where id = r.bank_account_id;
      if v_bal1 is distinct from v_bal0 then
        raise exception '0655 REFUSED: the write-off moved the Askari balance from % to %.', v_bal0, v_bal1;
      end if;
      select coalesce(sum(jl.debit - jl.credit), 0) into v_susp
        from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
       where je.source_table = 'bank_reconciliations' and je.source_id = r.id
         and jl.account_id = public.bank_suspense_account(r.company_id);
      if round(v_susp, 2) <> 0 then
        raise exception '0655 REFUSED: after the write-off this reconciliation leaves % in Bank Suspense, expected 0.', v_susp;
      end if;
      select coalesce(sum(jl.credit - jl.debit), 0) into v_rnd
        from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
       where je.source_table = 'bank_reconciliations' and je.source_id = r.id
         and jl.account_id = public.ensure_rounding_account(r.company_id);
      if round(v_rnd, 2) <> 3 then
        raise exception '0655 REFUSED: Rounding Differences received % (credit), expected 3.', v_rnd;
      end if;
      v_ok := true;
      raise exception '0655_SENTINEL';
    exception when others then
      if sqlerrm <> '0655_SENTINEL' then raise; end if;
    end;
    if not v_ok then raise exception '0655 REFUSED: the rolled-back write-off did not complete.'; end if;
  end if;

  -- The limit refuses with its own message. A throwaway reconciliation of 101
  -- on the same bank, inside a rolled-back block.
  begin
    insert into public.bank_reconciliations
      (id, company_id, bank_account_id, statement_date, statement_balance, book_balance, difference, posted_to_suspense)
    select gen_random_uuid(), b.company_id, b.id, current_date, 101, 0, 101, true
      from public.bank_accounts b where b.account_number = '03410420001645'
    returning * into r;
    perform public.write_off_bank_suspense(r.id, '0655 limit test');
    raise exception '0655_NOT_REFUSED';
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg not like 'Rs 101.00 is too large to write off as rounding%' then
    raise exception '0655 REFUSED: the Rs 100 limit did not refuse with its own message; got: %', v_msg;
  end if;

  if exists (select 1 from public.security_gaps()) then raise exception '0655 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0655 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $mig$;