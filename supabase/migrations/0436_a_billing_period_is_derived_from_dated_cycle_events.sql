-- 0436 — a billing period is derived from dated cycle events.
--
-- A client bills 25th to 25th. Everything keyed on the calendar month. This
-- gives every contract TWO cycles — billing and payroll — as effective-dated
-- events on the contract, and derives every period from them. Nothing stores a
-- period, so a gap or an overlap is not something an operator avoids by being
-- careful: it cannot be expressed.
--
-- THE END-DATE RULE. A period belongs to the month its END falls in.
--   25 Sep – 24 Oct  →  October
--   1 Sep – 30 Sep   →  September
-- Not majority (flips with month length) and not split-by-days (puts revenue
-- into a month whose partnership run has posted, and the head-office pool
-- apportions by invoiced revenue, so a short denominator moves EVERY client's
-- Net Cash). The rule never depends on day counts and matches how anyone says
-- it: "October's bill".
--
-- THE TRANSITION. A calendar client moving to the 25th on 25 September:
--   1 – 24 Sep   (short, September)
--   25 Sep – 24 Oct   (October)
-- The 25th belongs to the next period, unambiguously. DECIDED by Shayan.
--
-- WHAT CHANGES FOR A CALENDAR CLIENT: nothing. Every derived period is the
-- calendar month, every service month is the month of period_start, and the
-- probe asserts that against the contracts on the books.
--
-- PAYROLL CYCLES ARE RECORDED HERE AND NOT YET CONSUMED. The payroll_kind arm
-- of the enum exists so a payroll cycle event can be entered against a
-- contract, but nothing in payroll, attendance or verification reads it until
-- the report on what that breaks has been given. DEFERRED, on purpose, on the
-- table comment.
--
-- ONLY ONE INVOICE EXISTS ON PRODUCTION (1–30 Sep 2026, calendar). So there is
-- no backfill; there is one row to prove conformant, and the probe does.

-- ---------------------------------------------------------------------------
-- 1. THE EVENTS.
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'cycle_kind') then
    create type public.cycle_kind as enum ('billing', 'payroll');
  end if;
end $$;

create table if not exists public.contract_cycle_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  contract_id    uuid not null references public.contracts(id) on delete cascade,
  cycle_kind     public.cycle_kind not null,
  -- The first day of the first period on the new cycle.
  effective_from date not null,
  -- The day of the month each period starts on. 1 = calendar. Capped at 28 so
  -- every month has the day and no period can fail to close.
  anchor_day     integer not null,
  note           text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  constraint cycle_anchor_day_range   check (anchor_day between 1 and 28),
  -- THE EFFECTIVE DATE IS ON THE ANCHOR. A cycle that starts on the 25th starts
  -- on a 25th; anything else would make the first period an unexplainable
  -- length and the rule "the 25th belongs to the next period" false.
  constraint cycle_effective_on_anchor check (extract(day from effective_from) = anchor_day),
  constraint cycle_one_event_per_day unique (contract_id, cycle_kind, effective_from)
);

comment on table public.contract_cycle_events is
  '0436: effective-dated cycle changes on a contract. Periods are DERIVED from these by contract_periods(); nothing stores a period, so a gap or overlap cannot be expressed. billing is consumed by invoicing from 0436. payroll is DEFERRED: recorded, and not read by payroll, attendance or verification until the report on what that breaks has been given.';

create index if not exists contract_cycle_events_contract_idx
  on public.contract_cycle_events (contract_id, cycle_kind, effective_from);

