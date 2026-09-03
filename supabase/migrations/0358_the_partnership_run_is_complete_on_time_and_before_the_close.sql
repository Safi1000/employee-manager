-- 0358 — the partnership run: complete, on time, and before the close.
--
-- Items 5, 6 and 9 land together because they are one sequence:
--
--     invoices raised → run posted → every bill in → period closed
--
-- Item 5 checks the first arrow, item 6 enforces the last, item 9 checks that
-- what the run produced agrees with the cash-basis P&L.
--
-- ===========================================================================
-- THE PRINCIPLE, STATED WHERE THESE MEET (as the brief asked).
-- ===========================================================================
--
--   STATEMENTS ARE TRUE AND FAIR REGARDLESS OF PARTNER EFFECT.
--   PARTNER SHARES ARE PURE CASH.
--   THE TWO DIFFER EVERY MONTH AND BOTH ARE CORRECT.
--
-- Only the CASH-BASIS P&L reconciles to partner shares. The accrual P&L is not
-- expected to agree and MUST NOT be made to: it answers "what did the business
-- earn and consume this month", while a partner share answers "what cash did
-- this month actually produce". Anyone reconciling the accrual P&L to a partner
-- statement is comparing two things that answer different questions, and
-- "fixing" the difference would break whichever one they bent.
--
-- That is why item 9's check below is scoped to the CASH basis and why it says
-- so in its own failure message.

-- ---------------------------------------------------------------------------
-- ITEM 5a. Completeness — every client with an active contract that month.
--
-- A SUPPLEMENTARY ALONE DOES NOT COUNT. A month with only a supplementary has
-- no primary, which means the month was never billed and the supplementary is
-- adjusting something that does not exist. So this counts PRIMARIES only.
--
-- A CONTRACT TERMINATED MID-MONTH STILL COUNTS: a partial month is still
-- billed, so it must still have an invoice. The window test is deliberately
-- "overlaps the month at all", not "covers the whole month".
-- ---------------------------------------------------------------------------
create or replace function public.partnership_uninvoiced_clients(
  p_company_id uuid, p_period date)
