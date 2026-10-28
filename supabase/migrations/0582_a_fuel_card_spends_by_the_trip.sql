-- 0582 — a fuel card spends by the trip
--
-- DECIDED 2026-10-28 (Shayan): "actual spend will now be directly recorded in
-- bastion by both km travelled / average gained / petrol price or simply by
-- adding the amount of petrol spend on that trip to xyz client" — one sheet
-- per card per month (Zafar's, Zamir's; Lahore its own card) — "build the
-- system UI everything properly". A fuel sheet is the detail of what the card
-- spent; it is never a top-up (0581). A top-up is only money really loaded.
--
-- What this adds:
--   * fuel_cards.km_per_litre — the vehicle's average, set per card; a trip
--     takes it unless its own is given.
--   * fuel_trips — one row per trip: date, route, purpose, client, km, average,
--     petrol price, amount, and the card bill (expense) it posted. The amount
--     is km ÷ average × price when km and price are given, else typed.
--   * record_fuel_trip / delete_fuel_trip — a trip IS a card bill
--     (record_fuel_card_bill, so every statement, the partnership and the
--     ledger read it where they read any other expense); deleting a trip
--     deletes its bill through delete_expense (journal reversed).
--   * set_fuel_card_average.
--   * fuel_card_statement(card, from, to) — the card's sheet: the opening
--     balance at `from`, then every top-up and every spend (trip detail where
--     there is one) with a running balance. What the screen and the Fuel
--     Expense Sheet PDF print, so neither adds anything up.
--   * fuel_card_match_attock(card) — after a tally with Attock: if Attock shows
--     MORE spent than the trips, the difference is booked as "Fuel — no bill"
--     (book_unbilled_fuel, 0547); if LESS, the trips since the previous tally
--     are scaled down, each in proportion, to what Attock actually charged —
--     the card then equals Attock and every client keeps its share.
--   * Zafar's four bills of 24–27 Oct (0572) become trips — 36, 39, 43 and
--     16.4 km at 379.14, average 30 km/l — so they show as trips; amounts
--     unchanged. His card's average is set to 30 (the sheet's own).
--
-- Asserted: the four trips link the four bills and total 1,698.54; the card's
-- statement from 23 Oct opens at 2,277.74 and runs to 579.20; a test trip by
-- km posts km ÷ average × price and its deletion takes its bill with it (in a
-- block rolled back by a sentinel whose message is checked); no tenant or
-- branch guard gaps.

alter table public.fuel_cards add column if not exists km_per_litre numeric check (km_per_litre is null or km_per_litre > 0);
comment on column public.fuel_cards.km_per_litre is
  '0582: the vehicle''s average (km per litre). A trip by km uses it unless the trip gives its own.';

create table if not exists public.fuel_trips (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  fuel_card_id  uuid not null references public.fuel_cards(id),
  expense_id    uuid not null unique references public.expenses(id) on delete cascade,
  trip_date     date not null,
  route         text,
  purpose       text,
  client_id     uuid references public.clients(id),
  km            numeric check (km is null or km > 0),
  km_per_litre  numeric check (km_per_litre is null or km_per_litre > 0),
  petrol_price  numeric check (petrol_price is null or petrol_price > 0),
  amount        numeric not null check (amount > 0),
  created_by    uuid references auth.users(id) default auth.uid(),
  created_at    timestamptz not null default now()
);
comment on table public.fuel_trips is
  '0582: a trip on a company fuel card — the line of the monthly Fuel Expense Sheet. It IS a card bill (expense_id); its amount is km ÷ average × petrol price, or typed. Written only through record_fuel_trip / delete_fuel_trip.';
create index if not exists fuel_trips_card_date on public.fuel_trips (fuel_card_id, trip_date);

alter table public.fuel_trips enable row level security;
drop policy if exists company_members on public.fuel_trips;
create policy company_members on public.fuel_trips for select using (company_id = current_company_id());
drop policy if exists ssa_all on public.fuel_trips;
create policy ssa_all on public.fuel_trips for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());

