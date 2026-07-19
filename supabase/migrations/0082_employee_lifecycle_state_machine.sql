-- Employee lifecycle state machine (spec section 12).
--
-- "State machine replaces Active/Inactive: Applicant/Waiting list -> Active ->
-- Left/Terminated -> Rehired. Exit requires reason + 'eligible for rehire?'.
-- Rehire relinks to the SAME record — tenure, incidents, blacklist persist;
-- never a duplicate."
--
-- Design: `lifecycle_state` becomes the source of truth. The existing
-- `status` (Active/On Leave/Inactive) is READ in ~15 places in the UI, so it
-- is kept and SYNCED one-way from lifecycle_state by a trigger. Nothing that
-- reads status breaks; the transition RPC below is the blessed write path.
-- (The old "mark Inactive" toggle that writes status directly is deprecated
-- and will be removed when the UI is rewired — until then it is a coarse
-- override that does not corrupt lifecycle_state.)
--
-- "Rehired" is deliberately NOT a resting state. A rehired guard is simply
-- active again; pretending otherwise would split "active" into two states that
-- behave identically. Rehire is the transition left|terminated -> active, and
-- it increments rehire_count so the history is visible without lying about the
-- current state.

-- ---------------------------------------------------------------------------
-- 1. States & new columns
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.employee_lifecycle_state as enum
    ('applicant', 'waitlisted', 'active', 'on_leave', 'left', 'terminated');
exception when duplicate_object then null; end $$;

alter table public.employees
  add column if not exists lifecycle_state     public.employee_lifecycle_state,
  add column if not exists rehire_count        integer not null default 0,
  add column if not exists eligible_for_rehire boolean,
  add column if not exists exit_reason         text,
  add column if not exists exit_date           date,
  add column if not exists blacklisted         boolean not null default false,
  add column if not exists blacklist_reason    text,
  -- Recruitment pipeline (spec §12): where the applicant came from and who
  -- referred them — the referral link powers the referral bonus (§17).
  add column if not exists referral_source        text,
  add column if not exists referred_by_employee_id uuid references public.employees(id),
  add column if not exists referred_by_name        text;

-- Backfill from the old status. 'Inactive' loses no data we ever had — we
-- never recorded WHY someone was inactive — so it maps to the neutral 'left'
-- with rehire eligibility left open (permissive) and an honest note.
update public.employees set
  lifecycle_state = case status
    when 'Active'   then 'active'::public.employee_lifecycle_state
    when 'On Leave' then 'on_leave'::public.employee_lifecycle_state
    else 'left'::public.employee_lifecycle_state
  end,
  eligible_for_rehire = case when status = 'Inactive' then true else eligible_for_rehire end,
  exit_reason = case when status = 'Inactive' and exit_reason is null
                     then 'Migrated from Inactive status' else exit_reason end
 where lifecycle_state is null;

alter table public.employees
  alter column lifecycle_state set default 'active',
  alter column lifecycle_state set not null;

create index if not exists idx_emp_lifecycle on public.employees(company_id, lifecycle_state);
create index if not exists idx_emp_blacklist on public.employees(company_id) where blacklisted;

-- ---------------------------------------------------------------------------
-- 2. The audit trail of transitions. Every state change writes one row —
--    this is the "one timeline" the guard service history (§12) reads.
-- ---------------------------------------------------------------------------

create table if not exists public.employee_lifecycle_events (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  employee_id         uuid not null references public.employees(id) on delete cascade,
  from_state          public.employee_lifecycle_state,
  to_state            public.employee_lifecycle_state not null,
  reason              text,
  eligible_for_rehire boolean,
  changed_by          uuid,
  changed_at          timestamptz not null default now(),
  notes               text
);

create index if not exists idx_ele_employee on public.employee_lifecycle_events(employee_id, changed_at);

drop trigger if exists trg_aaa_ele_fill_company on public.employee_lifecycle_events;
create trigger trg_aaa_ele_fill_company
  before insert on public.employee_lifecycle_events
  for each row execute function public.fill_company_id();

alter table public.employee_lifecycle_events enable row level security;
drop policy if exists "ssa_all" on public.employee_lifecycle_events;
create policy "ssa_all" on public.employee_lifecycle_events for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.employee_lifecycle_events;
create policy "company_members" on public.employee_lifecycle_events for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 3. status follows lifecycle_state. One direction only, to avoid a loop with
--    the deprecated direct-status writes.
-- ---------------------------------------------------------------------------

