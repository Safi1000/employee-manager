-- 0418: the task board grows three things — a field-level gate, a per-task
-- personal checklist, and the addresses task alerts are sent to.
--
-- ROLES. The user asked for "admin, super admin or SSA". There is no separate
-- `admin` in `user_role` — the enum is super_super_admin, super_admin, and then
-- five FUNCTIONAL roles (accounting, hr, ops_manager, ops_director,
-- finance_director) that are job titles, not seniority. So the privileged set
-- here is super_admin + SSA, which is exactly what the board's UI has always
-- called `isAdmin`. Recorded because "admin" reads like a third tier that this
-- migration silently declined to create, and it is not one.
--
-- ============================================================================
-- 1. A non-admin may change STATUS and nothing else.
-- ============================================================================
--
-- The board already renders "→ In Progress" / "→ Done" for everyone, and RLS
-- already lets an assignee update their own row — `assignee_self_update`, whose
-- own comment in 0029 claims it permits "status / description notes" but "not
-- reassign / change due date". It permits ALL of them. A policy is a row gate:
-- it decides WHETHER this row may be updated, never WHICH COLUMNS. 0029 wrote
-- the intent in a comment and the comment has been wrong since it was written —
-- an assignee could reassign their task to someone else, move its due date, or
-- retitle it, and the only thing stopping them was that the form disabled the
-- input. A disabled input is a suggestion; the network tab is not.
--
-- Column-level intent needs a trigger, so here is the trigger. It is the
-- enforcement; the greyed-out fields on the board are the courtesy.
create or replace function public.tasks_guard_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_changed text[] := '{}';
begin
  -- No JWT means this is not a person: the service role, pg_cron, or a
  -- migration. Those bypass RLS entirely, so the trigger is not what is
  -- protecting anything from them and refusing here would only break the
  -- alert job. A signed-in user always has auth.uid().
  if auth.uid() is null then
    return new;
  end if;

  if public.is_super_super_admin()
     or exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role = 'super_admin') then
    return new;
  end if;

  -- `is distinct from` and not `<>`: null is a value here. Clearing a due date
  -- or unassigning a task are exactly the edits being refused, and `<>` returns
  -- null for both, which an `if` reads as false and lets through.
  if new.title       is distinct from old.title       then v_changed := v_changed || 'title'; end if;
  if new.description is distinct from old.description then v_changed := v_changed || 'description'; end if;
  if new.priority    is distinct from old.priority    then v_changed := v_changed || 'priority'; end if;
  if new.due_date    is distinct from old.due_date    then v_changed := v_changed || 'due date'; end if;
  if new.assignee_id is distinct from old.assignee_id then v_changed := v_changed || 'assignee'; end if;
  -- Not in the user's list, and protected anyway: both are structural. Moving a
  -- task to another company or rewriting who raised it is not an edit, it is a
  -- forgery, and neither has a field on any form.
  if new.company_id  is distinct from old.company_id  then v_changed := v_changed || 'company'; end if;
  if new.created_by  is distinct from old.created_by  then v_changed := v_changed || 'raised by'; end if;

  if array_length(v_changed, 1) > 0 then
    raise exception
      'You can move a task between columns, but only an admin can change its %. Nothing has been saved.',
      array_to_string(v_changed, ', ')
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_tasks_field_guard on public.tasks;
create trigger trg_tasks_field_guard
  before update on public.tasks
  for each row execute function public.tasks_guard_privileged_fields();

-- ============================================================================
-- 2. A personal checklist, per task.
-- ============================================================================
--
-- Scoped to the TASK and not to a (task, user) pair, because a task has exactly
-- one assignee — `tasks.assignee_id` is a single column. Adding an owner_id
-- would invent a second axis nothing can currently populate, and the first
-- reader would reasonably assume tasks can be co-assigned. If they ever can,
-- the owner column is the change to make then; see the DEFERRED note below.
--
-- DEFERRED — reassigning a task leaves the previous assignee's checklist behind
-- for the new one to inherit. That is arguably right (the work is the work) and
-- arguably a privacy leak (the notes were personal). Not decided: nobody has
-- reassigned a task with a checklist yet. Raise it before the first bulk
-- reassignment, and if the answer is "clear it", the change is a delete inside
-- tasks_guard_privileged_fields' admin path.
create table if not exists public.task_checklist_items (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  label text not null check (length(btrim(label)) > 0),
  done boolean not null default false,
  position int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists task_checklist_items_task_idx
  on public.task_checklist_items(task_id, position, created_at);

-- company_id comes off the PARENT TASK, never off the session. `fill_company_id`
-- reads current_company_id(), which for an SSA working inside "Viewing as" is
-- the company they are viewing — the same value, right up until it is not. The
-- task already knows which company it belongs to; ask it.
create or replace function public.task_checklist_set_defaults()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    select t.company_id into new.company_id from public.tasks t where t.id = new.task_id;
    if new.company_id is null then
      raise exception 'That task does not exist, so there is nothing to attach a checklist to.'
        using errcode = 'P0001';
    end if;
    if new.created_by is null then
      new.created_by := auth.uid();
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_task_checklist_defaults on public.task_checklist_items;
create trigger trg_task_checklist_defaults
  before insert or update on public.task_checklist_items
  for each row execute function public.task_checklist_set_defaults();

alter table public.task_checklist_items enable row level security;

drop policy if exists "ssa_all" on public.task_checklist_items;
create policy "ssa_all" on public.task_checklist_items for all
  using (public.is_super_super_admin()) with check (public.is_super_super_admin());

-- Admins see and edit every checklist in their company — asked for explicitly:
-- "viewable and editable by admin, SA and SSA".
drop policy if exists "company_admin_all" on public.task_checklist_items;
create policy "company_admin_all" on public.task_checklist_items for all
  using (
    company_id = public.current_company_id()
    and exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role = 'super_admin')
  )
  with check (
    company_id = public.current_company_id()
    and exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role = 'super_admin')
  );

