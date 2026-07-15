-- 0073: Client-scoped Employee ID prefixes + Employee ID history.
--
-- Replaces the single global EMP-XXXX sequence (per-company `next_counter`
-- 'employee') with a PER-CLIENT prefix system for client-assigned employees:
--   * Each client can hold a manual prefix (e.g. 'EMR' for Emaar).
--   * A client-category employee's code is {prefix}-{NNN}, numbered by an
--     independent per-prefix sequence (EMR-001, EMR-002, …).
--   * Internal (category != 'client') employees KEEP the EMP-XXXX sequence,
--     untouched — nothing in this migration changes gen_employee_code().
--   * Existing EMP-XXXX employees convert lazily: they keep their code until
--     an admin sets/edits their client's prefix (see reassign_client_employee_codes),
--     which is an explicit, warned action. No global backfill here.
--
-- Collision-free numbering rides on the existing atomic next_counter() upsert.
-- Numbers are MONOTONIC per prefix — never reused — so reassigning an employee
-- away and back yields a fresh number, and no two employees ever collide.

-- ---------------------------------------------------------------------------
-- 1. Prefix column on clients (nullable; format-checked; unique per company).
-- ---------------------------------------------------------------------------
alter table public.clients
  add column if not exists employee_id_prefix text;

alter table public.clients
  drop constraint if exists clients_employee_id_prefix_format;
alter table public.clients
  add constraint clients_employee_id_prefix_format
  check (employee_id_prefix is null or employee_id_prefix ~ '^[A-Z0-9]{2,6}$');

-- Unique only where set: existing prefix-less clients don't collide on NULL.
create unique index if not exists clients_company_empid_prefix_uidx
  on public.clients (company_id, employee_id_prefix)
  where employee_id_prefix is not null;

-- ---------------------------------------------------------------------------
-- 2. Employee ID history — one row per code change (visible on Employee View).
--    The generic audit log (0041) also captures employees.employee_code
--    changes, but this table is the user-facing, purpose-built trail.
-- ---------------------------------------------------------------------------
create table if not exists public.employee_code_history (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  old_code     text,                       -- null for the first assignment
  new_code     text not null,
  client_id    uuid references public.clients(id) on delete set null,
  reason       text not null,              -- 'assigned' | 'reassigned' | 'prefix_changed'
  changed_by   uuid references auth.users(id) on delete set null,
  changed_at   timestamptz not null default now()
);

create index if not exists employee_code_history_emp_idx
  on public.employee_code_history(employee_id, changed_at desc);

alter table public.employee_code_history enable row level security;

drop policy if exists "ssa_all" on public.employee_code_history;
create policy "ssa_all" on public.employee_code_history for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.employee_code_history;
create policy "company_members" on public.employee_code_history for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 3. assign_employee_code(): allocate a prefix-scoped code for one employee,
--    swap it onto the employee row, and record history — all in one txn.
--
--    Raises 'NO_PREFIX' when the target client has no prefix set, so the app
--    can surface "Set an Employee ID Prefix for this client first" and abort
--    without half-applying. p_old_code is passed through to history: callers
--    pass NULL for a brand-new employee (first assignment) so the throwaway
--    EMP-XXXX the insert trigger minted never pollutes the visible history.
-- ---------------------------------------------------------------------------
create or replace function public.assign_employee_code(
  p_employee_id uuid,
  p_client_id   uuid,
  p_reason      text,
  p_old_code    text default null
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_prefix     text;
  v_n          bigint;
  v_new_code   text;
begin
  select company_id into v_company_id
    from public.employees where id = p_employee_id;
  if v_company_id is null then
    raise exception 'Employee % not found', p_employee_id;
  end if;

  select employee_id_prefix into v_prefix
    from public.clients
   where id = p_client_id and company_id = v_company_id;
  if v_prefix is null then
    raise exception 'NO_PREFIX';
  end if;

  v_n := public.next_counter(v_company_id, 'empid:' || v_prefix);
  v_new_code := v_prefix || '-' || lpad(v_n::text, 3, '0');

  update public.employees
     set employee_code = v_new_code, updated_at = now()
   where id = p_employee_id;

  insert into public.employee_code_history
    (company_id, employee_id, old_code, new_code, client_id, reason, changed_by)
  values
    (v_company_id, p_employee_id, p_old_code, v_new_code, p_client_id, p_reason, auth.uid());

  return v_new_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. reassign_client_employee_codes(): Step-5 cascade. Regenerate every
--    currently-assigned (category='client') employee of a client with the
--    client's CURRENT prefix, preserving each old code in history. Returns the
--    number of employees updated. The app calls this AFTER saving the new
--    prefix, and only after warning the admin.
-- ---------------------------------------------------------------------------
create or replace function public.reassign_client_employee_codes(
  p_client_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r   record;
  cnt integer := 0;
begin
  for r in
    select id, employee_code
      from public.employees
     where client_id = p_client_id
       and category = 'client'
     order by employee_code
  loop
    perform public.assign_employee_code(r.id, p_client_id, 'prefix_changed', r.employee_code);
    cnt := cnt + 1;
  end loop;
  return cnt;
end;
$$;

-- Count how many employees a prefix (re)assignment would touch — lets the app
-- show "This will update N employees" before the admin confirms.
create or replace function public.count_client_employees(
  p_client_id uuid
) returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.employees
   where client_id = p_client_id and category = 'client';
$$;

-- The app calls these three from the client (authenticated role).
grant execute on function public.assign_employee_code(uuid, uuid, text, text) to authenticated;
grant execute on function public.reassign_client_employee_codes(uuid) to authenticated;
grant execute on function public.count_client_employees(uuid) to authenticated;
