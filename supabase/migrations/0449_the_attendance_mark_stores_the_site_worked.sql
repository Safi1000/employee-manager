-- 0449 — the attendance mark stores the SITE worked.
--
-- attendance_records carried worked_for_client_id (a client) and branch_id (a
-- region) but no site. A client is not specific enough: Nova runs 4 sites, MIU
-- runs 3, confirmations key on site, and the daily board works per site. The
-- mark was the only link in the chain that spoke in clients. This adds site_id.
--
-- Rules (item 1 of the reliever pass):
--   * NON-reliever: derived from the posting, same as worked_for_client_id.
--     Existing rows are backfilled from the deployment covering each row's date;
--     rows with no resolvable posting (fired past end_date, office staff who
--     stand nowhere) are LEFT NULL and counted, never guessed.
--   * RELIEVER present: the site is required and user-chosen, and worked_for_client_id
--     is derived FROM the site. To keep the deploy window safe, a present reliever
--     may still arrive with only worked_for_client_id; the hard "site required" is
--     enforced by the reliever screen. A non-present reliever keeps neither.
--
-- Item 2 (OPS-verify) lands here on the LOCK only: enforce_attendance_month_lock's
-- reliever branch keyed on category; it now keys on the site worked (its client on
-- the row). enforce_confirmed_month_end_lock is deliberately NOT touched.
--
-- SURGERY, NOT RESTATEMENT. Both functions have several authors; each is amended
-- against its LIVE definition with an anchor asserted to appear exactly once.

-- 1) The site a guard is posted to on a date — twin of deployment_client_on.
create or replace function public.deployment_site_on(p_guard uuid, p_date date)
 returns uuid
 language plpgsql
 stable security definer
 set search_path to 'public'
as $fn$
#variable_conflict use_column
begin
  -- tenant guard [resolved]: owning company looked up from p_guard via public.employees
  if p_guard is not null then perform public.assert_same_company((select company_id from public.employees where id = p_guard)); end if;
  return (
  select d.site_id
    from public.deployments d
   where d.guard_id = p_guard
     and d.site_id is not null
     and d.start_date <= p_date
     and (d.end_date is null or d.end_date >= p_date)
   order by d.start_date desc, d.created_at desc
   limit 1);
end
$fn$;

-- 2) The column. Nullable; ON DELETE SET NULL so removing a site never destroys
--    the attendance history that named it.
alter table public.attendance_records
  add column if not exists site_id uuid references public.sites(id) on delete set null;

-- 3) Backfill non-relievers from the posting. Pure data write — the table's user
--    triggers are disabled for the statement and restored in the same transaction
--    (a confirmed month must not block it; a cleared guard's history must fill).
do $mig$
declare v_set int; v_null int; v_rel int;
begin
  alter table public.attendance_records disable trigger user;

  update public.attendance_records r
     set site_id = (
           select d.site_id
             from public.deployments d
            where d.guard_id = r.employee_id
              and d.site_id is not null
              and d.start_date <= r.attendance_date
              and (d.end_date is null or d.end_date >= r.attendance_date)
            order by d.start_date desc, d.created_at desc
            limit 1)
    from public.employees e
   where e.id = r.employee_id
     and e.category <> 'reliever'
     and r.site_id is null
     and exists (
           select 1 from public.deployments d
            where d.guard_id = r.employee_id
              and d.site_id is not null
              and d.start_date <= r.attendance_date
              and (d.end_date is null or d.end_date >= r.attendance_date));
  get diagnostics v_set = row_count;

  alter table public.attendance_records enable trigger user;

  select count(*) into v_null from public.attendance_records where site_id is null;
  select count(*) into v_rel  from public.attendance_records r
    join public.employees e on e.id = r.employee_id
   where e.category = 'reliever';
  raise notice '0449 backfill: % rows set; % rows left null (of which % reliever rows, left null by design).', v_set, v_null, v_rel;
end $mig$;

-- 4) attendance_records_enforce_reliever: derive site for non-relievers, require
--    it for present relievers (deriving worked_for_client_id from it), clear both
--    when not present.
do $mig$
declare
  v_src text; v_new text; v_cnt int;
  v_anchor_present text :=
