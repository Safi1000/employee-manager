-- 0517 — Next Day Tasks and Other Updates are recorded per REGION.
--
-- Both sections apply to every region, but each region writes its own: ISB/RWP's
-- tasks are not Lahore's. Until now daily_report_tasks and daily_report_day_notes
-- were keyed by (company, day) only, so one list and one note served every region
-- and the region filter on Daily Reports could not separate them.
--
-- Both tables gain branch_id (the region, as clients.branch_id is).
--
-- DECIDED (Shayan, 2026-10-16): rows written before this migration are NOT
-- assigned to a region. MEASURED BEFORE (prod): 90 tasks (2026-09-18 → 2026-10-16)
-- and 19 day notes, all with no region. They keep branch_id NULL, which means
-- "all regions, written before the split", and the screen shows them under that
-- heading, read-only. Guessing a region for them would be inventing a record.
--
-- So NULL is legal on existing rows and refused on new ones: the guard below
-- requires a region on INSERT. A stale client still writing region-less rows is
-- refused rather than silently adding to the "before the split" pile.
--
-- daily_report_day_notes' unique key widens from (company, day) to
-- (company, day, region), NULLS NOT DISTINCT so the one legacy row per day stays
-- unique and the upsert can name all three columns.

alter table public.daily_report_tasks
  add column if not exists branch_id uuid references public.branches(id);

alter table public.daily_report_day_notes
  add column if not exists branch_id uuid references public.branches(id);

comment on column public.daily_report_tasks.branch_id is
  'The region this Next Day Task belongs to (0517). Required on every new row. '
  'NULL only on rows written before 0517 — DECIDED: those are "all regions, before the split" '
  'and are not back-assigned.';

comment on column public.daily_report_day_notes.branch_id is
  'The region this day note belongs to (0517): one Other Updates note per (company, day, region). '
  'Required on every new row. NULL only on rows written before 0517 — DECIDED: those are '
  '"all regions, before the split" and are not back-assigned.';

alter table public.daily_report_day_notes
  drop constraint if exists daily_report_day_notes_unique;

do $mig$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.daily_report_day_notes'::regclass
                    and conname = 'daily_report_day_notes_region_unique') then
    alter table public.daily_report_day_notes
      add constraint daily_report_day_notes_region_unique
      unique nulls not distinct (company_id, report_date, branch_id);
  end if;
end $mig$;

create index if not exists daily_report_tasks_region_day_idx
  on public.daily_report_tasks (company_id, report_date, branch_id, sort_order);

-- One guard for both tables. A new row must name a region; whatever region a row
-- names must be a regional branch of the row's own company (head office is not a
-- region on this report).
create or replace function public.daily_report_region_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company uuid;
  v_ho boolean;
begin
  if tg_op = 'INSERT' and new.branch_id is null then
    raise exception 'A region is required: Next Day Tasks and Other Updates are recorded per region (0517). [%]', tg_table_name
      using errcode = '23502';
  end if;
  if new.branch_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.branch_id is not distinct from old.branch_id then
    return new;
  end if;

  select b.company_id, coalesce(b.is_head_office, false)
    into v_company, v_ho
    from public.branches b
   where b.id = new.branch_id;

  if not found or v_company is distinct from new.company_id then
    raise exception 'Region is not a branch of this company. [%]', tg_table_name
      using errcode = '23503';
  end if;
  if v_ho then
    raise exception 'Head Office is not a region on the Daily Report. [%]', tg_table_name
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

-- After fill_company_id (trg_aaa_*), so new.company_id is set when this reads it.
drop trigger if exists trg_bbc_daily_report_tasks_region on public.daily_report_tasks;
create trigger trg_bbc_daily_report_tasks_region
  before insert or update on public.daily_report_tasks
  for each row execute function public.daily_report_region_guard();

drop trigger if exists trg_bbc_daily_report_day_notes_region on public.daily_report_day_notes;
create trigger trg_bbc_daily_report_day_notes_region
  before insert or update on public.daily_report_day_notes
  for each row execute function public.daily_report_region_guard();

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0517 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
