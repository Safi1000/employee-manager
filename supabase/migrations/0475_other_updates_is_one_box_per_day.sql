-- 0475 — "Other Updates" is one box for the whole day, not one per client.
--
-- 0473 put other_updates on daily_client_reports, a box beside every client's
-- Details. What was wanted is a single day-level box, like the Next Day Tasks:
-- one note for the day's report, printed once at the head of the PDF.
--
-- It is a property of the DAY, so it belongs on daily_report_day_notes — the
-- (company, report_date) row 0460 created for exactly this kind of field, with
-- the roster.edit write gate, fill_company_id, updated_at and audit triggers
-- already on it. N per-client copies of one day note would disagree.
--
-- The per-client column is dropped: MEASURED BEFORE (prod) it holds 0 non-null
-- rows — it was live for minutes — so nothing is lost. 0473 is applied and is
-- not edited; this migration supersedes it.

alter table public.daily_report_day_notes
  add column if not exists other_updates text;

comment on column public.daily_report_day_notes.other_updates is
  'The day''s "Other Updates": one free-text note for the whole Daily Operations Report, '
  'printed once at the head of the PDF beside the Next Day Tasks (0475).';

do $mig$
declare v_n int;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'daily_client_reports'
                and column_name = 'other_updates') then
    execute 'select count(*) from public.daily_client_reports where other_updates is not null' into v_n;
    if v_n <> 0 then
      raise exception '0475 REFUSED: daily_client_reports.other_updates holds % row(s); move them before dropping.', v_n;
    end if;
    alter table public.daily_client_reports drop column other_updates;
  end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0475 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
