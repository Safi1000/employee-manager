-- 0117: Phase 2 — Permanent sequential guard codes (GGS-00001).
--
-- Reverses the client-prefixed / renumber-on-transfer Employee ID system (0073).
-- Per §2.1.1: the stored code becomes permanent, sequential and IMMUTABLE,
-- assigned once at hiring, never changed. The client prefix survives only as a
-- derived display label (and, unchanged, as the invoice-number source on
-- clients.employee_id_prefix). The old code is retained in legacy_code.
--
-- Confirmed decisions (product owner, Phase 2):
--   * Scope: category='client' guards only (455). office_staff / reliever keep
--     their EMP-XXXX codes and get no guard_code.
--   * Numbering: GGS- + 5-digit, starting 00001, ordered by join_date ASC
--     NULLS LAST, then existing employee_code ASC (deterministic).
--   * Location: new columns on employees (no table rename).
--   * guard_code is canonical & immutable; employee_code is MIRRORED to it so
--     every existing display/payroll/export path shows GGS with no rework;
--     legacy_code holds the old client-prefixed code (indexed, searchable).
--   * clients.employee_id_prefix is KEPT AS-IS (invoice numbering + posting
--     label). Only its employee-renumbering role is removed (app side).
--   * Client transfers are logged in employee_code_history WITHOUT changing the
--     code (old_code = new_code = guard_code), preserving the Service History
--     timeline across client changes (app side).

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.employees
  add column if not exists guard_code  text,
  add column if not exists legacy_code text;

-- ---------------------------------------------------------------------------
-- 2. Immutability trigger — once guard_code is set it can never change, and
--    employee_code stays pinned to it (the mirror can't drift). First
--    assignment (null -> value) is allowed so backfill and new hires work.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_guard_code_immutable()
returns trigger language plpgsql as $$
begin
  if OLD.guard_code is not null then
    if NEW.guard_code is distinct from OLD.guard_code then
      raise exception 'guard_code is immutable (attempted % -> %)',
        OLD.guard_code, NEW.guard_code;
    end if;
    -- keep the visible code mirrored to the permanent guard_code
    NEW.employee_code := OLD.guard_code;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_code_immutable on public.employees;
create trigger trg_guard_code_immutable
  before update on public.employees
  for each row execute function public.enforce_guard_code_immutable();

-- ---------------------------------------------------------------------------
-- 3. Backfill (client guards only; idempotent via guard_code is null).
--    legacy_code = current code; guard_code = employee_code = GGS-NNNNN.
-- ---------------------------------------------------------------------------
with ordered as (
  select id,
         row_number() over (
           partition by company_id
           order by join_date asc nulls last, employee_code asc
         ) as rn
  from public.employees
  where category = 'client'
    and guard_code is null
)
update public.employees e
set legacy_code   = e.employee_code,
    guard_code    = 'GGS-' || lpad(o.rn::text, 5, '0'),
    employee_code = 'GGS-' || lpad(o.rn::text, 5, '0')
from ordered o
where o.id = e.id;

-- ---------------------------------------------------------------------------
-- 4. Indexes: guard_code unique per company; legacy_code searchable.
-- ---------------------------------------------------------------------------
create unique index if not exists employees_company_guard_code_uidx
  on public.employees (company_id, guard_code)
  where guard_code is not null;

create index if not exists employees_legacy_code_idx
  on public.employees (legacy_code)
  where legacy_code is not null;

-- ---------------------------------------------------------------------------
-- 5. Seed the per-company guard_code counter to the highest number assigned so
--    new hires continue the sequence. greatest() keeps re-runs from lowering it.
-- ---------------------------------------------------------------------------
insert into public.company_counters (company_id, counter_name, value)
select company_id, 'guard_code', count(*)
from public.employees
where category = 'client' and guard_code is not null
group by company_id
on conflict (company_id, counter_name)
  do update set value = greatest(public.company_counters.value, excluded.value);

-- ---------------------------------------------------------------------------
-- 6. assign_guard_code(): allocate the next permanent GGS code for a guard at
--    hiring, mirror it into employee_code, and log the first assignment. No-op
--    (returns existing code) if one is already assigned — immutable.
-- ---------------------------------------------------------------------------
create or replace function public.assign_guard_code(p_employee_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_client  uuid;
  v_existing text;
  v_n       bigint;
  v_code    text;
begin
  select company_id, client_id, guard_code
    into v_company, v_client, v_existing
  from public.employees where id = p_employee_id;

  if v_company is null then
    raise exception 'Employee % not found', p_employee_id;
  end if;
  if v_existing is not null then
    return v_existing;                       -- already assigned; immutable
  end if;

  v_n := public.next_counter(v_company, 'guard_code');
  v_code := 'GGS-' || lpad(v_n::text, 5, '0');

  update public.employees
     set guard_code = v_code, employee_code = v_code, updated_at = now()
   where id = p_employee_id;

  insert into public.employee_code_history
    (company_id, employee_id, old_code, new_code, client_id, reason, changed_by)
  values
    (v_company, p_employee_id, null, v_code, v_client, 'assigned', auth.uid());

  return v_code;
end;
$$;

grant execute on function public.assign_guard_code(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Deprecate the renumbering RPCs from 0073. Kept (not dropped) so nothing
--    errors mid-transition, but the app no longer calls them and the client
--    prefix no longer renumbers employees.
-- ---------------------------------------------------------------------------
comment on function public.assign_employee_code(uuid, uuid, text, text) is
  'DEPRECATED (0117): client-prefixed renumbering replaced by permanent guard_code (assign_guard_code). No longer called by the app.';
comment on function public.reassign_client_employee_codes(uuid) is
  'DEPRECATED (0117): guard codes are now permanent; changing a client prefix must NOT renumber employees.';
comment on column public.clients.employee_id_prefix is
  '0117: NO LONGER drives employee IDs. Retained as the invoice Ref-number prefix and the derived posting display label.';
