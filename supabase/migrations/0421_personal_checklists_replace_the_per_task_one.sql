-- 0421: the checklist stops belonging to a task and starts belonging to a
-- PERSON. `task_checklist_items` (0418, extended by 0420) is dropped and
-- replaced by `personal_checklist_items`.
--
-- WHAT CHANGED AND WHY IT IS A REPLACEMENT RATHER THAN A MOVE. The old table
-- was scoped by `task_id`, and its whole access story was derived from that:
-- who may see a list was answered by "who is the assignee of its task". A
-- collective per-user list has no task to ask, so every policy, the company
-- derivation and the uniqueness in the alert log all change together. Keeping
-- the table and adding a nullable owner would leave two contradictory scoping
-- rules in one table and a null that means "the other kind of row".
--
-- NOTHING IS LOST. `task_checklist_items` held ZERO rows and `task_alert_log`
-- held zero sub-task alerts when this was written — checked, not assumed,
-- because the alternative to checking is discovering it afterwards. The drop is
-- therefore data-free, and this migration asserts that before it runs rather
-- than trusting the reading to still be true at apply time.
--
-- WHO CAN SEE WHOSE. The user asked for: everyone keeps their own list; SA and
-- SSA "can also create their own and view other user's collective checklist
-- too". So admins READ other people's lists and WRITE only their own. That is
-- narrower than the old table, where an admin could edit an assignee's items,
-- and the narrowing is deliberate — "view" is the word that was used, and a
-- personal list somebody else can silently rewrite is not a personal list.
-- Change the company_admin policy from SELECT to ALL if that turns out to be
-- wrong; it is one policy and nothing else depends on the distinction.

-- ============================================================================
-- 0. Refuse if there is anything to lose.
-- ============================================================================
do $$
declare v_items int; v_alerts int;
begin
  select count(*) into v_items from public.task_checklist_items;
  select count(*) into v_alerts from public.task_alert_log where checklist_item_id is not null;
  if v_items <> 0 or v_alerts <> 0 then
    raise exception
      'REFUSED: task_checklist_items holds % row(s) and % sub-task alert(s). This migration drops the table; migrate them to personal_checklist_items first.',
      v_items, v_alerts;
  end if;
end $$;

-- ============================================================================
-- 1. The new table.
-- ============================================================================
create table if not exists public.personal_checklist_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- The owner IS the scope. Not nullable, and not defaulted at the column level
  -- — a row with no owner is not a private note with a missing field, it is a
  -- row nobody can see and nobody can delete.
  owner_id uuid not null references public.profiles(id) on delete cascade,
  label text not null check (length(btrim(label)) > 0),
  done boolean not null default false,
  position int not null default 0,
  -- Carried over from 0420, for the same reason: timestamptz and not date,
  -- because the tightest reminder is 3 hours out and a date has no hour in it
  -- to count back from.
  due_at timestamptz,
  reminders_on boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint personal_checklist_reminder_needs_a_deadline
    check (not reminders_on or due_at is not null)
);

create index if not exists personal_checklist_owner_idx
  on public.personal_checklist_items(owner_id, position, created_at);

-- Armed items, for the hourly alert job. Partial, because that job asks for
-- exactly this slice every hour and the slice is a rounding error next to the
-- table: a full-table scan an hour is affordable today and is the kind of thing
-- nobody revisits until it is not.
create index if not exists personal_checklist_armed_idx
  on public.personal_checklist_items(due_at)
  where reminders_on and not done;

comment on table public.personal_checklist_items is
  'A user''s own running checklist, shown beneath the task board. Not attached '
  'to any task (replaces task_checklist_items, 0421). Owner reads and writes '
  'their own; super_admin and SSA may READ others'' in their company.';

-- ============================================================================
-- 2. Defaults.
-- ============================================================================
--
-- owner_id comes from the SESSION and company_id from the OWNER'S PROFILE, not
-- from `current_company_id()`. The two agree for an ordinary user and diverge
-- for an SSA working inside "Viewing as", where current_company_id() is the
-- company being viewed rather than the one the SSA belongs to. Filing an SSA's
-- private notes under whichever tenant they happened to be inspecting is a
-- leak: company admins there can read them.
create or replace function public.personal_checklist_set_defaults()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    if new.owner_id is null then
      new.owner_id := auth.uid();
    end if;
    if new.owner_id is null then
      raise exception 'A checklist item needs an owner, and this session has no user.'
        using errcode = 'P0001';
    end if;
    select p.company_id into new.company_id
      from public.profiles p where p.id = new.owner_id;
    if new.company_id is null then
      raise exception 'That user does not belong to a company, so their checklist cannot be filed.'
        using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_personal_checklist_defaults on public.personal_checklist_items;
create trigger trg_personal_checklist_defaults
  before insert or update on public.personal_checklist_items
  for each row execute function public.personal_checklist_set_defaults();

-- ============================================================================
-- 3. Access.
-- ============================================================================
alter table public.personal_checklist_items enable row level security;

drop policy if exists "ssa_all" on public.personal_checklist_items;
create policy "ssa_all" on public.personal_checklist_items for all
  using (public.is_super_super_admin()) with check (public.is_super_super_admin());