-- The assignee owns their own list outright: add, tick, rename, delete.
drop policy if exists "assignee_all" on public.task_checklist_items;
create policy "assignee_all" on public.task_checklist_items for all
  using (
    exists (select 1 from public.tasks t
             where t.id = task_id
               and t.assignee_id = auth.uid()
               and t.company_id = public.current_company_id())
  )
  with check (
    exists (select 1 from public.tasks t
             where t.id = task_id
               and t.assignee_id = auth.uid()
               and t.company_id = public.current_company_id())
  );

-- ============================================================================
-- 3. Where task alerts are sent.
-- ============================================================================
--
-- On `profiles` and not on `tasks`: the address belongs to the person, not to
-- the work. One place to set it, one place to change it when somebody's address
-- changes, and no chance of two tasks disagreeing about where the same person
-- is reachable.
--
-- Separate from `profiles.email`, which is the LOGIN identity and is managed by
-- auth. People asked to receive task mail somewhere else — a personal address,
-- a shared ops inbox — and overloading the login address would have changed
-- what they sign in with. Null means "send me nothing", which is the default
-- and is a real answer, not a missing one.
alter table public.profiles
  add column if not exists task_alert_email text;

comment on column public.profiles.task_alert_email is
  'Optional address for task-board alerts (assignment + due-date reminders). '
  'Set by the user on their own task board. NOT the login address — see profiles.email. '
  'Null means the user has opted out, which is the default.';

-- A reminder must fire once per task per threshold, not once per cron run. The
-- log is the record of what has already gone out; without it a daily job sends
-- the same "due in 3 days" mail three times if the run is retried, and a run
-- that is MISSED never catches up because nothing knows it was missed.
-- Same shape and the same reasoning as compliance_alert_log (0170).
create table if not exists public.task_alert_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  -- 'assigned', or 'due_7' / 'due_3' / 'due_1' / 'due_0' for the reminders.
  alert_kind text not null,
  recipient_email text not null,
  sent_at timestamptz not null default now()
);

-- The uniqueness IS the control. Without it the table is a diary nobody reads;
-- with it, a second send is refused by the database rather than by remembering
-- to check. Assignment mail is keyed the same way, so re-saving a task the
-- assignee did not change cannot re-announce it.
create unique index if not exists task_alert_log_once_idx
  on public.task_alert_log(task_id, alert_kind, recipient_email);

alter table public.task_alert_log enable row level security;

-- Readable for support ("did this go out?"), written only by the alert job,
-- which runs as the service role and bypasses RLS. No write policy exists on
-- purpose: nothing a user does should be able to forge a delivery record, and
-- an absent policy is a clearer statement of that than a policy that says false.
drop policy if exists "ssa_read" on public.task_alert_log;
create policy "ssa_read" on public.task_alert_log for select
  using (public.is_super_super_admin() or company_id = public.current_company_id());

-- ============================================================================
-- Assertions.
-- ============================================================================
do $$
declare v_n int;
begin
  -- The guard is on, and on UPDATE. A BEFORE INSERT trigger here would refuse
  -- task creation outright, so the timing is worth asserting and not assuming.
  select count(*) into v_n
    from pg_trigger
   where tgrelid = 'public.tasks'::regclass
     and tgname = 'trg_tasks_field_guard'
     and tgenabled <> 'D'
     and (tgtype & 16) <> 0   -- UPDATE
     and (tgtype & 4) = 0;    -- not INSERT
  if v_n <> 1 then
    raise exception 'REFUSED: trg_tasks_field_guard is not a live BEFORE UPDATE trigger on tasks';
  end if;

  -- RLS on, on both new tables. A table created without it is readable by every
  -- authenticated user in every company, and nothing about the create statement
  -- says so.
  select count(*) into v_n
    from pg_class
   where oid in ('public.task_checklist_items'::regclass, 'public.task_alert_log'::regclass)
     and relrowsecurity;
  if v_n <> 2 then
    raise exception 'REFUSED: row level security is not enabled on both new task tables';
  end if;

  -- Three policies on the checklist: SSA, company admin, assignee. A missing
  -- assignee policy would leave the feature working for admins only and looking
  -- like an empty list to the person it is for.
  select count(*) into v_n from pg_policy
   where polrelid = 'public.task_checklist_items'::regclass;
  if v_n <> 3 then
    raise exception 'REFUSED: task_checklist_items carries % policies, expected 3', v_n;
  end if;

  -- The de-duplication index, by name. The table without it still accepts every
  -- insert and the alert job still "works" — it just sends the same reminder
  -- every morning, which is the failure this table exists to prevent.
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'task_alert_log_once_idx') then
    raise exception 'REFUSED: task_alert_log_once_idx is missing — reminders would repeat daily';
  end if;
end $$;

-- TENANT GUARD ASSERTION NOT APPLICABLE: the two functions defined here take no
-- parameters (both are trigger functions), so neither introduces a guard to gap.
-- The detector is asserted anyway — a green run is evidence about the database,
-- not only about this file.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
