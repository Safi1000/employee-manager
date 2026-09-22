-- 0473 — Daily Reports gains "Other Updates" per client.
--
-- A second free-text box beside Details on each client's line, for what is not
-- the day's operational note: admin matters, client requests, anything the
-- supervisor wants on the record without mixing it into Details. Printed as its
-- own column in the Daily Operations Report PDF.
--
-- Independent of no_report. "No report" is a claim about Details — nothing
-- operational to say about this client today — and does not silence Other
-- Updates, so the screen neither clears nor disables it when the flag is set.
-- A row is kept while ANY of details / no_report / other_updates says
-- something, and deleted by the screen when none does.
--
-- Lands with its screen (FieldOps.tsx) and its PDF column in the same change —
-- the "a column a user must fill is not done until a user can fill it" rule.
-- The existing roster.edit write policies (0313) already cover the new column.

alter table public.daily_client_reports
  add column if not exists other_updates text;

comment on column public.daily_client_reports.other_updates is
  'Free-text "Other Updates" for this client on this day, beside details. '
  'Independent of no_report (which speaks for details only). Printed as its own PDF column.';

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0473 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