-- Your own list, outright. This is also how an SA or SSA gets a list of their
-- own — they are a user like anybody else, and nothing separate is needed.
drop policy if exists "owner_all" on public.personal_checklist_items;
create policy "owner_all" on public.personal_checklist_items for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Admins READ everyone's in their company. SELECT and not ALL: see the header.
drop policy if exists "company_admin_read" on public.personal_checklist_items;
create policy "company_admin_read" on public.personal_checklist_items for select
  using (
    company_id = public.current_company_id()
    and exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role = 'super_admin')
  );

-- ============================================================================
-- 4. The alert log follows the item it logs.
-- ============================================================================
--
-- `task_id` becomes NULLABLE because a personal item has no task. That is a
-- real widening of what this table means — it was "alerts about tasks" and is
-- now "alerts about tasks and about personal items" — and the uniqueness has to
-- absorb it without losing the de-duplication 0418 exists for.
alter table public.task_alert_log
  alter column task_id drop not null;

alter table public.task_alert_log
  drop column if exists checklist_item_id;

alter table public.task_alert_log
  add column if not exists personal_item_id uuid
    references public.personal_checklist_items(id) on delete cascade;

-- Both nullable columns are collapsed to a sentinel, for the reason 0420
-- recorded and which applies twice over now: nulls are DISTINCT in a Postgres
-- unique index, so a plain multi-column index would make every task-level row
-- unique against every other task-level row and silently switch the
-- de-duplication off for exactly the alerts it was built for.
drop index if exists public.task_alert_log_once_idx;
create unique index if not exists task_alert_log_once_idx
  on public.task_alert_log(
    (coalesce(task_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    alert_kind,
    recipient_email,
    (coalesce(personal_item_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );

-- Exactly one of the two must be set. Without this the table accepts a row that
-- is about nothing, and such a row consumes a de-duplication slot forever while
-- naming no subject anybody could look up.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.task_alert_log'::regclass
       and conname = 'task_alert_log_names_exactly_one_subject'
  ) then
    alter table public.task_alert_log
      add constraint task_alert_log_names_exactly_one_subject
      check ((task_id is not null) <> (personal_item_id is not null));
  end if;
end $$;

-- ============================================================================
-- 5. The old table goes.
-- ============================================================================
-- CASCADE takes its policies, its indexes and its trigger with it. The trigger
-- FUNCTION is not owned by the table and has to be named separately, or it
-- survives as a definer function referencing a relation that no longer exists —
-- which `no_invoker_writes_an_owner_only_table` would not flag and nobody would
-- ever call.
drop table if exists public.task_checklist_items cascade;
drop function if exists public.task_checklist_set_defaults();

-- ============================================================================
-- Assertions.
-- ============================================================================
do $$
declare v_n int;
begin
  if to_regclass('public.task_checklist_items') is not null then
    raise exception 'REFUSED: task_checklist_items still exists';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'task_checklist_set_defaults') then
    raise exception 'REFUSED: task_checklist_set_defaults() outlived its table';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.personal_checklist_items'::regclass) then
    raise exception 'REFUSED: row level security is off on personal_checklist_items';
  end if;

  -- Three policies, and the admin one must be SELECT-only. Asserting the COUNT
  -- alone would pass if company_admin_read had been written FOR ALL, which is
  -- the one difference this migration is deliberate about.
  select count(*) into v_n from pg_policy
   where polrelid = 'public.personal_checklist_items'::regclass;
  if v_n <> 3 then
    raise exception 'REFUSED: personal_checklist_items carries % policies, expected 3', v_n;
  end if;
  select count(*) into v_n from pg_policy
   where polrelid = 'public.personal_checklist_items'::regclass
     and polname = 'company_admin_read' and polcmd = 'r';
  if v_n <> 1 then
    raise exception 'REFUSED: company_admin_read is not a SELECT-only policy — admins would be able to edit other people''s lists';
  end if;

  -- The widened uniqueness, by definition. A same-named index over the old
  -- columns would pass a name check and lose the personal-item separation.
  select count(*) into v_n from pg_indexes
   where schemaname = 'public' and indexname = 'task_alert_log_once_idx'
     and indexdef like '%personal_item_id%';
  if v_n <> 1 then
    raise exception 'REFUSED: task_alert_log_once_idx does not cover personal_item_id';
  end if;

  -- task_id must actually be nullable now: the personal-item alert cannot be
  -- written otherwise, and it would fail at 07:00 in a job nobody watches.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'task_alert_log'
                and column_name = 'task_id' and is_nullable = 'NO') then
    raise exception 'REFUSED: task_alert_log.task_id is still NOT NULL';
  end if;

  -- The hourly job must still be scheduled. This migration does not touch it,
  -- and that is exactly why it is worth reading back — a reminder feature whose
  -- cron quietly disappeared looks identical to one nobody has armed yet.
  if not exists (select 1 from cron.job
                  where jobname = 'send-task-alerts-hourly' and active) then
    raise exception 'REFUSED: send-task-alerts-hourly is not scheduled or not active';
  end if;
end $$;

-- TENANT GUARD ASSERTION NOT APPLICABLE: the one function defined here is a
-- trigger function and takes no parameters, so it introduces no guard to gap.
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