create or replace function public.sync_status_from_lifecycle()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- On INSERT the two can disagree because existing insert paths write `status`
  -- and know nothing about lifecycle_state. If the caller left lifecycle_state
  -- at its 'active' default, trust the status they gave and derive lifecycle
  -- from it (reverse map). If they set a non-default lifecycle_state, they are
  -- lifecycle-aware — drive status from it (forward map).
  if tg_op = 'INSERT' and new.lifecycle_state = 'active' then
    new.lifecycle_state := case new.status
      when 'Active'   then 'active'::public.employee_lifecycle_state
      when 'On Leave' then 'on_leave'::public.employee_lifecycle_state
      else 'left'::public.employee_lifecycle_state
    end;
  end if;

  new.status := case new.lifecycle_state
    when 'active'   then 'Active'
    when 'on_leave' then 'On Leave'
    else 'Inactive'   -- applicant, waitlisted, left, terminated are all not-active
  end;
  return new;
end;
$$;

drop trigger if exists trg_emp_sync_status on public.employees;
create trigger trg_emp_sync_status
  before insert or update of lifecycle_state on public.employees
  for each row execute function public.sync_status_from_lifecycle();

-- ---------------------------------------------------------------------------
-- 4. Allowed transitions, in one place.
-- ---------------------------------------------------------------------------

create or replace function public.lifecycle_transition_allowed(
  p_from public.employee_lifecycle_state,
  p_to   public.employee_lifecycle_state
)
returns boolean language sql immutable set search_path = public as $$
  select (p_from, p_to) in (
    -- recruitment
    ('applicant',  'waitlisted'),
    ('applicant',  'active'),      -- hire
    ('applicant',  'left'),        -- withdrew / rejected
    ('waitlisted', 'active'),      -- convert to employee
    ('waitlisted', 'left'),
    -- in service
    ('active',   'on_leave'),
    ('on_leave', 'active'),
    ('active',   'left'),
    ('active',   'terminated'),
    ('on_leave', 'left'),
    ('on_leave', 'terminated'),
    -- rehire (relinks to the same record)
    ('left',       'active'),
    ('terminated', 'active')
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. The one blessed way to change lifecycle_state.
--
--    Enforces the transition graph, the "exit needs a reason + rehire
--    eligibility" rule, and the blacklist block on rehire. Writes the event
--    row and lets the sync trigger update status.
-- ---------------------------------------------------------------------------

create or replace function public.transition_employee_lifecycle(
  p_employee_id         uuid,
  p_to_state            public.employee_lifecycle_state,
  p_reason              text default null,
  p_eligible_for_rehire boolean default null,
  p_notes               text default null
)
returns public.employee_lifecycle_state
language plpgsql security definer set search_path = public as $$
declare
  e      record;
  v_is_exit    boolean;
  v_is_rehire  boolean;
begin
  select * into e from public.employees where id = p_employee_id for update;
  if not found then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  if e.lifecycle_state = p_to_state then
    return e.lifecycle_state;  -- idempotent no-op
  end if;

  if not public.lifecycle_transition_allowed(e.lifecycle_state, p_to_state) then
    raise exception 'illegal lifecycle transition % -> %', e.lifecycle_state, p_to_state
      using errcode = '23514';
  end if;

  v_is_exit   := p_to_state in ('left', 'terminated');
  v_is_rehire := e.lifecycle_state in ('left', 'terminated') and p_to_state = 'active';

  -- Exit requires a reason and an explicit rehire decision (spec §12).
  if v_is_exit then
    if coalesce(trim(p_reason), '') = '' then
      raise exception 'exit requires a reason' using errcode = '23514';
    end if;
    if p_eligible_for_rehire is null then
      raise exception 'exit requires an explicit eligible-for-rehire decision'
        using errcode = '23514';
    end if;
  end if;

  -- Rehire is blocked for the blacklisted, and for anyone marked not eligible
  -- at their last exit. This is where "blacklist persists" has teeth.
  if v_is_rehire then
    if e.blacklisted then
      raise exception 'employee is blacklisted and cannot be rehired'
        using errcode = '23514', hint = e.blacklist_reason;
    end if;
    if e.eligible_for_rehire is false then
      raise exception 'employee was marked not eligible for rehire at last exit'
        using errcode = '23514';
    end if;
  end if;

  update public.employees set
    lifecycle_state     = p_to_state,
    exit_reason         = case when v_is_exit then p_reason else exit_reason end,
    exit_date           = case when v_is_exit then current_date else exit_date end,
    eligible_for_rehire = case when v_is_exit then p_eligible_for_rehire else eligible_for_rehire end,
    rehire_count        = case when v_is_rehire then rehire_count + 1 else rehire_count end,
    updated_at          = now()
  where id = p_employee_id;

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, eligible_for_rehire, changed_by, notes)
  values
    (e.company_id, p_employee_id, e.lifecycle_state, p_to_state, p_reason,
     case when v_is_exit then p_eligible_for_rehire else null end,
     auth.uid(), p_notes);

  return p_to_state;
end;
$$;
