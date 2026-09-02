-- 0322 — the period lock gains the half it could never see.
--
-- The lock tests whether a period is CLOSED. A period nobody has reached is
-- not closed, so it is open, so the lock permits posting into it. That is not
-- an oversight in the data; it is a gap the predicate cannot see by
-- construction.
--
-- WHERE THE TEST GOES, AND WHY IT IS NOT WHERE IT WAS ASKED TO GO.
--
-- The instruction was to put the future test beside the is_period_closed call
-- in enforce_period_lock. That is right, with one correction the schema forces:
-- enforce_period_lock is attached to SEVEN tables —
--
--   advances(advance_date)          expenses(expense_date)
--   cheques(cheque_date)            invoice_payments(payment_date)
--   invoices(invoice_date)          payslips(period_month)
--   journal_entries(entry_date)
--
-- — and an unscoped future test inside it would refuse exactly the two columns
-- 0321 established must stay unbounded: a post-dated cheque, and an invoice
-- dated ahead of the month it bills for. The rule is about ENTRIES: "no entry
-- may post into a period later than the current one." So the test is scoped to
-- journal_entries and nothing else.
--
-- WHAT IT READS. posting_period, not entry_date. posting_period IS the period;
-- date_trunc on entry_date is a proxy for it, and the two are allowed to
-- diverge by policy — advance invoicing (9.19) will make them diverge on
-- purpose. A guard that tests a proxy is the defect this project has now found
-- four times, so it tests the column that means what the rule means.
--
-- WHAT IT DOES NOT CATCH, deliberately. The entry that prompted all of this
-- (2026-09-15, posted 2026-09-02) is in the CURRENT period, so this rule
-- permits it. 0321 refuses it at source, where the future date is actually
-- entered. The two rules are complementary and neither is a substitute.
--
-- The surgery is done against the LIVE definition rather than by restating the
-- function. Restating enforce_period_lock from a copy is how 0286 and 0288
-- silently dropped two checks from ledger_checks.

do $surgery$
declare
  v_src text;
  v_anchor constant text := '  if public.is_period_closed(v_company, v_new_date) then';
  v_hits int;
  v_new_block constant text :=
$blk$  -- 0322. The half the lock could not see. NOT inside is_period_closed:
  -- "closed" and "not yet reached" are different facts, and one predicate
  -- answering both is how a detector's own predicate becomes the defect.
  -- Scoped to journal_entries because the other six tables this trigger guards
  -- include cheque_date and invoice_date, which 0321 established are allowed
  -- to be ahead.
  if tg_table_name = 'journal_entries'
     and ((to_jsonb(new) ->> 'posting_period')::date
            > date_trunc('month', current_date)::date) then
    raise exception
      'This entry posts to %, a period that has not been reached yet. The period lock can only tell you whether a month is CLOSED, and a month nobody has reached is not closed — so nothing else would have stopped this. [journal_entries.posting_period]',
      to_char((to_jsonb(new) ->> 'posting_period')::date, 'FMMonth YYYY')
      using errcode = 'P0001';
  end if;

$blk$;
begin
  select pg_get_functiondef('public.enforce_period_lock()'::regprocedure) into v_src;

  if position('0322' in v_src) > 0 then
    raise notice '0322: already applied, leaving the definition alone';
    return;
  end if;

  -- The anchor has to be found exactly once. Zero means the function changed
  -- shape and this migration is patching something it does not understand;
  -- more than one means the insert would land in an unknown place.
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      '0322 FAILED: the is_period_closed(v_company, v_new_date) anchor appears % times in enforce_period_lock, expected exactly 1 — do not guess where the test belongs',
      v_hits;
  end if;

  v_src := replace(v_src, v_anchor, v_new_block || v_anchor);
  execute v_src;
end
$surgery$;

-- ---------------------------------------------------------------------------
-- Proof. Both directions, both rolled back, the refusal asserted on its
-- message — the six other tables this trigger guards each raise their own, and
-- three tests in this project have already passed against the wrong trigger.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_company uuid;
  v_outcome text;
  v_next date := (date_trunc('month', current_date) + interval '1 month')::date;
  v_this date := date_trunc('month', current_date)::date;
begin
  if position('0322' in pg_get_functiondef('public.enforce_period_lock()'::regprocedure)) = 0 then
    raise exception '0322 FAILED: the surgery did not land — enforce_period_lock carries no 0322 marker';
  end if;

  select company_id into v_company
    from public.journal_entries group by company_id order by count(*) desc limit 1;
  if v_company is null then
    raise exception '0322 FAILED: no company has any journal entries, so nothing below is exercised';
  end if;

  -- (a) next month must be REFUSED.
  v_outcome := null;
  begin
    insert into public.journal_entries
      (company_id, entry_date, posting_period, description, source_table, manual)
    values
      (v_company, v_next, v_next, '0322 probe: future period', 'manual', true);
    v_outcome := 'ACCEPTED';
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome = 'ACCEPTED' then
    raise exception '0322 FAILED: an entry posting to % was accepted', v_next;
  end if;
  if position('has not been reached yet' in v_outcome) = 0 then
    raise exception '0322 FAILED: the future-period entry was refused for the WRONG reason: %', v_outcome;
  end if;

  -- (b) this month must be ACCEPTED. A lock that refuses the current period is
  -- an outage, not a control (report 9.11). The deliberate raise unwinds it.
  v_outcome := null;
  begin
    insert into public.journal_entries
      (company_id, entry_date, posting_period, description, source_table, manual)
    values
      (v_company, current_date, v_this, '0322 probe: current period', 'manual', true);
    raise exception 'PROBE_ACCEPTED_ROLLBACK';
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome <> 'PROBE_ACCEPTED_ROLLBACK' then
    raise exception '0322 FAILED: an entry posting to the CURRENT period was refused: %', v_outcome;
  end if;

  -- (c) the exemption 0321 established must survive. An invoice dated ahead is
  -- still allowed, because A4 posts it at period_start regardless.
  v_outcome := null;
  begin
    update public.invoices set invoice_date = current_date + 45
     where id = (select id from public.invoices limit 1);
    raise exception 'PROBE_ACCEPTED_ROLLBACK';
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is not null and v_outcome <> 'PROBE_ACCEPTED_ROLLBACK' then
    raise exception '0322 FAILED: a forward invoice_date is now refused, which 0321 says it must not be: %', v_outcome;
  end if;

  raise notice '0322 OK: future period refused, current period accepted, forward invoice_date still allowed';
end
$proof$;
