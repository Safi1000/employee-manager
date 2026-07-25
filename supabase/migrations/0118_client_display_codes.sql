-- 0118: Phase 3 — Client-prefixed DISPLAY codes on top of permanent guard_code.
--
-- Adds a SEPARATE, client-scoped display identifier ({prefix}-{NNN}, e.g.
-- HMC-024) shown in the UI. The permanent guard_code (GGS-XXXXX, Phase 2 / 0117)
-- is NOT touched, renumbered, or read-modified anywhere here.
--
-- Confirmed decisions (product owner, Phase 3):
--   * Store a per-client sequential NUMBER (employees.display_number); the prefix
--     is derived LIVE from the guard's current client (clients.employee_id_prefix).
--     display_code = {current client prefix}-{lpad(display_number,3)}.
--   * No prefix available (no client, or client has no prefix) => display_number
--     stays NULL and the UI falls back to the permanent guard_code.
--   * Numbers are RETIRED permanently on transfer (monotonic per-client counter);
--     a departed guard's number is never reused.
--   * Backfill KEEPS each existing guard's current number: reuse the numeric
--     suffix of legacy_code when it matches the current client's prefix (436 of
--     437). The few whose legacy code belongs to another client (1) get a fresh
--     number above the client's high-water. New hires continue above high-water.
--   * On transfer the service log records the DISPLAY transition (HMC-024 ->
--     EMR-053) — handled app-side; this migration only provides the mechanism.
--
-- guard_code / legacy_code / employee_code are unchanged by this migration.

-- ---------------------------------------------------------------------------
-- 1. Column
-- ---------------------------------------------------------------------------
alter table public.employees
  add column if not exists display_number integer;

-- ---------------------------------------------------------------------------
-- 2a. Backfill KEEP: guards whose legacy_code matches their current client's
--     prefix keep that exact number (HMC-024 stays 24).
-- ---------------------------------------------------------------------------
update public.employees e
set display_number = (substring(e.legacy_code from '[0-9]+$'))::int
from public.clients c
where c.id = e.client_id
  and e.category = 'client'
  and e.display_number is null
  and c.employee_id_prefix is not null
  and e.legacy_code ~ ('^' || c.employee_id_prefix || '-[0-9]+$');

-- ---------------------------------------------------------------------------
-- 2b. Backfill FRESH: client guards with a prefixed client whose legacy_code
--     does NOT match the current prefix (transferred-in / EMP- codes) get a new
--     number above the client's high-water, ordered by join date then guard_code.
--     high_water = greatest(old per-prefix counter, max kept legacy suffix).
-- ---------------------------------------------------------------------------
with hw as (
  select c.id as client_id, c.company_id, c.employee_id_prefix as prefix,
    greatest(
      coalesce((select cc.value from public.company_counters cc
                 where cc.company_id = c.company_id
                   and cc.counter_name = 'empid:' || c.employee_id_prefix), 0),
      coalesce((select max((substring(e2.legacy_code from '[0-9]+$'))::int)
                 from public.employees e2
                 where e2.client_id = c.id
                   and e2.legacy_code ~ ('^' || c.employee_id_prefix || '-[0-9]+$')), 0)
    ) as high_water
  from public.clients c
  where c.employee_id_prefix is not null
),
fresh as (
  select e.id,
    hw.high_water + row_number() over (
      partition by e.client_id order by e.join_date asc nulls last, e.guard_code
    ) as num
  from public.employees e
  join public.clients c on c.id = e.client_id
  join hw on hw.client_id = e.client_id
  where e.category = 'client'
    and e.display_number is null
    and c.employee_id_prefix is not null
    and e.legacy_code is distinct from null
    and not (e.legacy_code ~ ('^' || c.employee_id_prefix || '-[0-9]+$'))
)
update public.employees e
set display_number = f.num
from fresh f
where f.id = e.id;

-- Also cover any client guard on a prefixed client that still has no number
-- (e.g. legacy_code null) — give it a fresh above-high-water number too.
with hw as (
  select c.id as client_id, c.company_id, c.employee_id_prefix as prefix,
    greatest(
      coalesce((select cc.value from public.company_counters cc
                 where cc.company_id = c.company_id
                   and cc.counter_name = 'empid:' || c.employee_id_prefix), 0),
      coalesce((select max(e2.display_number) from public.employees e2
                 where e2.client_id = c.id), 0)
    ) as high_water
  from public.clients c
  where c.employee_id_prefix is not null
),
fresh as (
  select e.id,
    hw.high_water + row_number() over (
      partition by e.client_id order by e.join_date asc nulls last, e.guard_code
    ) as num
  from public.employees e
  join public.clients c on c.id = e.client_id
  join hw on hw.client_id = e.client_id
  where e.category = 'client'
    and e.display_number is null
    and c.employee_id_prefix is not null
)
update public.employees e
set display_number = f.num
from fresh f
where f.id = e.id;

-- ---------------------------------------------------------------------------
-- 3. Uniqueness: at most one guard per (client, display_number).
-- ---------------------------------------------------------------------------
create unique index if not exists employees_client_display_number_uidx
  on public.employees (client_id, display_number)
  where display_number is not null;

-- ---------------------------------------------------------------------------
-- 4. Seed the per-client display counter ('disp:<client_id>') so new hires
--    continue ABOVE the highest number ever used (kept, fresh, or old
--    high-water). greatest() keeps re-runs from lowering it.
-- ---------------------------------------------------------------------------
insert into public.company_counters (company_id, counter_name, value)
select c.company_id, 'disp:' || c.id::text,
  greatest(
    coalesce((select cc.value from public.company_counters cc
               where cc.company_id = c.company_id
                 and cc.counter_name = 'empid:' || c.employee_id_prefix), 0),
    coalesce((select max(e.display_number) from public.employees e
               where e.client_id = c.id), 0)
  )
from public.clients c
where c.employee_id_prefix is not null
on conflict (company_id, counter_name)
  do update set value = greatest(public.company_counters.value, excluded.value);

-- ---------------------------------------------------------------------------
-- 5. assign_display_number(): allocate the next per-client number for a guard
--    under their CURRENT client and store it. Returns the derived display code,
--    or NULL when no prefix is available (caller falls back to guard_code).
--    Retire-forever: uses the monotonic per-client counter, never reuses.
-- ---------------------------------------------------------------------------
create or replace function public.assign_display_number(p_employee_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_client  uuid;
  v_prefix  text;
  v_n       bigint;
begin
  select e.company_id, e.client_id into v_company, v_client
  from public.employees e where e.id = p_employee_id;

  if v_company is null then
    raise exception 'Employee % not found', p_employee_id;
  end if;

  if v_client is null then
    update public.employees set display_number = null where id = p_employee_id;
    return null;
  end if;

  select employee_id_prefix into v_prefix
  from public.clients where id = v_client;

  if v_prefix is null then
    update public.employees set display_number = null where id = p_employee_id;
    return null;
  end if;

  v_n := public.next_counter(v_company, 'disp:' || v_client::text);
  update public.employees set display_number = v_n, updated_at = now()
   where id = p_employee_id;

  return v_prefix || '-' || lpad(v_n::text, 3, '0');
end;
$$;

grant execute on function public.assign_display_number(uuid) to authenticated;