alter table public.contract_cycle_events enable row level security;
drop policy if exists company_members on public.contract_cycle_events;
create policy company_members on public.contract_cycle_events for all to public
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
drop policy if exists ssa_all on public.contract_cycle_events;
create policy ssa_all on public.contract_cycle_events for all to public
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
-- The key a direct write to contracts would need. (CLAUDE.md: the table's key.)
drop policy if exists perm_write_ins on public.contract_cycle_events;
create policy perm_write_ins on public.contract_cycle_events as restrictive
  for insert to public with check (public.has_perm('contracts.edit'));
drop policy if exists perm_write_del on public.contract_cycle_events;
create policy perm_write_del on public.contract_cycle_events as restrictive
  for delete to public using (public.has_perm('contracts.edit'));
grant select, insert, delete on public.contract_cycle_events to authenticated;

-- fill company_id from the contract, the way every child table does.
create or replace function public.fill_cycle_event_company()
returns trigger language plpgsql as $fn$
begin
  if new.company_id is null then
    select company_id into new.company_id from public.contracts where id = new.contract_id;
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end $fn$;
drop trigger if exists trg_aaa_cycle_event_fill on public.contract_cycle_events;
create trigger trg_aaa_cycle_event_fill before insert on public.contract_cycle_events
  for each row execute function public.fill_cycle_event_company();

-- ---------------------------------------------------------------------------
-- 2. THE DERIVATION. One function, both kinds.
--
-- Walks from the contract start with anchor 1 (calendar), and at every event
-- cuts the running period the day before the event and restarts on the
-- event's anchor. The next period's start is the previous one's end + 1 by
-- construction, which is the whole point.
-- ---------------------------------------------------------------------------
create or replace function public.contract_periods(
  p_contract_id uuid,
  p_kind        public.cycle_kind,
  p_through     date default (current_date + 62))
returns table (period_start date, period_end date, service_month date, anchor_day integer)
language plpgsql
stable
security invoker
set search_path to 'public'
as $fn$
declare
  c        record;
  ev       record;
  v_cur    date;
  v_anchor int := 1;
  v_stop   date;       -- the day the contract stops: end or termination
  v_seg    date;       -- the last day of the current segment (event - 1) or v_stop
  v_next   date;
begin
  select * into c from public.contracts where id = p_contract_id;
  if c.id is null then return; end if;

  v_stop := least(
    coalesce(c.termination_date, 'infinity'::date),
    case when coalesce(c.is_infinite, false) then 'infinity'::date
         else coalesce(c.end_date, 'infinity'::date) end);
  v_cur := c.start_date;

  for ev in
    select x.effective_from, x.anchor_day from (
      select e.effective_from, e.anchor_day
        from public.contract_cycle_events e
       where e.contract_id = p_contract_id and e.cycle_kind = p_kind
      union all
      -- a sentinel so the loop below emits the last segment too
      select 'infinity'::date, null::int
    ) x
    order by x.effective_from
  loop
    v_seg := least(ev.effective_from - 1, v_stop);

    while v_cur <= v_seg and v_cur <= p_through loop
      -- the next anchor date strictly after v_cur
      v_next := case
        when extract(day from v_cur) < v_anchor
          then make_date(extract(year from v_cur)::int, extract(month from v_cur)::int, v_anchor)
        else (date_trunc('month', v_cur) + interval '1 month')::date + (v_anchor - 1)
      end;
      period_start := v_cur;
      period_end   := least(v_next - 1, v_seg);
      service_month := date_trunc('month', period_end)::date;
      anchor_day := v_anchor;
      return next;
      v_cur := period_end + 1;
    end loop;

    exit when ev.anchor_day is null or v_cur > p_through or v_cur > v_stop;
    v_cur    := ev.effective_from;
    v_anchor := ev.anchor_day;
  end loop;
end;
$fn$;

comment on function public.contract_periods(uuid, public.cycle_kind, date) is
  '0436: every period of a contract on one cycle, derived from contract_cycle_events. Contiguous by construction. service_month is the month the period ENDS in (the end-date rule, DECIDED). p_through is a generation horizon, not a truncation: only end_date / termination_date cut a period short.';

grant execute on function public.contract_periods(uuid, public.cycle_kind, date) to authenticated;

-- The billing periods every contract has in a month — what the Generate tab
-- reads instead of assuming the calendar.
create or replace function public.billing_periods_for_month(p_month date)
returns table (contract_id uuid, client_id uuid, period_start date, period_end date)
language sql
stable
security invoker
set search_path to 'public'
as $fn$
  select c.id, c.client_id, p.period_start, p.period_end
    from public.contracts c
    cross join lateral public.contract_periods(c.id, 'billing',
                 (date_trunc('month', p_month) + interval '2 month')::date) p
   where c.status <> 'draft'
     and p.service_month = date_trunc('month', p_month)::date
$fn$;
grant execute on function public.billing_periods_for_month(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. A CYCLE CHANGE CANNOT LAND UNDER A BILLED PERIOD.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_cycle_event()
returns trigger language plpgsql as $fn$
declare v_start date; v_billed date;
begin
  select start_date into v_start from public.contracts where id = new.contract_id;
  if v_start is null then raise exception 'No such contract.'; end if;
  if new.effective_from <= v_start then
    raise exception 'A cycle change is effective AFTER the contract starts (%). The contract''s first period always begins on its start date.', v_start;
  end if;
  if new.cycle_kind = 'billing' then
    select max(i.period_end) into v_billed
      from public.invoices i
     where i.contract_id = new.contract_id and i.invoice_kind = 'primary';
    if v_billed is not null and v_billed >= new.effective_from then
      raise exception
        'This contract is already invoiced through %. A billing cycle change effective % would move coverage under an invoice that has been raised. Make it effective after the last billed day.',
        v_billed, new.effective_from;
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_cycle_event_guard on public.contract_cycle_events;
create trigger trg_cycle_event_guard before insert on public.contract_cycle_events
  for each row execute function public.enforce_cycle_event();

create or replace function public.enforce_cycle_event_delete()
returns trigger language plpgsql as $fn$
begin
  if old.cycle_kind = 'billing' and exists (
    select 1 from public.invoices i
     where i.contract_id = old.contract_id and i.invoice_kind = 'primary'
       and i.period_end >= old.effective_from) then
    raise exception 'An invoice has been raised on a period this cycle change defines. It cannot be removed.';
  end if;
  return old;
end $fn$;
drop trigger if exists trg_cycle_event_delete on public.contract_cycle_events;
create trigger trg_cycle_event_delete before delete on public.contract_cycle_events
  for each row execute function public.enforce_cycle_event_delete();

-- ---------------------------------------------------------------------------
-- 4. THE INVOICE KNOWS ITS SERVICE MONTH. One definition, a stored column.
--
-- Thirteen functions and one index each worked out "the month this invoice
-- belongs to" from period_start. That was thirteen copies of a rule that has
-- now changed. The column is the one copy; the functions below are amended to
-- read it.
-- ---------------------------------------------------------------------------
create or replace function public.invoice_service_month(p_start date, p_end date, p_invoice_date date)
returns date language sql immutable as $fn$
  select date_trunc('month', coalesce(p_end, p_start, p_invoice_date))::date
$fn$;

alter table public.invoices
  add column if not exists service_month date
    generated always as (public.invoice_service_month(period_start, period_end, invoice_date)) stored;

comment on column public.invoices.service_month is
  '0436: the month this invoice''s revenue belongs to — the month its period ENDS in (the end-date rule). Generated; nothing writes it. Every function that used to derive the month from period_start reads this instead.';

-- ONE PRIMARY INVOICE PER CONTRACT PER PERIOD. The old index keyed on the month
-- of period_start, which refuses the transition month — 1–24 Sep and 25 Sep–24
-- Oct both START in September and are two periods, two invoices.
drop index if exists public.uq_invoice_contract_month;
create unique index if not exists uq_invoice_contract_period
  on public.invoices (contract_id, coalesce(period_start, invoice_date))
  where contract_id is not null and invoice_kind = 'primary';

-- AN INVOICE COVERS A DERIVED PERIOD, EXACTLY. This is what makes billing a day
-- twice or missing one structurally impossible rather than avoided.
create or replace function public.enforce_invoice_matches_period()
returns trigger language plpgsql as $fn$
declare v_ok boolean; v_expected text;
begin
  if public.is_maintenance_session() then return new; end if;
  if new.contract_id is null or new.invoice_kind <> 'primary' or new.period_start is null then
    return new;
  end if;
  select exists (
    select 1 from public.contract_periods(new.contract_id, 'billing', new.period_end)
     where period_start = new.period_start and period_end = new.period_end)
    into v_ok;
  if not v_ok then
    select string_agg(to_char(period_start, 'DD Mon') || ' – ' || to_char(period_end, 'DD Mon YYYY'), ', ')
      into v_expected
      from public.contract_periods(new.contract_id, 'billing', new.period_end + 40)
     where service_month between date_trunc('month', new.period_start)::date
                             and date_trunc('month', coalesce(new.period_end, new.period_start))::date;
    raise exception
      'This invoice covers % – %, which is not a billing period of its contract. The contract''s periods around then are: %. Coverage comes from the contract''s billing cycle, not from the invoice.',
      new.period_start, new.period_end, coalesce(v_expected, 'none — the contract is not in force then');
  end if;
  return new;
end $fn$;
drop trigger if exists trg_invoice_matches_period on public.invoices;
create trigger trg_invoice_matches_period
  before insert or update of period_start, period_end, contract_id on public.invoices
  for each row execute function public.enforce_invoice_matches_period();

-- ---------------------------------------------------------------------------
-- 5. SURGERY on every reader of "the invoice's month". Each anchor is asserted
-- to appear exactly the number of times it was counted against the live
-- definitions when this was written; any other count refuses.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.surg(p_fn text, p_old text, p_new text, p_expect int)
returns void language plpgsql as $fn$
declare v_def text; v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  if v_def is null then raise exception '0436 REFUSED: % does not exist.', p_fn; end if;
  v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  if v_hits <> p_expect then
    raise exception '0436 REFUSED: in %, the anchor appears % time(s), expected %. Do not widen it. Anchor began: %',
      p_fn, v_hits, p_expect, left(p_old, 70);
  end if;
  execute replace(v_def, p_old, p_new);
end $fn$;

select pg_temp.surg('branch_revenue_for_month',          'coalesce(i.period_start, i.invoice_date)', 'i.service_month', 2);
select pg_temp.surg('client_statement_loaded',           'coalesce(i.period_start, i.invoice_date)', 'i.service_month', 1);
select pg_temp.surg('enforce_ho_exclusion_leaves_a_base','coalesce(i.period_start, i.invoice_date)', 'i.service_month', 2);
select pg_temp.surg('ho_apportionment_driver',           'coalesce(i.period_start, i.invoice_date)', 'i.service_month', 2);
select pg_temp.surg('ho_exclusion_preview',              'coalesce(i.period_start, i.invoice_date)', 'i.service_month', 2);
select pg_temp.surg('profit_allocation_review',          'coalesce(i.period_start, i.invoice_date)', 'i.service_month', 1);

-- The reversal date on edit/delete, and period_end joins the list of edits that
-- re-post — the service month now depends on it.
select pg_temp.surg('journal_on_invoice', 'coalesce(old.period_start, old.invoice_date)', 'old.service_month', 2);
select pg_temp.surg('journal_on_invoice',
  'or old.period_start is distinct from new.period_start',
  'or old.period_start is distinct from new.period_start
       or old.period_end   is distinct from new.period_end', 1);

-- The posting date, and the advance test: an invoice is "in advance" when it is
-- raised before the month its revenue belongs to. For a calendar client that is
-- byte-for-byte what it was.
select pg_temp.surg('post_invoice_journal', 'v_date    := coalesce(inv.period_start, inv.invoice_date);', 'v_date    := inv.service_month;', 1);
select pg_temp.surg('post_invoice_journal', 'if inv.period_start is not null and inv.invoice_date < inv.period_start then', 'if inv.period_start is not null and inv.invoice_date < inv.service_month then', 1);

select pg_temp.surg('recognise_advance_revenue', 'and i.invoice_date < i.period_start', 'and i.invoice_date < i.service_month', 1);
select pg_temp.surg('recognise_advance_revenue', 'and date_trunc(''month'', i.period_start)::date = v_period', 'and i.service_month = v_period', 1);
select pg_temp.surg('recognise_advance_revenue', 'inv.company_id, inv.period_start,', 'inv.company_id, inv.service_month,', 1);

select pg_temp.surg('revenue_outside_service_month', 'date_trunc(''month'', i.period_start)::date', 'i.service_month', 2);

-- BEFORE trigger: a generated column is not yet computed on NEW, so the same
-- immutable function the column uses is called directly.
select pg_temp.surg('enforce_supplementary_matches_primary',
  'date_trunc(''month'', coalesce(period_start, invoice_date))::date as m', 'service_month as m', 1);
select pg_temp.surg('enforce_supplementary_matches_primary',
  'date_trunc(''month'', coalesce(new.period_start, new.invoice_date))::date',
  'public.invoice_service_month(new.period_start, new.period_end, new.invoice_date)', 1);

-- The auto-issuer raised every invoice for the calendar month. It now asks the
-- contract which period ends in that month, and falls back to the calendar only
-- when it could not name a contract (which it already leaves null, never guessed).
select pg_temp.surg('run_auto_invoices', '  issued int := 0;', '  issued int := 0;
  v_ps date;
  v_pe date;', 1);
select pg_temp.surg('run_auto_invoices',
  '      v_period, (v_period + interval ''1 month'' - interval ''1 day'')::date,',
  '      v_ps, v_pe,', 1);
select pg_temp.surg('run_auto_invoices',
  '    inv_number := public.next_invoice_number(rec.company_id, v_period);',
  '    inv_number := public.next_invoice_number(rec.company_id, v_period);

    -- 0436: the period comes from the contract''s billing cycle.
    v_ps := v_period; v_pe := (v_period + interval ''1 month'' - interval ''1 day'')::date;
    if v_contract is not null then
      select p.period_start, p.period_end into v_ps, v_pe
        from public.contract_periods(v_contract, ''billing'', (v_period + interval ''2 month'')::date) p
       where p.service_month = v_period
       order by p.period_start desc limit 1;
      if v_ps is null then continue; end if;
    end if;', 1);

-- ---------------------------------------------------------------------------
-- 6. THE COMPLETENESS CHECK IS PERIOD-BASED. A contract is uninvoiced for a
-- month when a billing period ENDING in that month has no primary invoice on
-- it. A period ending on the 24th and invoiced on the 25th has its invoice by
-- the time anyone runs the month; a period that ended with no invoice is what
-- is reported.
--
-- ONE AUTHOR (0287-era), full text in the repo, so it is restated — behind the
-- digest of the body it replaces.
-- ---------------------------------------------------------------------------
do $$
declare v_md5 text;
begin
  select md5(pg_get_functiondef(oid)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace and proname = 'partnership_uninvoiced_clients';
  if v_md5 <> '6a8474f994573fff24452f83338792b2' then
    raise exception '0436 REFUSED: partnership_uninvoiced_clients is not the body this restatement was written against (md5 %). A third edit nobody recorded — do not restate over it.', v_md5;
  end if;
end $$;

create or replace function public.partnership_uninvoiced_clients(p_company_id uuid, p_period date)
returns table(client_id uuid, client_code text, client_name text, contract_id uuid, contract_code text, region_name text, reason text)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
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
                and i.service_month = v_start)
           then 'has a supplementary but no primary — the period was never billed'
           when c.termination_date is not null and c.termination_date <= v_end
           then 'contract terminated ' || to_char(c.termination_date, 'DD Mon') || ' — a partial period is still billed'
           when p.period_start <> v_start or p.period_end <> v_end
           then 'no invoice raised for ' || to_char(p.period_start, 'DD Mon') || ' – ' || to_char(p.period_end, 'DD Mon')
           else 'no invoice raised for this month'
         end::text
    from public.contracts c
    join public.clients cl on cl.id = c.client_id
    left join public.branches b on b.id = cl.branch_id
    -- 0436: every billing period ending in the month, not the month itself.
    cross join lateral public.contract_periods(c.id, 'billing', (v_end + 40)::date) p
   where cl.company_id = p_company_id
     and c.status <> 'draft'
     and p.service_month = v_start
     and not exists (
       select 1 from public.invoices i
        where i.contract_id = c.id
          and i.invoice_kind = 'primary'
          and i.period_start = p.period_start
     )
   order by cl.name, p.period_start;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. THE CHECK THAT NEVER GOES QUIET. For every non-draft contract, the derived
-- periods start on the contract start, are contiguous, and do not overlap.
-- Derivation makes this true by construction; the check exists so that a
-- change to contract_periods() that breaks it is red that night rather than
-- discovered on an invoice.
-- ---------------------------------------------------------------------------
create or replace function public.billing_period_gaps(p_company_id uuid)
returns table(contract_id uuid, contract_code text, cycle_kind text, at_date date, reason text)
language plpgsql
stable security definer
set search_path to 'public'
as $fn$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  return query
  with k as (select unnest(enum_range(null::public.cycle_kind)) as kind),
  per as (
    select c.id, c.contract_code, c.start_date, k.kind, p.period_start, p.period_end,
           lag(p.period_end) over (partition by c.id, k.kind order by p.period_start) as prev_end,
           row_number() over (partition by c.id, k.kind order by p.period_start) as rn
      from public.contracts c
      cross join k
      cross join lateral public.contract_periods(c.id, k.kind, current_date + 62) p
     where c.company_id = p_company_id and c.status <> 'draft'
  )
  select per.id, per.contract_code::text, per.kind::text, per.period_start,
         case
           when per.rn = 1 and per.period_start <> per.start_date then 'first period does not start on the contract start'
           when per.prev_end is not null and per.period_start > per.prev_end + 1 then 'gap before this period'
           when per.prev_end is not null and per.period_start <= per.prev_end then 'overlaps the previous period'
           when per.period_end < per.period_start then 'period ends before it starts'
         end::text
    from per
   where (per.rn = 1 and per.period_start <> per.start_date)
      or (per.prev_end is not null and per.period_start <> per.prev_end + 1)
      or per.period_end < per.period_start
   order by per.contract_code, per.kind, per.period_start;
end;
$fn$;

-- ledger_checks: SURGERY, anchor asserted once, canary counted then bumped.
do $$
declare
  v_def text; v_new text; v_hits int; v_co uuid; v_real int; v_passed boolean;
  a_ins text := 'select ''monthly_ledger_run_is_current''::text,';
  a_can text := 'from (select 37::numeric n) e (n);   -- expected_check_count';
begin
  select id into v_co from public.companies where active and archived_at is null order by created_at limit 1;
  if v_co is null then raise exception '0436 REFUSED: no company to count against.'; end if;

  select count(*) into v_real from public.ledger_checks(v_co) where check_name <> 'checks_evaluated';
  if v_real <> 37 then
    raise exception '0436 REFUSED: ledger_checks evaluates % real checks, not the 37 this was written against. Count again and write THAT number.', v_real;
  end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks';
  v_hits := (length(v_def) - length(replace(v_def, a_ins, ''))) / length(a_ins);
  if v_hits <> 1 then raise exception '0436 REFUSED: ledger_checks insertion anchor appears % time(s).', v_hits; end if;
  v_hits := (length(v_def) - length(replace(v_def, a_can, ''))) / length(a_can);
  if v_hits <> 1 then raise exception '0436 REFUSED: the canary literal 37 appears % time(s).', v_hits; end if;

  v_new := replace(v_def, a_ins,
    'select ''billing_periods_are_contiguous''::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.billing_period_gaps(p_company_id)
    union all
    ' || a_ins);
  v_new := replace(v_new, a_can, 'from (select 38::numeric n) e (n);   -- expected_check_count');
  execute v_new;

  -- ASSERT ON THE THING THAT CAN BREAK: the canary's own verdict, and the new
  -- check's own verdict.
  select passed into v_passed from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
  if v_passed is not true then raise exception '0436 FAILED: checks_evaluated is not green after the bump.'; end if;
  select passed into v_passed from public.ledger_checks(v_co) where check_name = 'billing_periods_are_contiguous';
  if v_passed is not true then raise exception '0436 FAILED: billing_periods_are_contiguous is red on arrival.'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. THE ONE INVOICE ON THE BOOKS CONFORMS. Asserted, not assumed: the trigger
-- above only fires on new rows, so an existing row that did not match would
-- sit there unnoticed until somebody edited it.
-- ---------------------------------------------------------------------------
do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from public.invoices i
   where i.contract_id is not null and i.invoice_kind = 'primary' and i.period_start is not null
     and not exists (select 1 from public.contract_periods(i.contract_id, 'billing', i.period_end) p
                      where p.period_start = i.period_start and p.period_end = i.period_end);
  if v_bad <> 0 then
    raise exception '0436 REFUSED: % existing primary invoice(s) do not cover a derived billing period of their contract. They must be reconciled before coverage can be enforced.', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 9. THE PROBE. Rolled back. It asserts the transition itself — the one case
-- this has to get right — and that a calendar contract is unchanged.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid; v_con uuid; v_uid uuid; r record; v_n int; v_txt text;
begin
  select id into v_co from public.companies where active and archived_at is null order by created_at limit 1;
  select p.id into v_uid from public.profiles p where p.company_id = v_co
   and p.role in ('super_admin','super_super_admin') order by p.role limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  -- A calendar contract started on the 1st: every period is the calendar month.
  select c.id into v_con from public.contracts c
   where c.company_id = v_co and c.status = 'active' and extract(day from c.start_date) = 1
   order by c.start_date limit 1;
  if v_con is not null then
    select count(*) into v_n from public.contract_periods(v_con, 'billing', current_date)
     where extract(day from period_start) <> 1
        or period_end <> (date_trunc('month', period_start) + interval '1 month - 1 day')::date
        or service_month <> period_start;
    if v_n <> 0 then
      raise exception '0436 PROBE FAILED: a calendar contract derived % non-calendar period(s).', v_n;
    end if;
  end if;

  -- THE TRANSITION. A contract on the calendar moves to the 25th. The probe
  -- plays it in June rather than September so the posting lands in a month
  -- that has been reached — 0322 refuses a posting into a future period, and
  -- the live case's October entry is raised on 25 October, when it has been.
  insert into public.contracts (company_id, client_id, contract_code, contract_type, start_date,
                                is_infinite, status)
  select v_co, (select id from public.clients where company_id = v_co limit 1),
         '0436-PROBE', 'services', '2026-01-01', true, 'active'
  returning id into v_con;

  insert into public.contract_cycle_events (contract_id, cycle_kind, effective_from, anchor_day)
  values (v_con, 'billing', '2026-06-25', 25);

  select string_agg(period_start::text || '..' || period_end::text || '=' || to_char(service_month, 'Mon'), ' ' order by period_start)
    into v_txt
    from public.contract_periods(v_con, 'billing', '2026-08-30')
   where period_start >= '2026-05-01';

  if v_txt <> '2026-05-01..2026-05-31=May 2026-06-01..2026-06-24=Jun 2026-06-25..2026-07-24=Jul 2026-07-25..2026-08-24=Aug 2026-08-25..2026-09-24=Sep' then
    raise exception '0436 PROBE FAILED: the transition derived "%".', v_txt;
  end if;

  -- The gap check sees nothing wrong with it.
  select count(*) into v_n from public.billing_period_gaps(v_co) g where g.contract_id = v_con;
  if v_n <> 0 then raise exception '0436 PROBE FAILED: the gap check reports % row(s) on a contiguous contract.', v_n; end if;

  -- An invoice for the calendar month is REFUSED on this contract.
  begin
    insert into public.invoices (company_id, client_id, contract_id, invoice_number, invoice_date,
                                 invoice_amount, period_start, period_end, status)
    select v_co, client_id, v_con, '0436-PROBE-1', '2026-07-25', 100, '2026-07-01', '2026-07-31', 'Pending'
      from public.contracts where id = v_con;
    raise exception '0436 PROBE FAILED: a calendar-month invoice was accepted on a 25th-cycle contract.';
  exception when others then
    if sqlerrm not like '%not a billing period of its contract%' then raise; end if;
  end;

  -- The right one is accepted, and lands in July.
  insert into public.invoices (company_id, client_id, contract_id, invoice_number, invoice_date,
                               invoice_amount, period_start, period_end, status)
  select v_co, client_id, v_con, '0436-PROBE-2', '2026-07-25', 100, '2026-06-25', '2026-07-24', 'Pending'
    from public.contracts where id = v_con;
  select service_month::text into v_txt from public.invoices where invoice_number = '0436-PROBE-2';
  if v_txt <> '2026-07-01' then raise exception '0436 PROBE FAILED: 25 Jun – 24 Jul landed in %, expected July.', v_txt; end if;

  -- And its revenue posted to July, not June.
  select count(*) into v_n
    from public.journal_entries je join public.invoices i on i.id = je.source_id
   where je.source_table = 'invoices' and i.invoice_number = '0436-PROBE-2' and je.entry_date = '2026-07-01';
  if v_n <> 1 then raise exception '0436 PROBE FAILED: the July invoice posted % entr(ies) dated 1 Jul, expected 1.', v_n; end if;

  -- A cycle change under that invoice is refused.
  begin
    insert into public.contract_cycle_events (contract_id, cycle_kind, effective_from, anchor_day)
    values (v_con, 'billing', '2026-07-15', 15);
    raise exception '0436 PROBE FAILED: a cycle change under a billed period was accepted.';
  exception when others then
    if sqlerrm not like '%already invoiced through%' then raise; end if;
  end;

  -- The completeness check names the SHORT period, not "September".
  select string_agg(reason, ' | ') into v_txt
    from public.partnership_uninvoiced_clients(v_co, '2026-06-01') u where u.contract_id = v_con;
  if v_txt not like '%01 Jun – 24 Jun%' then
    raise exception '0436 PROBE FAILED: the completeness check said "%" for the short period.', v_txt;
  end if;

  raise exception 'ROLLBACK_PROBE';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    perform set_config('request.jwt.claim.sub', null, true);
    if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
    raise notice '0436 probe passed: 1–24 Jun, 25 Jun–24 Jul, July revenue, calendar invoice refused.';
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0436 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
