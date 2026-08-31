-- Tests for 0260 (first-close gate) and 0261 (partner_account_entries audit).
--
-- STATUS: GREEN. 9/9, canary complete, on dev (crm-design-dev,
-- wlyhbvunvdsropqzlpwx). Runs inside a transaction that rolls back via a
-- deliberate exception at the end; nothing here survives.
--
-- WHAT WOULD MAKE EACH ASSERTION RED — stated before the results, per §9.6.
--
--   G1  A company with NO posted opening batch closes its first period. Red if
--       the insert succeeds. This is the negative control and it is the whole
--       point of 0260.
--   G2  The refusal's MESSAGE. Red if something else raised — a not-null
--       violation, an RLS denial, a typo in a column name. Three tests in this
--       repo have previously passed against the wrong trigger; asserting that
--       "something raised" is not asserting anything.
--   G3  A DRAFT batch does not satisfy the gate. Red if draft is accepted —
--       that would make the gate assert intention rather than posting.
--   G4  A VOIDED batch does not satisfy the gate. Same reasoning.
--   G5  A company WITH a posted batch closes its first period successfully.
--       Red if the gate refuses. Without this the gate could be an
--       unconditional "no" and G1–G4 would all still pass.
--   G6  The SECOND close needs nothing. Red if the gate fires again — it would
--       mean every month re-asks a question already answered.
--   A1  An INSERT into partner_account_entries writes an audit_log row.
--   A2  An UPDATE of partner_id writes an audit_log row naming the column, with
--       both before and after. Red if the row is absent or the change map is
--       missing partner_id — an audit that records "something changed" without
--       recording what is the gap 0261 exists to close.
--   A3  A DELETE writes an audit_log row. Red if absent; a deleted capital
--       movement leaving no trace is the worst case of the three.
--
-- The canary at the end fails loudly unless all nine ran. A suite whose silence
-- cannot distinguish "all passed" from "aborted at test 4" is not a harness.

do $suite$
declare
  c_co        constant uuid := '5eed0000-0000-4000-8000-000000000001';
  v_other     uuid;
  v_partner   uuid;
  v_entry     uuid;
  v_batch     uuid;
  v_acct      uuid;
  v_ran       integer := 0;
  v_expected  constant integer := 9;
  v_msg       text;
  v_ok        boolean;
  v_n         integer;
  v_changes   jsonb;
begin
  -- A company with no opening batch of any kind. Any company other than SANDBOX
  -- qualifies; opening_balance_batches held exactly one row (SANDBOX's) when
  -- this was written.
  select id into v_other from public.companies where id <> c_co
   and not exists (select 1 from public.opening_balance_batches b where b.company_id = companies.id)
   limit 1;
  if v_other is null then
    raise exception 'FIXTURE: no company without an opening batch; G1-G4 cannot run';
  end if;

  -- ---------------------------------------------------------------- G1 + G2
  v_ok := false; v_msg := null;
  begin
    insert into public.accounting_periods (company_id, period_month)
    values (v_other, date '2026-01-01');
  exception when others then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok then
    raise exception 'G1 FAILED: first close succeeded with no opening batch';
  end if;
  v_ran := v_ran + 1;

  if v_msg not like '%without a posted opening balance batch%' then
    raise exception 'G2 FAILED: refused, but by something else: %', v_msg;
  end if;
  v_ran := v_ran + 1;

  -- ---------------------------------------------------------------- G3 draft
  select id into v_acct from public.chart_of_accounts
   where company_id = v_other and system_key = 'opening_balance_equity' limit 1;

  insert into public.opening_balance_batches (company_id, as_of_date, description, status)
  values (v_other, date '2025-12-31', 'draft probe', 'draft') returning id into v_batch;

  v_ok := false;
  begin
    insert into public.accounting_periods (company_id, period_month)
    values (v_other, date '2026-01-01');
  exception when others then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok or v_msg not like '%without a posted opening balance batch%' then
    raise exception 'G3 FAILED: a DRAFT batch satisfied the gate (msg: %)', v_msg;
  end if;
  v_ran := v_ran + 1;

  -- ---------------------------------------------------------------- G4 voided
  update public.opening_balance_batches set status = 'voided' where id = v_batch;

  v_ok := false;
  begin
    insert into public.accounting_periods (company_id, period_month)
    values (v_other, date '2026-01-01');
  exception when others then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok or v_msg not like '%without a posted opening balance batch%' then
    raise exception 'G4 FAILED: a VOIDED batch satisfied the gate (msg: %)', v_msg;
  end if;
  v_ran := v_ran + 1;

  -- ------------------------------------------------- G5 positive control
  -- SANDBOX has a posted batch as of 0259/G1. If the gate is an unconditional
  -- refusal, this is where that shows.
  insert into public.accounting_periods (company_id, period_month)
  values (c_co, date '2026-06-01');
  v_ran := v_ran + 1;

  -- ------------------------------------------------- G6 second close is free
  insert into public.accounting_periods (company_id, period_month)
  values (c_co, date '2026-07-01');
  v_ran := v_ran + 1;

  -- ------------------------------------------------- A1 insert is audited
  select id into v_partner from public.partners where company_id = c_co
     and coa_account_id is not null limit 1;
  if v_partner is null then
    raise exception 'FIXTURE: no partner with a capital account; A1-A3 cannot run';
  end if;

  insert into public.partner_account_entries
    (company_id, partner_id, type, amount, date, payment_method, description)
  values (c_co, v_partner, 'CONTRIBUTION', 1000, date '2026-08-01', 'BANK_TRANSFER', 'audit probe')
  returning id into v_entry;

  select count(*) into v_n from public.audit_log
   where table_name = 'partner_account_entries' and record_id = v_entry and action = 'insert';
  if v_n <> 1 then
    raise exception 'A1 FAILED: expected 1 insert audit row, found %', v_n;
  end if;
  v_ran := v_ran + 1;

  -- ------------------------------------------------- A2 update names the column
  select id into v_partner from public.partners where company_id = c_co
     and coa_account_id is not null and id <> v_partner limit 1;
  if v_partner is null then
    raise exception 'FIXTURE: only one partner with a capital account; A2 cannot run';
  end if;

  update public.partner_account_entries set partner_id = v_partner where id = v_entry;

  select changes into v_changes from public.audit_log
   where table_name = 'partner_account_entries' and record_id = v_entry and action = 'update'
   order by changed_at desc limit 1;
  if v_changes is null then
    raise exception 'A2 FAILED: no update audit row';
  end if;
  if not (v_changes ? 'partner_id')
     or v_changes->'partner_id'->'before' is null
     or v_changes->'partner_id'->'after'  is null then
    raise exception 'A2 FAILED: audit row does not record partner_id before/after: %', v_changes;
  end if;
  v_ran := v_ran + 1;

  -- ------------------------------------------------- A3 delete is audited
  delete from public.partner_account_entries where id = v_entry;

  select count(*) into v_n from public.audit_log
   where table_name = 'partner_account_entries' and record_id = v_entry and action = 'delete';
  if v_n <> 1 then
    raise exception 'A3 FAILED: expected 1 delete audit row, found %', v_n;
  end if;
  v_ran := v_ran + 1;

  -- ------------------------------------------------- canary, then roll back
  if v_ran <> v_expected then
    raise exception 'CANARY FAILED: % of % assertions ran', v_ran, v_expected;
  end if;

  raise exception 'ROLLBACK (expected): % of % assertions passed', v_ran, v_expected;
end
$suite$;
