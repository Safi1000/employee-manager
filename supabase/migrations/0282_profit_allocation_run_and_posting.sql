-- 0282 — F4.2 and F4.3. The profit allocation becomes a posted, reversible run
-- with its inputs stored beside its outputs, and a check that can be proved
-- against synthetic failure.
--
-- WHERE THIS STARTS
--
-- `partnership_allocation()` is already the nested waterfall — regional shares
-- are deducted, equity takes the residual, and both months allocate exactly
-- 100% (docs/LEDGER_PHASE1_F41_TRACE.md). What it does NOT do is post. There
-- were zero journal entries with an allocation source table and
-- `Regional Partner Remuneration` (6400) sat at 0.00, so rows 33, 34 and 35 of
-- the posting rules were BLOCKED and the partners' capital accounts never moved.
-- It was a report, not a ledger event.
--
-- `profit_allocation_runs` existed and held nothing, and its unique key was
-- wrong in a way worth naming: **UNIQUE (company_id, period_month, status)**
-- permits a DRAFT and a POSTED for the same month at the same time. A uniqueness
-- constraint that includes the status column does not constrain the thing it
-- looks like it constrains.
--
-- THE CHECK IS WRITTEN AGAINST THE OUTPUT, DELIBERATELY.
--
-- The 135% defect was fixed in the function before its check existed, so the
-- real failure is no longer reachable — the inverse of the rule 0259
-- established. The answer is not to break the function to prove the check.
-- `profit_allocation_exhausts_pool` reads the stored **run record**, so a
-- synthetic over-allocated run can be inserted and the check confirmed red. It
-- is proved below, in a rolled-back subtransaction, against numbers shaped
-- exactly like the old separate-pools rule.
--
--   WHEN A FIX LANDS BEFORE ITS CHECK, THE CHECK MUST BE PROVED AGAINST
--   SYNTHETIC FAILURE, BECAUSE THE REAL FAILURE IS NO LONGER REACHABLE.

-- ---------------------------------------------------------------------------
-- 1. The run record
-- ---------------------------------------------------------------------------

alter table public.profit_allocation_runs
  drop constraint if exists profit_allocation_runs_company_id_period_month_status_key;

alter table public.profit_allocation_runs
  drop constraint if exists profit_allocation_runs_status_check;

alter table public.profit_allocation_runs
  add column if not exists basis            text,
  add column if not exists total_profit     numeric(14,2),
  add column if not exists regional_total   numeric(14,2),
  add column if not exists equity_total     numeric(14,2),
  add column if not exists entry_id         uuid,
  add column if not exists inputs           jsonb not null default '[]'::jsonb,
  add column if not exists outputs          jsonb not null default '[]'::jsonb,
  add column if not exists posted_by        uuid,
  add column if not exists reversed_at      timestamptz,
  add column if not exists reversal_entry_id uuid;

-- One run per month, whatever its status. A month that has been reversed and
-- re-run keeps one row and moves through the states, so the history of the
-- month is the row's audit trail rather than a pile of rows to disambiguate.
create unique index if not exists profit_allocation_runs_one_per_month
  on public.profit_allocation_runs (company_id, period_month);

alter table public.profit_allocation_runs
  add constraint profit_allocation_runs_status_check
  check (status in ('DRAFT', 'POSTED', 'REVERSED'));

comment on table public.profit_allocation_runs is
  'One profit allocation per company per month. DRAFT -> POSTED -> REVERSED. inputs holds the per-client Net Cash, the rate applied and the partner_client_shares row it came from; outputs holds what was allocated. Reversible as a unit through entry_id / reversal_entry_id (0282).';

-- ---------------------------------------------------------------------------
-- 2. Pre-allocation review — SURFACING, NOT BLOCKING.
--
--    Every row here is a thing a person should look at before posting, and none
--    of them is wrong on its face. A client with cost and no invoice may be a
--    missed bill or may be a client billed quarterly. A negative Net Cash client
--    may be a loss-maker or a timing artefact. Refusing to post on any of them
--    would make the reviewer's job the machine's, and the machine does not know
--    which it is. A9 explicitly allows negative shares with no floor.
-- ---------------------------------------------------------------------------

