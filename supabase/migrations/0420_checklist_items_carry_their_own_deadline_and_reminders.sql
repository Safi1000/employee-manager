-- 0420: a checklist item can carry its own deadline and ask to be reminded
-- about it — 3 days out, 1 day out, and 3 hours out.
--
-- WHY THE COLUMN IS `timestamptz` AND NOT `date`, which is the whole reason
-- this is a migration and not a button. `tasks.due_date` is a DATE, and a date
-- can answer "3 days before" and "1 day before" but cannot answer "a few hours
-- before" — there is no hour in it to count back from. A sub-task due at 17:00
-- and one due at 09:00 are the same row to a date column, and the 3-hour
-- reminder for both would have to fire at midnight. So checklist deadlines are
-- instants, and `tasks.due_date` is deliberately left alone: changing it would
-- reinterpret every existing task's deadline as midnight UTC, which for this
-- company is 05:00 local the same morning.
--
-- REMINDERS ARE OPT-IN PER ITEM, not per user and not per task. The button the
-- user asked for is the thing that sets `reminders_on`, so an item with a date
-- and no reminder is a normal state — "I know when this is due, don't email me"
-- — and it has to be distinguishable from "no date at all". Two columns say
-- that; one column would have to overload null.
alter table public.task_checklist_items
  add column if not exists due_at timestamptz,
  add column if not exists reminders_on boolean not null default false;

-- Arming a reminder with nothing to count back from is the one incoherent
-- combination, and it is incoherent in a way that FAILS SILENTLY: the item
-- would sit armed forever, the job would skip it every hour because there is no
-- deadline to compare against, and the user would conclude reminders do not
-- work. Refused at the table instead.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.task_checklist_items'::regclass
       and conname = 'task_checklist_reminder_needs_a_deadline'
  ) then
    alter table public.task_checklist_items
      add constraint task_checklist_reminder_needs_a_deadline
      check (not reminders_on or due_at is not null);
  end if;
end $$;

comment on column public.task_checklist_items.due_at is
  'Optional deadline for this sub-task, as an instant. timestamptz and not date '
  'because the 3-hour reminder has no hour to count back from otherwise.';
comment on column public.task_checklist_items.reminders_on is
  'Set by the bell button on the checklist. Requires due_at (see the check '
  'constraint). False is the default and means the item is silent.';

-- The alert log now has to distinguish "this TASK is due" from "this SUB-TASK
-- is due", and one sub-task's reminder from another's on the same task.
alter table public.task_alert_log
  add column if not exists checklist_item_id uuid
    references public.task_checklist_items(id) on delete cascade;

-- The uniqueness has to widen with it, and the coalesce is load-bearing.
--
-- A plain four-column unique index would NOT work: in Postgres nulls are
-- distinct in a unique index, so every task-level row (checklist_item_id null)
-- would be unique against every other, and the de-duplication that 0418 exists
-- to provide would silently stop applying to exactly the alerts it was built
-- for. The daily job would resume sending "due in 3 days" every morning and
-- nothing would look wrong. Collapsing null to a fixed sentinel keeps task-level
-- rows comparing equal to each other while item-level rows separate by item.
drop index if exists public.task_alert_log_once_idx;
create unique index if not exists task_alert_log_once_idx
  on public.task_alert_log(
    task_id,
    alert_kind,
    recipient_email,
    (coalesce(checklist_item_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );

-- The reminder job now runs HOURLY, not daily.
--
-- 0419 scheduled it at 07:00 because everything it sent was measured in days.
-- A 3-hour warning cannot be delivered by a job that wakes once a day: the
-- tightest it could ever be is "some time in the previous 24 hours", which is
-- not a warning. The function gates its day-based work (assignment mail and
-- task due reminders) to the 07:00 run so their cadence is unchanged, and
-- evaluates checklist reminders every hour.
--
-- Re-running costs nothing: every send is claimed in task_alert_log first, so
-- 23 of the 24 daily runs find nothing to do and send nothing.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'send-task-alerts-daily') then
    perform cron.unschedule('send-task-alerts-daily');
  end if;
  if exists (select 1 from cron.job where jobname = 'send-task-alerts-hourly') then
    perform cron.unschedule('send-task-alerts-hourly');
  end if;
end $$;

select cron.schedule(
  'send-task-alerts-hourly',
  '0 * * * *',
  $$select public.invoke_send_task_alerts();$$
);

-- ============================================================================
-- Assertions.
-- ============================================================================
do $$
declare v_sched text; v_active boolean; v_n int;
begin
  -- The old daily job must be GONE, not merely superseded. Two schedules
  -- pointing at the same function is not a duplicate send — the log prevents
  -- that — but it is two jobs to reason about and one of them contradicts this
  -- file's own comment about cadence.
  if exists (select 1 from cron.job where jobname = 'send-task-alerts-daily') then
    raise exception 'REFUSED: send-task-alerts-daily is still scheduled alongside the hourly job';
  end if;

  select schedule, active into v_sched, v_active
    from cron.job where jobname = 'send-task-alerts-hourly';
  if v_sched is distinct from '0 * * * *' or not coalesce(v_active, false) then
    raise exception 'REFUSED: send-task-alerts-hourly is % (active=%), expected 0 * * * * active',
      v_sched, v_active;
  end if;

  -- The constraint, by its DEFINITION rather than by its name — a constraint
  -- called this and checking something else would pass a name check.
  --
  -- This is deliberately not tested by attempting a bad insert, and the reason
  -- is worth recording because the attempt was written first and did not work:
  -- `task_checklist_set_defaults` is a BEFORE INSERT trigger that resolves
  -- company_id from the parent task and raises P0001 when the task does not
  -- exist. A synthetic row therefore dies in the trigger, before any CHECK is
  -- evaluated, and the handler would have been catching the trigger's refusal
  -- while reporting the constraint as proven. Reading the definition claims
  -- less and is true; the alternative claimed more and was not.
  select count(*) into v_n from pg_constraint
   where conrelid = 'public.task_checklist_items'::regclass
     and conname = 'task_checklist_reminder_needs_a_deadline'
     and pg_get_constraintdef(oid) ilike '%reminders_on%'
     and pg_get_constraintdef(oid) ilike '%due_at is not null%';
  if v_n <> 1 then
    raise exception 'REFUSED: the armed-without-a-deadline check is missing or checks something else';
  end if;

  -- The widened uniqueness, by definition and not by name. A same-named index
  -- on the old three columns would pass a name check and lose item-level
  -- separation.
  select count(*) into v_n from pg_indexes
   where schemaname = 'public' and indexname = 'task_alert_log_once_idx'
     and indexdef like '%checklist_item_id%';
  if v_n <> 1 then
    raise exception 'REFUSED: task_alert_log_once_idx does not cover checklist_item_id';
  end if;
end $$;

-- TENANT GUARD ASSERTION NOT APPLICABLE: this migration defines no function and
-- adds no parameter, so it introduces no guard to gap. The detector is asserted
-- anyway — a green run is evidence about the database, not only about this file.
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
