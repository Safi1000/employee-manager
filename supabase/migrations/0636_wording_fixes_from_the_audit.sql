-- 0636 — wording the 3 Nov 2026 audit found wrong, at its source.
--
--   1. Field-app alerts told people to go to "Operations › Field Supervisors";
--      the sidebar was regrouped on 2 Nov and it is "Field App › Field
--      Supervisors" now (field_register_device, field_record_visit).
--   2. A field-app attendance confirmation with no site read "Site — all shift
--      31 Oct confirmed by …" in Field Activity: it now falls back to the
--      client's name (field_activity_from_row).
--   3. Three expense category names: "Maintainance" → "Maintenance",
--      "Stationary" → "Stationery", "GIFT" → "Gifts". Names only — no expense
--      moves, no category merges. ("Payroll/Salary Expense" and "Lahore partner
--      share" are accounting questions put to Shayan, not wording, and are
--      left alone.)
--
-- Each function is amended by surgery against its live definition: the anchor
-- must appear exactly once or the migration refuses.

do $surgery$
declare
  v_def text;
  v_n   int;
  r     record;
begin
  for r in
    select * from (values
      ('public.field_register_device', 'Approve or refuse it in Operations › Field Supervisors.', 'Approve or refuse it in Field App › Field Supervisors.'),
      ('public.field_record_visit',    'Open it in Operations › Field Supervisors › Visits.',     'Open it in Field App › Field Supervisors › Visits.'),
      ('public.field_activity_from_row', 'coalesce(v_site, ''Site'')',                            'coalesce(v_site, (select c.name from public.clients c where c.id = new.client_id), ''Site'')')
    ) as t(fn, anchor, replacement)
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p where p.oid = r.fn::regproc;
    v_n := (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor);
    if v_n <> 1 then
      raise exception '0636 REFUSED: % — anchor found % times, expected exactly 1: %', r.fn, v_n, r.anchor;
    end if;
    execute replace(v_def, r.anchor, r.replacement);
  end loop;
end
$surgery$;

update public.expense_categories set name = 'Maintenance' where name = 'Maintainance';
update public.expense_categories set name = 'Stationery'  where name = 'Stationary';
update public.expense_categories set name = 'Gifts'       where name = 'GIFT';

-- ───────────────────────── Tests ─────────────────────────
do $test$
declare v_ran int := 0;
begin
  if pg_get_functiondef('public.field_register_device'::regproc) like '%Operations › Field Supervisors%'
     or pg_get_functiondef('public.field_record_visit'::regproc) like '%Operations › Field Supervisors%' then
    raise exception '0636 REFUSED: an alert still points at Operations › Field Supervisors.';
  end if;
  v_ran := v_ran + 1;
  if pg_get_functiondef('public.field_activity_from_row'::regproc) not like '%where c.id = new.client_id), ''Site'')%' then
    raise exception '0636 REFUSED: the site-name fallback is not in field_activity_from_row.';
  end if;
  v_ran := v_ran + 1;
  if exists (select 1 from public.expense_categories where name in ('Maintainance', 'Stationary', 'GIFT')) then
    raise exception '0636 REFUSED: an old category name is still there.';
  end if;
  v_ran := v_ran + 1;
  if v_ran <> 3 then raise exception '0636 REFUSED: % of 3 assertions ran.', v_ran; end if;
  if exists (select 1 from public.security_gaps()) then raise exception '0636 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0636 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