create or replace function public.profit_allocation_review(p_company_id uuid, p_period date)
returns table(kind text, subject text, subject_id uuid, amount numeric, detail text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_start date := date_trunc('month', p_period)::date;
  v_end   date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_basis text := public.partner_basis_for_report(null);
begin
  return query
  -- (a) cost incurred against a client with no invoice in the period
  select 'client_cost_no_invoice'::text, c.name, c.id,
         round(coalesce(sum(e.amount), 0), 2),
         'Expenses booked to this client but no invoice dated in the period'::text
    from public.clients c
    join public.expenses e on e.client_id = c.id
     and e.expense_date between v_start and v_end
   where c.company_id = p_company_id
     and not exists (select 1 from public.invoices i
                      where i.client_id = c.id
                        and coalesce(i.period_start, i.invoice_date) between v_start and v_end)
   group by c.id, c.name
  having coalesce(sum(e.amount), 0) > 0

  union all
  -- (b) clients whose Net Cash for the period is negative
  select 'client_negative_net', c.name, c.id, round(s.net, 2),
         'Net is negative on the ' || v_basis || ' basis'
    from public.client_statement_loaded(v_start, v_end, v_basis) s
    join public.clients c on c.id = s.client_id
   where s.net < 0

  union all
  -- (c) pools that reached no region
  select 'unallocated_pool', coalesce(a.region_name, 'Head Office'), a.branch_id,
         round(a.amount, 2),
         'This pool was not apportioned — no revenue base in the period'
    from public.partnership_allocation(v_start, v_end, v_basis) a
   where a.row_kind in ('UNALLOCATED_HO', 'UNALLOCATED')
     and abs(coalesce(a.amount, 0)) > 0.005

  union all
  -- (d) partners whose total for the month is negative
  select 'partner_negative_total', a.partner_name, a.partner_id,
         round(sum(a.amount), 2),
         'A9 permits this with no floor; it reduces the partner''s capital account'
    from public.partnership_allocation(v_start, v_end, v_basis) a
   where a.row_kind in ('REGIONAL_PARTNER', 'EQUITY_PARTNER')
     and a.partner_id is not null
   group by a.partner_name, a.partner_id
  having sum(a.amount) < 0;
end;
$function$;

comment on function public.profit_allocation_review(uuid, date) is
  'Things worth a person''s attention before posting a month''s allocation. Surfacing only — none of these blocks the run (0282).';

-- ---------------------------------------------------------------------------
-- 3. The run: compute, store inputs and outputs, post rows 33/34/35.
-- ---------------------------------------------------------------------------

create or replace function public.run_profit_allocation(
  p_company_id uuid, p_period date, p_basis text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_month   date := date_trunc('month', p_period)::date;
  v_end     date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_basis   text := public.partner_basis_for_report(p_basis);
  v_run     uuid;
  v_status  text;
  v_profit  numeric := 0;
  v_reg     numeric := 0;
  v_eq      numeric := 0;
  v_lines   jsonb := '[]'::jsonb;
  v_inputs  jsonb;
  v_outputs jsonb;
  v_acct    uuid;
  v_rem     uuid;
  v_re      uuid;
  v_entry   uuid;
  v_user    uuid;
  r         record;
begin
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  -- Same door as run_ho_cost_allocation (0250): this posts a whole month, so
  -- against a closed period it would restate that month rather than adjust it.
  if public.is_period_closed(p_company_id, v_month) then
    raise exception
      'Period % is closed. run_profit_allocation posts the whole month; reopen it in Period Close first.',
      v_month using errcode = 'P0001';
  end if;

  select id, status into v_run, v_status
    from public.profit_allocation_runs
   where company_id = p_company_id and period_month = v_month;

  if v_status = 'POSTED' then
    raise exception
      'Profit allocation for % is already POSTED. Reverse it before running again.', v_month
      using errcode = 'P0001',
            hint = 'select public.reverse_profit_allocation(''' || v_run || '''::uuid);';
  end if;

  begin v_user := auth.uid(); exception when others then v_user := null; end;

  v_rem := public.coa_id(p_company_id, 'regional_partner_remuneration');
  v_re  := public.coa_id(p_company_id, 'retained_earnings');
  if v_rem is null or v_re is null then
    raise exception 'Chart of accounts is missing regional_partner_remuneration or retained_earnings';
  end if;

  -- Totals, straight from the allocation. The REGION rows carry the profit;
  -- the partner rows carry what each takes.
  select coalesce(sum(a.base_amount) filter (where a.row_kind = 'REGION'), 0),
         coalesce(sum(a.amount)      filter (where a.row_kind = 'REGIONAL_PARTNER'), 0),
         coalesce(sum(a.amount)      filter (where a.row_kind = 'EQUITY_PARTNER'), 0)
    into v_profit, v_reg, v_eq
    from public.partnership_allocation(v_month, v_end, v_basis) a;

  -- F4.3's central assertion. If the waterfall ever stops exhausting the pool,
  -- posting it would move the error into the ledger, where it is permanent.
  if round(v_reg + v_eq, 2) <> round(v_profit, 2) then
    raise exception
      'Profit allocation does not exhaust the pool for %: regional % + equity % = %, profit %',
      v_month, v_reg, v_eq, round(v_reg + v_eq, 2), round(v_profit, 2)
      using errcode = '23514';
  end if;

  -- Inputs, stored beside the outputs: the per-client Net Cash each regional
  -- partner's take was computed from, the rate applied, and the
  -- partner_client_shares row the rate came from (null = the partner's default).
  select coalesce(jsonb_agg(jsonb_build_object(
           'partner_id', p.id, 'partner_name', p.name,
           'client_id', s.client_id, 'client_net', round(s.net, 2),
           'pct', coalesce(o.share_percent, p.profit_share_percent),
           'share_row_id', o.id)), '[]'::jsonb)
    into v_inputs
    from public.partners p
    join public.client_statement_loaded(v_month, v_end, v_basis) s on s.branch_id = p.branch_id
    left join lateral (
      select sh.id, sh.share_percent from public.partner_client_shares sh
       where sh.partner_id = p.id and sh.client_id = s.client_id
         and sh.effective_month <= v_month
       order by sh.effective_month desc limit 1
    ) o on true
   where p.company_id = p_company_id and p.scope = 'BRANCH' and p.is_active
     and p.branch_id is not null;

  select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into v_outputs
    from public.partnership_allocation(v_month, v_end, v_basis) a;

  if v_run is null then
    insert into public.profit_allocation_runs
      (company_id, period_month, status, basis, total_profit, regional_total,
       equity_total, inputs, outputs, created_by)
    values (p_company_id, v_month, 'DRAFT', v_basis, round(v_profit, 2),
            round(v_reg, 2), round(v_eq, 2), v_inputs, v_outputs, v_user)
    returning id into v_run;
  else
    update public.profit_allocation_runs
       set status = 'DRAFT', basis = v_basis, total_profit = round(v_profit, 2),
           regional_total = round(v_reg, 2), equity_total = round(v_eq, 2),
           inputs = v_inputs, outputs = v_outputs,
           entry_id = null, reversed_at = null, reversal_entry_id = null
     where id = v_run;
  end if;

  -- Rows 33/34: regional remuneration is an EXPENSE. A negative share reverses
  -- the legs rather than posting a negative number, so every line stays a
  -- positive debit or credit and the sign lives in which side it is on.
  for r in
    select a.partner_id, a.partner_name, a.branch_id, round(a.amount, 2) as amt
      from public.partnership_allocation(v_month, v_end, v_basis) a
     where a.row_kind = 'REGIONAL_PARTNER' and abs(coalesce(a.amount, 0)) > 0.005
  loop
    select coa_account_id into v_acct from public.partners where id = r.partner_id;
    if v_acct is null then
      raise exception 'Partner % has no capital account', r.partner_name;
    end if;
    v_lines := v_lines || case when r.amt > 0 then
      jsonb_build_array(
        jsonb_build_object('account_id', v_rem,  'debit', r.amt, 'credit', 0,
                           'partner_id', r.partner_id, 'region', r.branch_id),
        jsonb_build_object('account_id', v_acct, 'debit', 0, 'credit', r.amt,
                           'partner_id', r.partner_id, 'region', r.branch_id))
    else
      jsonb_build_array(
        jsonb_build_object('account_id', v_acct, 'debit', -r.amt, 'credit', 0,
                           'partner_id', r.partner_id, 'region', r.branch_id),
        jsonb_build_object('account_id', v_rem,  'debit', 0, 'credit', -r.amt,
                           'partner_id', r.partner_id, 'region', r.branch_id))
    end;
  end loop;

  -- Row 35: equity partners take the residual out of retained earnings.
  for r in
    select a.partner_id, a.partner_name, round(a.amount, 2) as amt
      from public.partnership_allocation(v_month, v_end, v_basis) a
     where a.row_kind = 'EQUITY_PARTNER' and abs(coalesce(a.amount, 0)) > 0.005
  loop
    select coa_account_id into v_acct from public.partners where id = r.partner_id;
    if v_acct is null then
      raise exception 'Partner % has no capital account', r.partner_name;
    end if;
    v_lines := v_lines || case when r.amt > 0 then
      jsonb_build_array(
        jsonb_build_object('account_id', v_re,   'debit', r.amt, 'credit', 0,
                           'partner_id', r.partner_id),
        jsonb_build_object('account_id', v_acct, 'debit', 0, 'credit', r.amt,
                           'partner_id', r.partner_id))
    else
      jsonb_build_array(
        jsonb_build_object('account_id', v_acct, 'debit', -r.amt, 'credit', 0,
                           'partner_id', r.partner_id),
        jsonb_build_object('account_id', v_re,   'debit', 0, 'credit', -r.amt,
                           'partner_id', r.partner_id))
    end;
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    -- Nothing to post is a legitimate outcome (a month with no profit and no
    -- shares). The run still records that it was computed and found nothing.
    update public.profit_allocation_runs
       set status = 'POSTED', posted_at = now(), posted_by = v_user, entry_id = null
     where id = v_run;
    return v_run;
  end if;

  v_entry := public.post_journal(
    p_company_id, v_end,
    'Profit allocation ' || to_char(v_month, 'YYYY-MM'),
    'profit_allocation', v_run, false, v_lines, null);

  update public.profit_allocation_runs
     set status = 'POSTED', posted_at = now(), posted_by = v_user, entry_id = v_entry
   where id = v_run;

  return v_run;
end;
$function$;

comment on function public.run_profit_allocation(uuid, date, text) is
  'Computes, records and POSTS one month''s profit allocation as a single journal entry (rows 33/34/35). Refuses a closed month and refuses to run over an already-POSTED month. Asserts that regional + equity exhausts the profit before posting anything (0282).';

-- ---------------------------------------------------------------------------
-- 4. Reversal, as a unit.
-- ---------------------------------------------------------------------------

create or replace function public.reverse_profit_allocation(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_run record; v_rev uuid;
begin
  select * into v_run from public.profit_allocation_runs where id = p_run_id;
  if not found then raise exception 'Allocation run not found'; end if;
  perform public.assert_same_company(v_run.company_id);

  if v_run.status <> 'POSTED' then
    raise exception 'Allocation run for % is %, not POSTED', v_run.period_month, v_run.status
      using errcode = 'P0001';
  end if;

  perform public.reverse_journal_for_source(
    v_run.company_id, 'profit_allocation', p_run_id, current_date);

  select je.id into v_rev from public.journal_entries je
   where je.source_table = 'profit_allocation' and je.source_id = p_run_id
     and je.is_reversal order by je.created_at desc limit 1;

  update public.profit_allocation_runs
     set status = 'REVERSED', reversed_at = now(), reversal_entry_id = v_rev
   where id = p_run_id;
end;
$function$;

comment on function public.reverse_profit_allocation(uuid) is
  'Reverses a POSTED allocation as a unit and marks the run REVERSED. The month can then be re-run (0282).';

-- ---------------------------------------------------------------------------
-- 5. The check, written against the OUTPUT so it can be fed synthetic failure.
-- ---------------------------------------------------------------------------

create or replace function public.profit_allocation_over_allocated(p_company_id uuid)
returns table(run_id uuid, period_month date, total_profit numeric,
              allocated numeric, difference numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select r.id, r.period_month,
         coalesce(r.total_profit, 0),
         coalesce(r.regional_total, 0) + coalesce(r.equity_total, 0),
         round(coalesce(r.regional_total, 0) + coalesce(r.equity_total, 0)
               - coalesce(r.total_profit, 0), 2)
    from public.profit_allocation_runs r
   where r.company_id = p_company_id
     and r.status = 'POSTED'
     and abs(coalesce(r.regional_total, 0) + coalesce(r.equity_total, 0)
             - coalesce(r.total_profit, 0)) > 0.01
   order by r.period_month;
$function$;

comment on function public.profit_allocation_over_allocated(uuid) is
  'POSTED allocation runs where regional + equity does not equal the profit. This is the 135% check: the original defect allocated 100% equity + 15% + 20% from separate pools. Reads the stored run record, so it can be proved against synthetic failure (0282).';

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
    union all
    select 'bank_per_account_gl_equals_operational'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.bank_held_operational(p_company_id) b
     where abs(b.difference) > 0.005
    union all
    select 'no_negative_custodian_balance'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.negative_custodian_balances(p_company_id)
    union all
    select 'profit_allocation_exhausts_pool'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.profit_allocation_over_allocated(p_company_id)
  )
  select * from real_checks
  union all
  -- 17 = the number of REAL checks. The function returns one more row than
  -- this — the canary itself. Bump the constant deliberately when adding a
  -- check; never to make this row green.
  select 'checks_evaluated'::text,
         17::numeric,
         (select count(*) from real_checks)::numeric,
         (select count(*) from real_checks)::numeric - 17,
         (select count(*) from real_checks) = 17;
$function$;

-- ---------------------------------------------------------------------------
-- 6. THE SYNTHETIC-FAILURE PROOF.
--
--    The real 135% failure is unreachable: the function was fixed first. So the
--    check is fed a run record shaped exactly like the old separate-pools rule —
--    equity taking 100% of the full profit while the regional take stands
--    alongside it — and must go red. Then the same record with the nested
--    numbers, and it must go green. Both inside a subtransaction that is rolled
--    back by a deliberate raise, so nothing is left behind.
-- ---------------------------------------------------------------------------

do $$
declare
  v_co     uuid := (select id from public.companies where name = 'SANDBOX TESTING ORG');
  v_red    int;
  v_green  int;
  v_profit numeric := -131120.00;   -- July 2026, from the F4.1 trace
  v_reg    numeric :=  -25224.00;
begin
  if v_co is null then
    raise notice '0282: no sandbox company; synthetic proof skipped';
    return;
  end if;

  begin
    -- OLD RULE: equity takes 100% of the FULL profit, regional stands alongside.
    -- Total allocated -156,344.00 against a profit of -131,120.00 — 119.24%.
    insert into public.profit_allocation_runs
      (company_id, period_month, status, basis, total_profit, regional_total, equity_total)
    values (v_co, date '1900-01-01', 'POSTED', 'cash', v_profit, v_reg, v_profit);

    select count(*) into v_red from public.profit_allocation_over_allocated(v_co);

    -- NESTED RULE: equity takes the residual. Exhausts exactly.
    update public.profit_allocation_runs
       set equity_total = v_profit - v_reg
     where company_id = v_co and period_month = date '1900-01-01';

    select count(*) into v_green from public.profit_allocation_over_allocated(v_co);

    raise exception 'ROLLBACK_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROOF' then raise; end if;
  end;

  if v_red < 1 then
    raise exception '0282: the check did NOT go red on a synthetic over-allocation — it cannot fail';
  end if;
  if v_green <> 0 then
    raise exception '0282: the check stayed red on a correctly exhausted run — it cannot pass';
  end if;
  raise notice '0282: profit_allocation_exhausts_pool proved — red on the old rule (%), green on the nested rule (%)', v_red, v_green;
end $$;

do $$
declare v_n int; v_ok boolean; v_co uuid;
begin
  select id into v_co from public.companies order by created_at limit 1;
  select count(*) into v_n from public.ledger_checks(v_co);
  if v_n <> 18 then
    raise exception '0282: ledger_checks returns % rows, 18 expected (17 checks + canary)', v_n;
  end if;
  select passed into v_ok from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
  if not coalesce(v_ok, false) then
    raise exception '0282: checks_evaluated is red after the bump';
  end if;
end $$;