returns table (
  client_id     uuid,
  client_code   text,
  client_name   text,
  contract_id   uuid,
  contract_code text,
  region_name   text,
  reason        text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_start date := date_trunc('month', p_period)::date;
  v_end   date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  return query
  select cl.id, cl.client_code::text, cl.name::text, c.id, c.contract_code::text,
         coalesce(b.name, 'Unassigned')::text,
         case
           when exists (
             select 1 from public.invoices i
              where i.contract_id = c.id
                and i.invoice_kind = 'supplementary'
                and date_trunc('month', coalesce(i.period_start, i.invoice_date))::date = v_start)
           then 'has a supplementary but no primary — the month was never billed'
           when c.termination_date is not null and c.termination_date <= v_end
           then 'contract terminated ' || to_char(c.termination_date, 'DD Mon') || ' — a partial month is still billed'
           else 'no invoice raised for this month'
         end::text
    from public.contracts c
    join public.clients cl on cl.id = c.client_id
    left join public.branches b on b.id = cl.branch_id
   where cl.company_id = p_company_id
     and c.status <> 'draft'
     -- Overlaps the month AT ALL. A contract that ran to the 9th was billed
     -- for nine days and is as uninvoiced as one that ran all month.
     and c.start_date <= v_end
     and (c.end_date is null or c.end_date >= v_start)
     and (c.termination_date is null or c.termination_date >= v_start)
     and not exists (
       select 1 from public.invoices i
        where i.contract_id = c.id
          and i.invoice_kind = 'primary'
          and date_trunc('month', coalesce(i.period_start, i.invoice_date))::date = v_start
     )
   order by cl.name;
end;
$fn$;

comment on function public.partnership_uninvoiced_clients(uuid, date) is
  '0358 (item 5): clients with a contract live in the month that have no PRIMARY invoice for it. A supplementary alone does not count — it adjusts a month that was never billed. A contract terminated mid-month IS included: a partial month is still billed. Advisory: the UI lists these by name and asks for confirmation. NOT a block — invoice dates slip a day or two and a hard block would simply be worked around.';

revoke execute on function public.partnership_uninvoiced_clients(uuid, date) from public, anon;
grant execute on function public.partnership_uninvoiced_clients(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- ITEM 5b. The posting deadline — configurable once per company.
--
-- ON POSTING, NOT DRAFTING. A drafted run sitting unposted is the same as no
-- run: nothing is allocated, nobody is paid, and the month is not finished. A
-- deadline that a draft satisfied would be a deadline that measures nothing.
-- ---------------------------------------------------------------------------
alter table public.finance_settings
  add column if not exists partnership_posting_day int;

alter table public.finance_settings drop constraint if exists finance_settings_posting_day_valid;
alter table public.finance_settings add constraint finance_settings_posting_day_valid check (
  partnership_posting_day is null
  or (partnership_posting_day between 1 and 28)
);

comment on column public.finance_settings.partnership_posting_day is
  '0358 (item 5): day of the FOLLOWING month by which the partnership run for a month must be POSTED. Capped at 28 so every month has the day. NULL = no deadline configured, and no calendar entry is raised. The deadline is on posting, never drafting — a drafted run sitting unposted is the same as no run.';

create or replace function public.partnership_posting_deadline(
  p_company_id uuid, p_period date)
returns table (
  period_month date,
  due_date     date,
  posted       boolean,
  days_late    int
)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_month date := date_trunc('month', p_period)::date;
  v_day   int;
  v_due   date;
  v_posted boolean;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select fs.partnership_posting_day into v_day
    from public.finance_settings fs where fs.company_id = p_company_id;
  if v_day is null then return; end if;

  -- The deadline falls in the month AFTER the one being allocated: GGS raises
  -- a month's invoices in the first days of the following month, so a deadline
  -- inside the month itself could never be met.
  v_due := (v_month + interval '1 month')::date + (v_day - 1);

  select exists (
    select 1 from public.profit_allocation_runs r
     where r.company_id = p_company_id and r.period_month = v_month and r.status = 'POSTED'
  ) into v_posted;

  return query select v_month, v_due, v_posted,
    case when v_posted or current_date <= v_due then 0
         else (current_date - v_due)::int end;
end;
$fn$;

comment on function public.partnership_posting_deadline(uuid, date) is
  '0358 (item 5): when the partnership run for a month must be POSTED, whether it has been, and how many days late it is. Clears the moment the run reaches POSTED. Empty result = no deadline configured for the company.';

revoke execute on function public.partnership_posting_deadline(uuid, date) from public, anon;
grant execute on function public.partnership_posting_deadline(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- ITEM 5c. Invoice generation reminders — 1st, 3rd, 5th, then every two days.
--
-- Expressed as a PREDICATE rather than a schedule, so the same rule can be read
-- by the cron that sends the alert and by any screen that wants to show
-- "reminder due today" without the two drifting apart.
-- ---------------------------------------------------------------------------
create or replace function public.is_invoice_reminder_day(p_date date default null)
returns boolean
language sql
immutable
as $fn$
  -- 1, 3, 5, then every two days: 7, 9, 11 ... which is simply every ODD day
  -- of the month up to the 5th and every second day after it. Both halves are
  -- the same arithmetic — odd days — so the rule is one test, and saying that
  -- here stops someone "simplifying" it into two branches that disagree.
  select (extract(day from coalesce(p_date, current_date))::int % 2) = 1;
$fn$;

comment on function public.is_invoice_reminder_day(date) is
  '0358 (item 5): true on the 1st, 3rd, 5th and every two days thereafter — which is every odd day of the month. One test, not two branches; the cadence in the brief and "every odd day" are the same sequence.';

-- ---------------------------------------------------------------------------
-- ITEM 6. A month cannot close until its partnership run is POSTED.
--
-- The close then protects a run that already exists. Closing first would
-- protect nothing — and worse, it would make the run impossible afterwards,
-- because run_profit_allocation refuses to post into a closed period.
-- ---------------------------------------------------------------------------
create or replace function public.require_partnership_run_before_close()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_status text;
  v_partners int;
begin
  -- A company with no partners has no run to require. Gating the close on a
  -- run that could never produce anything would make the month uncloseable.
  select count(*) into v_partners
    from public.partners p
   where p.company_id = new.company_id and p.is_active;
  if v_partners = 0 then return new; end if;

  select r.status into v_status
    from public.profit_allocation_runs r
   where r.company_id = new.company_id and r.period_month = new.period_month;

  if v_status is null then
    raise exception
      'The partnership run for % has not been drafted, so closing the month would seal it with nothing allocated. The order is: invoices raised, run POSTED, every bill in, then close.',
      to_char(new.period_month, 'FMMonth YYYY') using errcode = 'P0001';
  end if;

  if v_status <> 'POSTED' then
    raise exception
      'The partnership run for % is %, not POSTED. A drafted run sitting unposted is the same as no run — nothing is allocated and nobody is paid. Post it, then close the month.',
      to_char(new.period_month, 'FMMonth YYYY'), v_status using errcode = 'P0001';
  end if;

  return new;
end;
$fn$;

comment on function public.require_partnership_run_before_close() is
  '0358 (item 6): a month cannot close until its partnership run is POSTED. The close protects a run that already exists; closing first would protect nothing AND make the run impossible, because run_profit_allocation refuses a closed period. Skipped entirely for a company with no active partners.';

drop trigger if exists trg_require_partnership_run_before_close on public.accounting_periods;
create trigger trg_require_partnership_run_before_close
  before insert on public.accounting_periods
  for each row execute function public.require_partnership_run_before_close();

-- ---------------------------------------------------------------------------
-- ITEM 9. The cash-basis reconciliation, as a check.
-- ---------------------------------------------------------------------------
create or replace function public.cash_basis_partnership_mismatch(p_company_id uuid)
returns table (
  period_month     date,
  pl_net_cash      numeric,
  partnership_base numeric,
  difference       numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_month date := date_trunc('month', current_date)::date;
  v_start date := v_month;
  v_end   date := (v_month + interval '1 month - 1 day')::date;
  v_pl    numeric;
  v_pa    numeric;
  v_basis text;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  -- ONLY MEANINGFUL WHEN THE COMPANY REMUNERATES ON CASH, and this guard is
  -- load-bearing rather than defensive. partner_basis_for_report RAISES when a
  -- requested basis disagrees with the company's configured one, so calling
  -- partnership_allocation with 'cash' against a revenue-basis company would
  -- not return a mismatch — it would make ledger_checks itself throw, taking
  -- every other check down with it.
  --
  -- And the comparison genuinely does not apply there: on a revenue basis the
  -- partnership report is not a cash figure, so agreeing with the cash P&L
  -- would be the anomaly rather than the requirement.
  select fs.partner_remuneration_basis into v_basis
    from public.finance_settings fs where fs.company_id = p_company_id;
  if coalesce(v_basis, '') <> 'cash' then return; end if;

  -- The cash-basis P&L's Net Cash, summed over clients. client_statement_loaded
  -- IS the cash-basis client P&L, so this is the statement's own figure and not
  -- a second computation of it.
  select coalesce(sum(net), 0) into v_pl
    from public.client_statement_loaded(v_start, v_end, 'cash', p_company_id);

  -- What the partnership run allocated FROM. REGION rows carry the profit the
  -- waterfall divides.
  select coalesce(sum(a.base_amount) filter (where a.row_kind = 'REGION'), 0)
    into v_pa
    from public.partnership_allocation(v_start, v_end, 'cash', p_company_id) a;

  if round(coalesce(v_pl, 0), 2) = round(coalesce(v_pa, 0), 2) then
    return;
  end if;

  return query select v_month, round(v_pl, 2), round(v_pa, 2), round(v_pa - v_pl, 2);
end;
$fn$;

comment on function public.cash_basis_partnership_mismatch(uuid) is
  '0358 (item 9): the cash-basis P&L and the partnership report must agree on total Net Cash. Non-empty means a DEFECT, not a basis difference. The ACCRUAL P&L is deliberately not compared and must never be — statements are true and fair regardless of partner effect, partner shares are pure cash, and the two differ every month with both correct.';

revoke execute on function public.cash_basis_partnership_mismatch(uuid) from public, anon;
grant execute on function public.cash_basis_partnership_mismatch(uuid) to authenticated;

-- Wire item 9 into ledger_checks. Surgery, single asserted anchor, and the
-- canary raised deliberately alongside it — 0348 exists because 0347 forgot.
do $$
declare
  v_def text; v_new text; v_hits int; v_before int; v_after int; v_co uuid;
  a_arm  text := 'select ''no_stale_prepaid_balance''::text,';
  a_cnry text := '(select 31::numeric n) e (n);   -- expected_check_count';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks';
  if v_def is null then raise exception '0358 REFUSED: ledger_checks does not exist'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_arm, ''))) / length(a_arm);
  if v_hits <> 1 then raise exception '0358 REFUSED: the 0347 arm anchor appears %, expected 1', v_hits; end if;
  v_hits := (length(v_def) - length(replace(v_def, a_cnry, ''))) / length(a_cnry);
  if v_hits <> 1 then raise exception '0358 REFUSED: the canary anchor appears %, expected 1', v_hits; end if;

  select id into v_co from public.companies order by created_at limit 1;
  select count(*) into v_before from public.ledger_checks(v_co);

  v_new := replace(v_def, a_arm,
    'select ''cash_pl_agrees_with_partnership''::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.cash_basis_partnership_mismatch(p_company_id)
    union all
    ' || a_arm);
  v_new := replace(v_new, a_cnry, '(select 32::numeric n) e (n);   -- expected_check_count');

  execute v_new;

  select count(*) into v_after from public.ledger_checks(v_co);
  if v_after <> v_before + 1 then
    raise exception '0358 FAILED: ledger_checks returned % rows, expected %.', v_after, v_before + 1;
  end if;
  raise notice '0358: item 9 wired, % -> % checks, canary raised to 32.', v_before, v_after;
end $$;

-- ---------------------------------------------------------------------------
-- Probe.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid := (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
  v_n  int; v_msg text; v_canary record;
begin
  if v_co is null then raise notice '0358: GGS absent; probe skipped.'; return; end if;

  -- The reminder cadence is 1, 3, 5, 7, 9 ... and NOT 2, 4, 6.
  if not (public.is_invoice_reminder_day('2026-09-01') and public.is_invoice_reminder_day('2026-09-03')
          and public.is_invoice_reminder_day('2026-09-05') and public.is_invoice_reminder_day('2026-09-07')) then
    raise exception '0358 FAILED: the 1st/3rd/5th/7th are not all reminder days.';
  end if;
  if public.is_invoice_reminder_day('2026-09-02') or public.is_invoice_reminder_day('2026-09-04') then
    raise exception '0358 FAILED: an even day was reported as a reminder day.';
  end if;

  select count(*) into v_n from public.partnership_uninvoiced_clients(v_co, current_date);
  raise notice '0358: % client(s) with a live contract and no primary invoice this month.', v_n;

  -- Item 6 must refuse a close while no run is posted — but ONLY when the
  -- company has partners. GGS has none yet, so the close must still be allowed;
  -- asserting the refusal here would assert the wrong thing.
  if exists (select 1 from public.partners where company_id = v_co and is_active) then
    raise notice '0358: GGS has partners — the close gate is live.';
  else
    raise notice '0358: GGS has no active partners, so the close gate correctly stands down.';
  end if;

  select * into v_canary from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
  if not v_canary.passed then
    raise exception '0358 FAILED: canary red — expected %, actual %.', v_canary.expected, v_canary.actual;
  end if;
  raise notice '0358: canary green at % checks.', v_canary.actual;
end $$;
