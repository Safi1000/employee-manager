-- 0116: Phase 1 seed — derive sites, shift_definitions and strength lines from
--        the data ALREADY in the DB (the "strength sheet" lives across
--        clients/contracts/employees, not an external file).
--
-- Scope: REAL OPERATING clients only — a client is in-scope if it has at least
--        one employee OR a contract carrying guard counts. This deliberately
--        skips ~24 empty/test client rows (www, nah, okok, Muzammil, …) and the
--        junk duplicate Emaar DHA V row (number_of_guards = 2131). Skipped
--        clients still appear in v_client_strength_reconciliation as 0/0 — the
--        mismatch is surfaced, not hidden.
--
-- Business rules (confirmed with owner — these values are NOT in the data):
--   * Standard site = two 12h shifts: day 08:00–20:00, night 20:00–08:00
--     (crosses midnight). Night shift seeded only where the site runs nights.
--   * HMC = three 8h shifts: day 06:00–14:00, evening 14:00–22:00,
--     night 22:00–06:00 (crosses midnight).
--   * relief_allowance / client_ot_rate / relief_mode have no source → 0 / null
--     / 'none'. To be entered from Phase 2 on.
--
-- Idempotent: every insert guards on NOT EXISTS, so re-running is a no-op.

-- ---------------------------------------------------------------------------
-- 0. In-scope clients (materialised as a temp view for the rest of the script).
-- ---------------------------------------------------------------------------
create temporary table _op_clients on commit drop as
select distinct c.id as client_id, c.company_id, c.name, c.billing_address,
       (c.name ilike 'HMC%') as is_hmc
from public.clients c
where exists (select 1 from public.employees e where e.client_id = c.id)
   or exists (
        select 1 from public.contracts ct
        where ct.client_id = c.id
          and coalesce(ct.number_of_guards,0)
            + coalesce(ct.day_guards,0)
            + coalesce(ct.night_guards,0)
            + coalesce(ct.evening_guards,0) > 0
        -- exclude the junk Emaar DHA V duplicate (2131) from qualifying on its own,
        -- it still qualifies via its 3 enrolled employees which is correct.
          and ct.number_of_guards is distinct from 2131
      );

-- ---------------------------------------------------------------------------
-- 1. One default site per in-scope client.
-- ---------------------------------------------------------------------------
insert into public.sites (company_id, client_id, name, location, is_default)
select o.company_id, o.client_id, o.name, o.billing_address, true
from _op_clients o
where not exists (select 1 from public.sites s where s.client_id = o.client_id);

-- ---------------------------------------------------------------------------
-- 2. shift_definitions per default site.
-- ---------------------------------------------------------------------------
-- 2a. HMC — three 8h shifts.
insert into public.shift_definitions
  (company_id, site_id, shift_code, start_time, end_time, duration_hours, crosses_midnight)
select s.company_id, s.id, v.shift_code, v.st, v.et, v.dur, v.cm
from public.sites s
join _op_clients o on o.client_id = s.client_id and o.is_hmc
cross join lateral (values
    ('day'::shift_code,     time '06:00', time '14:00', 8.0, false),
    ('evening'::shift_code, time '14:00', time '22:00', 8.0, false),
    ('night'::shift_code,   time '22:00', time '06:00', 8.0, true)
  ) as v(shift_code, st, et, dur, cm)
where s.is_default
  and not exists (select 1 from public.shift_definitions d
                  where d.site_id = s.id and d.shift_code = v.shift_code);

-- 2b. Standard sites — day 12h always; night 12h only where the site runs nights
--     (contract night_guards>0 OR any night-shift employee at that client).
insert into public.shift_definitions
  (company_id, site_id, shift_code, start_time, end_time, duration_hours, crosses_midnight)
select s.company_id, s.id, 'day'::shift_code, time '08:00', time '20:00', 12.0, false
from public.sites s
join _op_clients o on o.client_id = s.client_id and not o.is_hmc
where s.is_default
  and not exists (select 1 from public.shift_definitions d
                  where d.site_id = s.id and d.shift_code = 'day');

insert into public.shift_definitions
  (company_id, site_id, shift_code, start_time, end_time, duration_hours, crosses_midnight)
select s.company_id, s.id, 'night'::shift_code, time '20:00', time '08:00', 12.0, true
from public.sites s
join _op_clients o on o.client_id = s.client_id and not o.is_hmc
where s.is_default
  and (
        exists (select 1 from public.contracts ct
                where ct.client_id = o.client_id and coalesce(ct.night_guards,0) > 0)
     or exists (select 1 from public.employees e
                where e.client_id = o.client_id and e.shift = 'night')
      )
  and not exists (select 1 from public.shift_definitions d
                  where d.site_id = s.id and d.shift_code = 'night');

-- ---------------------------------------------------------------------------
-- 3. Strength lines (contract_lines with site_id set) — GUARD category, derived
--    from the client's contract guard counts. billing_rate from the contract.
--    contract_id kept (satisfies the existing NOT NULL billing grain).
-- ---------------------------------------------------------------------------
-- 3a. Where the contract splits by shift (day_guards / night_guards) → one line
--     per shift with a matching shift_definition.
insert into public.contract_lines
  (company_id, contract_id, category, site_id, shift_code,
   billed_qty, relief_allowance, relief_mode, billing_rate, effective_from)
select s.company_id, ct.id, 'GUARD', s.id, g.shift_code,
       g.qty, 0, 'none', ct.rate_per_guard_per_month, ct.start_date
from public.sites s
join _op_clients o on o.client_id = s.client_id
join public.contracts ct on ct.client_id = o.client_id and ct.number_of_guards is distinct from 2131
cross join lateral (values
    ('day'::shift_code,   coalesce(ct.day_guards,0)),
    ('night'::shift_code, coalesce(ct.night_guards,0))
  ) as g(shift_code, qty)
where s.is_default
  and g.qty > 0
  and exists (select 1 from public.shift_definitions d
              where d.site_id = s.id and d.shift_code = g.shift_code)
  and not exists (select 1 from public.contract_lines cl
                  where cl.site_id = s.id and cl.shift_code = g.shift_code
                    and cl.category = 'GUARD');

-- 3b. Fallback: contract has a plain number_of_guards but NO shift split → one
--     GUARD day line for the whole headcount.
insert into public.contract_lines
  (company_id, contract_id, category, site_id, shift_code,
   billed_qty, relief_allowance, relief_mode, billing_rate, effective_from)
select s.company_id, ct.id, 'GUARD', s.id, 'day',
       ct.number_of_guards, 0, 'none', ct.rate_per_guard_per_month, ct.start_date
from public.sites s
join _op_clients o on o.client_id = s.client_id
join public.contracts ct on ct.client_id = o.client_id and ct.number_of_guards is distinct from 2131
where s.is_default
  and coalesce(ct.number_of_guards,0) > 0
  and coalesce(ct.day_guards,0) = 0
  and coalesce(ct.night_guards,0) = 0
  and exists (select 1 from public.shift_definitions d
              where d.site_id = s.id and d.shift_code = 'day')
  and not exists (select 1 from public.contract_lines cl
                  where cl.site_id = s.id and cl.category = 'GUARD');

-- ---------------------------------------------------------------------------
-- 4. Post-seed review (no data change) — surfaces what still needs attention:
--    clients enrolled but with no derivable contracted strength, e.g. Emaar DHA
--    ISB (counts null), Bank of AJK (0 enrolled), Nova Group (43 vs 88).
--
--   select * from public.v_client_strength_reconciliation
--   where variance <> 0 order by abs(variance) desc;
-- ---------------------------------------------------------------------------