-- ── the vehicle's average ───────────────────────────────────────────────────
create or replace function public.set_fuel_card_average(p_fuel_card_id uuid, p_km_per_litre numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
  declare c public.fuel_cards; v_n int;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
    -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
    if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
    select * into c from public.fuel_cards where id = p_fuel_card_id;
    if c.id is null or c.role <> 'float' then raise exception 'An average is set on a company float card only. Nothing has been changed.' using errcode = 'P0001'; end if;
    perform public.assert_branch_writable(c.branch_id);
    if p_km_per_litre is not null and p_km_per_litre <= 0 then raise exception 'The average must be more than zero. Nothing has been changed.' using errcode = 'P0001'; end if;
    update public.fuel_cards set km_per_litre = p_km_per_litre, updated_at = now() where id = c.id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'The card could not be updated. Nothing has been changed.' using errcode = 'P0001'; end if;
  end $$;
revoke all on function public.set_fuel_card_average(uuid, numeric) from public, anon;
grant execute on function public.set_fuel_card_average(uuid, numeric) to authenticated;

-- ── a trip ──────────────────────────────────────────────────────────────────
create or replace function public.record_fuel_trip(
  p_fuel_card_id uuid, p_trip_date date, p_route text, p_client_id uuid default null,
  p_amount numeric default null, p_km numeric default null, p_km_per_litre numeric default null,
  p_petrol_price numeric default null, p_purpose text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
  declare c public.fuel_cards; v_kmpl numeric; v_amt numeric; v_cat uuid; v_exp uuid; v_id uuid; v_desc text; v_branch uuid;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
    -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
    if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
    if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
    select * into c from public.fuel_cards where id = p_fuel_card_id;
    if c.id is null or c.role <> 'float' or not c.is_active then
      raise exception 'A trip is spent on an active company float card. Nothing has been recorded.' using errcode = 'P0001';
    end if;
    if p_trip_date is null then raise exception 'Enter the date of the trip. Nothing has been recorded.' using errcode = 'P0001'; end if;
    if nullif(btrim(coalesce(p_route, '')), '') is null then raise exception 'Enter the route (e.g. GGS – Emaar – PCI & back). Nothing has been recorded.' using errcode = 'P0001'; end if;

    v_kmpl := coalesce(p_km_per_litre, c.km_per_litre);
    if p_km is not null or p_petrol_price is not null then
      if p_km is null or p_km <= 0 then raise exception 'Enter the km travelled. Nothing has been recorded.' using errcode = 'P0001'; end if;
      if p_petrol_price is null or p_petrol_price <= 0 then raise exception 'Enter the petrol price that day. Nothing has been recorded.' using errcode = 'P0001'; end if;
      if v_kmpl is null then raise exception 'Set the vehicle''s average (km per litre) on the card, or give it for this trip. Nothing has been recorded.' using errcode = 'P0001'; end if;
      v_amt := round(p_km / v_kmpl * p_petrol_price, 2);
    else
      v_amt := round(p_amount, 2);
    end if;
    if v_amt is null or v_amt <= 0 then raise exception 'Enter the km and petrol price, or the amount spent. Nothing has been recorded.' using errcode = 'P0001'; end if;

    select id into v_cat from public.expense_categories where company_id = c.company_id and name = 'Transportation & Fuel';
    if v_cat is null then raise exception 'The expense category "Transportation & Fuel" is missing.' using errcode = 'P0001'; end if;
    v_branch := coalesce((select branch_id from public.clients where id = p_client_id), c.branch_id);
    v_desc := btrim(p_route)
      || case when p_km is not null then ' · ' || trim(to_char(p_km, 'FM999990.##')) || ' km @ ' || trim(to_char(p_petrol_price, 'FM999990.00')) else '' end
      || coalesce(' · ' || nullif(btrim(p_purpose), ''), '');
    v_exp := public.record_fuel_card_bill(c.id, v_amt, p_trip_date, v_cat, p_client_id, v_branch, v_desc);

    insert into public.fuel_trips (company_id, fuel_card_id, expense_id, trip_date, route, purpose, client_id, km, km_per_litre, petrol_price, amount)
    values (c.company_id, c.id, v_exp, p_trip_date, btrim(p_route), nullif(btrim(p_purpose), ''), p_client_id,
            p_km, case when p_km is not null then v_kmpl end, p_petrol_price, v_amt)
    returning id into v_id;
    return v_id;
  end $$;
revoke all on function public.record_fuel_trip(uuid, date, text, uuid, numeric, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.record_fuel_trip(uuid, date, text, uuid, numeric, numeric, numeric, numeric, text) to authenticated;

create or replace function public.delete_fuel_trip(p_trip_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
  declare t public.fuel_trips;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
    -- tenant guard [resolved]: owning company from p_trip_id via public.fuel_trips
    if p_trip_id is not null then perform public.assert_same_company((select company_id from public.fuel_trips where id = p_trip_id)); end if;
    select * into t from public.fuel_trips where id = p_trip_id for update;
    if t.id is null then raise exception 'That trip does not exist. Nothing has been changed.' using errcode = 'P0001'; end if;
    perform public.assert_branch_writable((select branch_id from public.fuel_cards where id = t.fuel_card_id));
    perform public.delete_expense(t.expense_id);   -- the trip row goes with it (on delete cascade)
    if exists (select 1 from public.fuel_trips where id = t.id) then
      raise exception 'The trip''s bill could not be deleted. Nothing has been changed.' using errcode = 'P0001';
    end if;
  end $$;
revoke all on function public.delete_fuel_trip(uuid) from public, anon;
grant execute on function public.delete_fuel_trip(uuid) to authenticated;

-- ── the card's sheet ────────────────────────────────────────────────────────
create or replace function public.fuel_card_statement(p_fuel_card_id uuid, p_from date, p_to date)
returns table (entry_date date, kind text, detail text, client_name text, km numeric, km_per_litre numeric,
               petrol_price numeric, loaded numeric, spent numeric, balance numeric, trip_id uuid, expense_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
  declare c public.fuel_cards; v_open numeric;
  begin
    -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
    if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
    select * into c from public.fuel_cards where id = p_fuel_card_id;
    if c.id is null then return; end if;
    select coalesce(sum(jl.debit - jl.credit), 0) into v_open
      from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
     where jl.account_id = c.coa_account_id and je.entry_date < p_from;
    return query
    with m as (
      select je.entry_date as d, 0 as ord, 'OPENING'::text as k,
             coalesce(nullif(je.description, ''), 'Opening balance') as det, null::text as cl,
             null::numeric as km_, null::numeric as kmpl, null::numeric as pr,
             greatest(jl.debit - jl.credit, 0) as ld, greatest(jl.credit - jl.debit, 0) as sp, null::uuid as tid, null::uuid as eid
        from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
       where jl.account_id = c.coa_account_id and je.entry_date between p_from and p_to
         and coalesce(je.source_table, '') not in ('expenses', 'fuel_card_loads')
      union all
      select l.loaded_on, 1, 'TOP-UP',
             'Top-up from ' || coalesce((select b.bank_name from public.bank_accounts b where b.id = l.bank_account_id),
                                        (select cl.name || '''s cash' from public.cash_locations cl where cl.id = l.custodian_location_id), '—')
               || coalesce(' · ' || l.note, ''),
             null, null, null, null, l.amount, 0, null, null
        from public.fuel_card_loads l where l.fuel_card_id = c.id and l.loaded_on between p_from and p_to
      union all
      select e.expense_date, 2, case when t.id is not null then 'TRIP' else 'BILL' end,
             coalesce(t.route || coalesce(' · ' || t.purpose, ''), e.description),
             (select cl.name from public.clients cl where cl.id = e.client_id),
             t.km, t.km_per_litre, t.petrol_price, 0, e.amount, t.id, e.id
        from public.expenses e left join public.fuel_trips t on t.expense_id = e.id
       where e.fuel_card_id = c.id and e.payment_mode = 'Card' and e.expense_date between p_from and p_to
    )
    select null::date, 'OPENING_BALANCE'::text, 'Balance brought forward'::text, null::text, null::numeric, null::numeric,
           null::numeric, null::numeric, null::numeric, v_open, null::uuid, null::uuid
    union all
    select x.d, x.k, x.det, x.cl, x.km_, x.kmpl, x.pr, x.ld, x.sp,
           v_open + sum(x.ld - x.sp) over (order by x.d, x.ord, x.eid rows between unbounded preceding and current row),
           x.tid, x.eid
      from m x;
  end $$;
revoke all on function public.fuel_card_statement(uuid, date, date) from public, anon;
grant execute on function public.fuel_card_statement(uuid, date, date) to authenticated;

-- ── matching the card to Attock ─────────────────────────────────────────────
create or replace function public.fuel_card_match_attock(p_fuel_card_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
  declare c public.fuel_cards; b record; v_gap numeric; v_prev date; v_total numeric; v_target numeric; v_n int;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
    -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
    if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
    select * into c from public.fuel_cards where id = p_fuel_card_id;
    if c.id is null or c.role <> 'float' or not c.is_active then raise exception 'Only an active company float card is matched to Attock.' using errcode = 'P0001'; end if;
    perform public.assert_branch_writable(c.branch_id);
    select * into b from public.fuel_card_balances(c.company_id) x where x.fuel_card_id = c.id;
    if b.reading_as_of is null then raise exception 'Tally the card with Attock first.' using errcode = 'P0001'; end if;
    v_gap := round(b.balance_on_reading - b.portal_balance, 2);
    if v_gap = 0 then return 'The card already agrees with Attock.'; end if;
    if v_gap > 0 then
      perform public.book_unbilled_fuel(c.id);
      return 'Attock shows PKR ' || to_char(v_gap, 'FM999,999,990.00') || ' more spent than the trips: booked as "Fuel — no bill".';
    end if;
    -- The trips come to more than Attock charged: scale the trips since the
    -- previous tally down, each in proportion, to what Attock charged.
    select max(r.as_of) into v_prev from public.fuel_card_readings r where r.fuel_card_id = c.id and r.as_of < b.reading_as_of;
    select coalesce(sum(t.amount), 0) into v_total from public.fuel_trips t
     where t.fuel_card_id = c.id and t.trip_date > coalesce(v_prev, '-infinity'::date) and t.trip_date <= b.reading_as_of;
    v_target := v_total + v_gap;   -- v_gap < 0
    if v_total <= 0 or v_target <= 0 then
      raise exception 'The trips since % come to PKR %, which cannot carry a reduction of PKR %. Check for a bill entered twice or against the wrong card.',
        coalesce(to_char(v_prev, 'DD Mon YYYY'), 'the card''s start'), to_char(v_total, 'FM999,999,990.00'), to_char(-v_gap, 'FM999,999,990.00') using errcode = 'P0001';
    end if;
    -- largest remainder, at the paisa, so the trips add to the target exactly
    create temp table _fm on commit drop as
      with s as (
        select t.id, t.expense_id, t.amount * v_target / v_total as exact from public.fuel_trips t
         where t.fuel_card_id = c.id and t.trip_date > coalesce(v_prev, '-infinity'::date) and t.trip_date <= b.reading_as_of
      ), f as (
        select id, expense_id, floor(exact * 100) / 100 as base, exact * 100 - floor(exact * 100) as frac from s
      ), r as (
        select f.*, row_number() over (order by frac desc, id) as rk from f
      )
      select r.id, r.expense_id,
             r.base + case when r.rk <= round((v_target - (select sum(base) from f)) * 100) then 0.01 else 0 end as amt
        from r;
    update public.expenses e set amount = m.amt,
           description = e.description || ' · scaled to Attock ' || to_char(b.reading_as_of, 'DD Mon')
      from _fm m where e.id = m.expense_id;
    update public.fuel_trips t set amount = m.amt from _fm m where t.id = m.id;
    get diagnostics v_n = row_count;
    return v_n || ' trip(s) since ' || coalesce(to_char(v_prev, 'DD Mon YYYY'), 'the card''s start') || ' scaled from PKR '
      || to_char(v_total, 'FM999,999,990.00') || ' to PKR ' || to_char(v_target, 'FM999,999,990.00') || ' — what Attock charged.';
  end $$;
revoke all on function public.fuel_card_match_attock(uuid) from public, anon;
grant execute on function public.fuel_card_match_attock(uuid) to authenticated;

-- ── Zafar's 24–27 Oct bills become trips ────────────────────────────────────
do $mig$
declare
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_card uuid := (select id from public.fuel_cards where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and card_last4 = '7724');
  v_n int; v_total numeric; v_last numeric; v_open numeric; v_msg text; v_tid uuid; v_amt numeric;
begin
  if exists (select 1 from public.fuel_trips where fuel_card_id = v_card) then return; end if;  -- replay
  update public.fuel_cards set km_per_litre = 30 where id = v_card and km_per_litre is null;

  insert into public.fuel_trips (company_id, fuel_card_id, expense_id, trip_date, route, client_id, km, km_per_litre, petrol_price, amount)
  select e.company_id, e.fuel_card_id, e.id, e.expense_date,
         case e.expense_date
           when '2026-10-24' then 'GGS – Raising Sun & back, GGS – Dolmen & back'
           when '2026-10-25' then 'GGS – Emaar – AWT – Dolmen – GGS'
           when '2026-10-26' then 'GGS – Humak PS – Dolmen – DHA-3 – MIU – AWT – Emaar – Dolmen City'
           when '2026-10-27' then 'GGS – Sweet Palace – GGS' end,
         e.client_id,
         case e.expense_date when '2026-10-24' then 36 when '2026-10-25' then 39 when '2026-10-26' then 43 when '2026-10-27' then 16.4 end,
         30, 379.14, e.amount
    from public.expenses e
   where e.fuel_card_id = v_card and e.payment_mode = 'Card' and e.expense_date between '2026-10-24' and '2026-10-27';
  get diagnostics v_n = row_count;
  select coalesce(sum(amount), 0) into v_total from public.fuel_trips where fuel_card_id = v_card;
  if v_n <> 4 or v_total <> 1698.54 then
    raise exception '0582 REFUSED: % trips totalling %, expected 4 totalling 1,698.54.', v_n, v_total;
  end if;

  select balance into v_open from public.fuel_card_statement(v_card, '2026-10-24', '2026-10-31') where kind = 'OPENING_BALANCE';
  select v_open + coalesce(sum(loaded), 0) - coalesce(sum(spent), 0) into v_last
    from public.fuel_card_statement(v_card, '2026-10-24', '2026-10-31') where kind <> 'OPENING_BALANCE';
  if v_open <> 2277.74 or v_last <> 579.20 then
    raise exception '0582 REFUSED: the card''s statement opens at % and runs to %, not 2,277.74 and 579.20.', v_open, v_last;
  end if;

  -- a trip by km posts km ÷ average × price, and its deletion takes its bill
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);   -- Shayan Ahmed
  begin
    v_tid := public.record_fuel_trip(v_card, '2026-10-28', '0582 test', null, null, 30, null, 300, null);
    select amount into v_amt from public.fuel_trips where id = v_tid;
    if v_amt <> 300 then raise exception '0582 REFUSED: 30 km at 30 km/l and PKR 300 posted %, not 300.', v_amt; end if;
    perform public.delete_fuel_trip(v_tid);
    if exists (select 1 from public.expenses where description like '0582 test%') then
      raise exception '0582 REFUSED: deleting the trip left its bill.';
    end if;
    raise exception '0582-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0582-SENTINEL' then raise; end if;
  end;

  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0582 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps()
              where function_name in ('record_fuel_trip', 'delete_fuel_trip', 'fuel_card_match_attock', 'set_fuel_card_average')) then
    raise exception '0582 REFUSED: branch_guard_gaps() reports a new fuel function.';
  end if;
end $mig$;