'    if lower(new.status) = ''present'' and new.worked_for_client_id is null then
      raise exception ''Relievers marked present must record worked_for_client_id''
        using errcode = ''23514'';
    end if;
    if lower(new.status) <> ''present'' then
      new.worked_for_client_id := null;
    end if;';
  v_repl_present text :=
'    if lower(new.status) = ''present'' then
      if new.site_id is null and new.worked_for_client_id is null then
        raise exception ''Relievers marked present must record the site worked''
          using errcode = ''23514'';
      end if;
      if new.site_id is not null then
        new.worked_for_client_id := (select s.client_id from public.sites s where s.id = new.site_id);
      end if;
    else
      new.worked_for_client_id := null;
      new.site_id := null;
    end if;';
  v_anchor_nonrel text :=
'    v_client := public.deployment_client_on(new.employee_id, new.attendance_date);
    new.worked_for_client_id := coalesce(v_client, emp_client);';
  v_repl_nonrel text :=
'    v_client := public.deployment_client_on(new.employee_id, new.attendance_date);
    new.worked_for_client_id := coalesce(v_client, emp_client);
    new.site_id := public.deployment_site_on(new.employee_id, new.attendance_date);';
begin
  v_src := pg_get_functiondef('public.attendance_records_enforce_reliever()'::regprocedure);

  v_cnt := (length(v_src) - length(replace(v_src, v_anchor_present, ''))) / length(v_anchor_present);
  if v_cnt <> 1 then raise exception '0449 REFUSED: reliever present-anchor found % times (want 1).', v_cnt; end if;
  v_cnt := (length(v_src) - length(replace(v_src, v_anchor_nonrel, ''))) / length(v_anchor_nonrel);
  if v_cnt <> 1 then raise exception '0449 REFUSED: reliever non-reliever-anchor found % times (want 1).', v_cnt; end if;

  v_new := replace(v_src, v_anchor_present, v_repl_present);
  v_new := replace(v_new, v_anchor_nonrel, v_repl_nonrel);
  execute v_new;
end $mig$;

-- 5) enforce_attendance_month_lock: relievers now lock under the site worked
--    (its client on the row), not category. Single anchor: the employee lookup.
do $mig$
declare
  v_src text; v_new text; v_cnt int;
  v_anchor text :=
'  select client_id, category into v_client, v_cat from public.employees where id = v_emp;';
  v_repl text :=
'  select client_id, category into v_client, v_cat from public.employees where id = v_emp;
  -- Relievers hold no client on employees; they are locked by the SITE worked,
  -- resolved to that site''s client on the row itself (0449). Fall through to the
  -- client branch so the same verification that locks the site locks the reliever.
  if v_cat = ''reliever'' then
    v_client := case when TG_OP = ''DELETE'' then OLD.worked_for_client_id else NEW.worked_for_client_id end;
    v_cat := null;
  end if;';
begin
  v_src := pg_get_functiondef('public.enforce_attendance_month_lock()'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_cnt <> 1 then raise exception '0449 REFUSED: month-lock employee-lookup anchor found % times (want 1).', v_cnt; end if;
  v_new := replace(v_src, v_anchor, v_repl);
  execute v_new;
end $mig$;

-- 6) Verify the things that can break.
do $mig$
declare v_rel text; v_lock text;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='attendance_records' and column_name='site_id') then
    raise exception '0449 FAILED: attendance_records.site_id was not added.';
  end if;
  v_rel := pg_get_functiondef('public.attendance_records_enforce_reliever()'::regprocedure);
  if position('deployment_site_on' in v_rel) = 0 then
    raise exception '0449 FAILED: reliever trigger does not derive site for non-relievers.';
  end if;
  if position('record the site worked' in v_rel) = 0 then
    raise exception '0449 FAILED: reliever trigger does not require the site for present relievers.';
  end if;
  v_lock := pg_get_functiondef('public.enforce_attendance_month_lock()'::regprocedure);
  if position('locked by the SITE worked' in v_lock) = 0 then
    raise exception '0449 FAILED: month lock still keys relievers on category.';
  end if;
end $mig$;

-- 7) Tenant-guard tail.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0449 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;