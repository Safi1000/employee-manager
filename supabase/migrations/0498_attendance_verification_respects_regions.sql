-- 0498 — Attendance verification respects regions.
--
-- FOUND 2026-10-05. Nauman Ahmed (HR, assigned to ISB/RWP, holds
-- attendance.ops_verify) OPS-verified September for "Office staff" on 3 Oct.
-- A staff-group verification was keyed by (company, category) with no region,
-- so that one click verified and LOCKED September for all 11 office staff:
-- 7 at Head Office, 3 at ISB/RWP and 1 at Kashmir — 8 people he cannot even see.
-- The 0493 half-month design inherited the same key. Separately, nothing
-- checked that a client being verified sits in the caller's region; only the
-- screens hid other regions' clients.
--
-- DECIDED with the user the same day:
--   * Staff groups are verified PER REGION. A regional user verifies only their
--     own region's staff; a head-office user names the region they are
--     verifying. attendance_half_verifications and attendance_board_remarks
--     gain branch_id, set for staff-group rows and NULL for client rows (a
--     client carries its own region).
--   * A staff group's month is cleared for payroll only when EVERY region with
--     its staff (with attendance that month) has both halves Ops-verified.
--   * Clients: the caller must be allowed to act in the client's region
--     (assert_branch_writable), the same rule the rest of the ledger uses.
--   * Nauman's 3 Oct legacy monthly verification is LEFT AS IT IS, by the
--     user's decision. Legacy monthly rows still count as fully verified for
--     every region; no new legacy row can be written (0493 trigger).
--
-- 0 half-month verification rows existed when this was written, so changing
-- the key moves no data.
--
-- HOW THE FUNCTIONS ARE CHANGED (CLAUDE.md):
--   attendance_half_action, attendance_board_remark, attendance_month_cleared
--     and purge_attendance_after_separation have more than one author: anchored
--     surgery against the live definition, each anchor asserted to appear once.
--   attendance_halves_action, attendance_date_verified,
--     enforce_attendance_half_lock and attendance_unverified_halves have one
--     author each: restated, after asserting the live body is the one this
--     migration was written against (md5 of prosrc).
--   Where a signature gains p_branch_id, the edited text creates the new
--   overload and the old one is dropped.

-- ---------------------------------------------------------------------------
-- 0. Helper for anchored edits (session-local; gone after this migration).
-- ---------------------------------------------------------------------------
create or replace function pg_temp.cut(p_def text, p_anchor text, p_repl text, p_label text)
returns text language plpgsql as $$
declare n int;
begin
  n := (length(p_def) - length(replace(p_def, p_anchor, ''))) / length(p_anchor);
  if n <> 1 then
    raise exception '0498 REFUSED: % anchor appears % times, expected 1.', p_label, n;
  end if;
  return replace(p_def, p_anchor, p_repl);
end $$;

create or replace function pg_temp.expect_body(p_sig text, p_md5 text)
returns void language plpgsql as $$
declare v text;
begin
  select md5(prosrc) into v from pg_proc where oid = p_sig::regprocedure;
  if v is distinct from p_md5 then
    raise exception '0498 REFUSED: % has body % but this migration was written against %. Someone edited it since; re-derive.', p_sig, v, p_md5;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Region on the rows.
-- ---------------------------------------------------------------------------
alter table public.attendance_half_verifications
  add column if not exists branch_id uuid references public.branches(id) on delete cascade;
alter table public.attendance_board_remarks
  add column if not exists branch_id uuid references public.branches(id) on delete cascade;

comment on column public.attendance_half_verifications.branch_id is
  'Region of a STAFF-GROUP verification (0498): office staff etc. are verified per region. NULL for client rows, which take their region from the client.';
comment on column public.attendance_board_remarks.branch_id is
  'Region of a staff-group board''s remarks (0498). NULL for client boards.';

drop index if exists public.ahv_scope_unique;
create unique index ahv_scope_unique
  on public.attendance_half_verifications
  (company_id, period_month, half, coalesce(client_id::text, 'cat:' || category), coalesce(branch_id::text, ''));

-- ---------------------------------------------------------------------------
-- 2. Which regions a staff group has, read with full visibility.
-- ---------------------------------------------------------------------------
-- The payroll gate is RLS-scoped (invoker). Asked by a regional user, the
-- employees table would hide the other regions and the gate would answer
-- "cleared" over a smaller set — a refusal turned into a silently smaller
-- answer. So the region list is read here, definer, guarded to the caller's
-- own company.
create or replace function public.attendance_staff_regions(p_company_id uuid, p_category text, p_period_month date)
returns table(branch_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return query
  select distinct e.branch_id
    from public.employees e
    join public.attendance_records ar on ar.employee_id = e.id
   where e.company_id = p_company_id
     and e.category::text = p_category
     and e.client_id is null
     and ar.attendance_date >= date_trunc('month', p_period_month)::date
     and ar.attendance_date < (date_trunc('month', p_period_month) + interval '1 month')::date;
end;
$$;
comment on function public.attendance_staff_regions(uuid, text, date) is
  'Regions (branch_id, possibly NULL) where a staff group had attendance in a month (0498). Definer so the payroll gate sees every region whoever asks.';
revoke all on function public.attendance_staff_regions(uuid, text, date) from public;
grant execute on function public.attendance_staff_regions(uuid, text, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Is a date locked — now region-aware for staff groups.
-- ---------------------------------------------------------------------------
select pg_temp.expect_body('public.attendance_date_verified(uuid,text,date)', 'c2f982c36d18e5d6e4b850f9d8e1b5c1');

create or replace function public.attendance_date_verified(p_client uuid, p_category text, p_date date, p_branch uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.attendance_half_verifications h
     where h.period_month = date_trunc('month', p_date)::date
       and h.half = public.attendance_half_of(p_date)
       and h.hr_verified_at is not null
       and (h.client_id = p_client
            or (h.category is not null and h.category = p_category
                and h.branch_id is not distinct from p_branch))
  );
$$;
comment on function public.attendance_date_verified(uuid, text, date, uuid) is
  'True when p_date sits in a half-month HR has verified for this client, or for this staff group in this region (0498). Locks the day.';
grant execute on function public.attendance_date_verified(uuid, text, date, uuid) to authenticated;

-- The lock trigger (one author, 0493): restated with the employee's region.
select pg_temp.expect_body('public.enforce_attendance_half_lock()', '9ba5d2ea921bd7eb3a54b10a53efbfaa');

create or replace function public.enforce_attendance_half_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_emp uuid; v_date date; v_client uuid; v_cat text; v_branch uuid;
begin
  if public.is_maintenance_session() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then v_emp := old.employee_id; v_date := old.attendance_date;
  else v_emp := new.employee_id; v_date := new.attendance_date; end if;
  select client_id, category, branch_id into v_client, v_cat, v_branch from public.employees where id = v_emp;
  -- Relievers are scoped by the site's client on the row (0449), as in the
  -- monthly lock.
  if v_cat = 'reliever' then
    v_client := case when tg_op = 'DELETE' then old.worked_for_client_id else new.worked_for_client_id end;
    v_cat := null;
  end if;
  if v_client is null and v_cat is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if public.attendance_date_verified(v_client, case when v_client is null then v_cat end, v_date, v_branch) then
    raise exception 'Attendance for % is in a half-month that HR has verified, so it is locked. Ops must send it back to HR before it can be edited.',
      to_char(v_date, 'DD Mon YYYY');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- The separation purge (several authors): pass the employee's region.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.purge_attendance_after_separation()'::regprocedure);
  if position('a.attendance_date, new.branch_id)' in v_def) > 0 then return; end if;
  v_def := pg_temp.cut(v_def,
    'case when new.category::text = ''reliever'' then null else new.category::text end, a.attendance_date)',
    'case when new.category::text = ''reliever'' then null else new.category::text end, a.attendance_date, new.branch_id)',
    'purge_attendance_after_separation');
  execute v_def;
end $$;

drop function public.attendance_date_verified(uuid, text, date);

-- ---------------------------------------------------------------------------
-- 4. The step function: region guards and the region in the key.
-- ---------------------------------------------------------------------------
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.attendance_half_action(uuid,text,date,integer,text,text)'::regprocedure);

  v_def := pg_temp.cut(v_def,
    'p_note text DEFAULT NULL::text)' || chr(10) || ' RETURNS attendance_half_verifications',
    'p_note text DEFAULT NULL::text, p_branch_id uuid DEFAULT NULL::uuid)' || chr(10) || ' RETURNS attendance_half_verifications',
    'half_action signature');

  v_def := pg_temp.cut(v_def,
    '  v_n       int;' || chr(10) || 'begin',
    '  v_n       int;' || chr(10) || '  v_branch  uuid;' || chr(10) || 'begin',
    'half_action declare');

  v_def := pg_temp.cut(v_def,
    '  if p_half not in (1, 2) then raise exception ''Half must be 1 or 2.''; end if;' || chr(10),
    '  if p_half not in (1, 2) then raise exception ''Half must be 1 or 2.''; end if;' || chr(10) ||
    '' || chr(10) ||
    '  -- 0498: region. A client is verified only by someone allowed to act in its' || chr(10) ||
    '  -- region; a staff group is verified per region, and a regional user only' || chr(10) ||
    '  -- for their own.' || chr(10) ||
    '  perform public.assert_branch_in_company(p_branch_id);' || chr(10) ||
    '  if p_client_id is not null then' || chr(10) ||
    '    perform public.assert_branch_writable((select branch_id from public.clients where id = p_client_id));' || chr(10) ||
    '  else' || chr(10) ||
    '    perform public.assert_branch_writable(p_branch_id);' || chr(10) ||
    '    if p_branch_id is null and public.is_branched_user() and not public.is_super_super_admin() then' || chr(10) ||
    '      raise exception ''Pick the region whose % you are verifying.'', replace(p_category, ''_'', '' '');' || chr(10) ||
    '    end if;' || chr(10) ||
    '    v_branch := p_branch_id;' || chr(10) ||
    '  end if;' || chr(10),
    'half_action region guard');

  v_def := pg_temp.cut(v_def,
    '         = coalesce(p_client_id::text, ''cat:'' || p_category)' || chr(10) || '   for update;',
    '         = coalesce(p_client_id::text, ''cat:'' || p_category)' || chr(10) ||
    '     and h.branch_id is not distinct from v_branch' || chr(10) || '   for update;',
    'half_action lookup');

  v_def := pg_temp.cut(v_def,
    '      (company_id, client_id, category, period_month, half,' || chr(10) ||
    '       hr_verified_by, hr_verified_by_name, hr_verified_at, updated_at)' || chr(10) ||
    '    values (v_company, p_client_id, case when p_client_id is null then p_category end, v_month, p_half,' || chr(10) ||
    '            v_me, v_name, now(), now())' || chr(10) ||
    '    on conflict (company_id, period_month, half, coalesce(client_id::text, ''cat:'' || category))',
    '      (company_id, client_id, category, branch_id, period_month, half,' || chr(10) ||
    '       hr_verified_by, hr_verified_by_name, hr_verified_at, updated_at)' || chr(10) ||
    '    values (v_company, p_client_id, case when p_client_id is null then p_category end, v_branch, v_month, p_half,' || chr(10) ||
    '            v_me, v_name, now(), now())' || chr(10) ||
    '    on conflict (company_id, period_month, half, coalesce(client_id::text, ''cat:'' || category), coalesce(branch_id::text, ''''))',
    'half_action insert');

  v_def := pg_temp.cut(v_def,
    '      (company_id, client_id, category, period_month, half, kind, body, author_id, author_name)' || chr(10) ||
    '    values (v_company, p_client_id, case when p_client_id is null then p_category end, v_month, p_half,' || chr(10) ||
    '            ''returned'',',
    '      (company_id, client_id, category, branch_id, period_month, half, kind, body, author_id, author_name)' || chr(10) ||
    '    values (v_company, p_client_id, case when p_client_id is null then p_category end, v_branch, v_month, p_half,' || chr(10) ||
    '            ''returned'',',
    'half_action returned remark');

  execute v_def;
end $$;

drop function public.attendance_half_action(uuid, text, date, integer, text, text);
revoke all on function public.attendance_half_action(uuid, text, date, integer, text, text, uuid) from public;
grant execute on function public.attendance_half_action(uuid, text, date, integer, text, text, uuid) to authenticated;

-- One author (0494): restated with the region passed through.
select pg_temp.expect_body('public.attendance_halves_action(uuid,text,date,integer[],text,text)', '0bed1a7d91a8ac8621e097e201810780');
drop function public.attendance_halves_action(uuid, text, date, integer[], text, text);

create function public.attendance_halves_action(
  p_client_id uuid, p_category text, p_period_month date, p_halves int[],
  p_action text, p_note text default null, p_branch_id uuid default null)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare h int; v_n int := 0;
begin
  if p_halves is null or cardinality(p_halves) = 0 then
    raise exception 'Name at least one half.';
  end if;
  foreach h in array (select array_agg(distinct x order by x) from unnest(p_halves) x) loop
    perform public.attendance_half_action(p_client_id, p_category, p_period_month, h, p_action, p_note, p_branch_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
comment on function public.attendance_halves_action(uuid, text, date, int[], text, text, uuid) is
  'Runs attendance_half_action for each half named, in one transaction (0494); p_branch_id names the region of a staff group (0498).';
revoke all on function public.attendance_halves_action(uuid, text, date, int[], text, text, uuid) from public;
grant execute on function public.attendance_halves_action(uuid, text, date, int[], text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Remarks: the region is part of a staff group's board.
-- ---------------------------------------------------------------------------
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.attendance_board_remark(uuid,text,date,integer,text,uuid)'::regprocedure);

  v_def := pg_temp.cut(v_def,
    'p_parent_id uuid DEFAULT NULL::uuid)' || chr(10) || ' RETURNS attendance_board_remarks',
    'p_parent_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid)' || chr(10) || ' RETURNS attendance_board_remarks',
    'remark signature');

  v_def := pg_temp.cut(v_def,
    '    raise exception ''Give exactly one of a client or a staff group.'';' || chr(10) || '  end if;' || chr(10),
    '    raise exception ''Give exactly one of a client or a staff group.'';' || chr(10) || '  end if;' || chr(10) ||
    '  -- 0498: a staff group''s board is per region; post only to one you may act in.' || chr(10) ||
    '  perform public.assert_branch_in_company(p_branch_id);' || chr(10) ||
    '  if p_client_id is null then perform public.assert_branch_writable(p_branch_id); end if;' || chr(10),
    'remark region guard');

  v_def := pg_temp.cut(v_def,
    '          <> coalesce(p_client_id::text, ''cat:'' || p_category) then',
    '          <> coalesce(p_client_id::text, ''cat:'' || p_category)' || chr(10) ||
    '       or v_parent.branch_id is distinct from (case when p_client_id is null then p_branch_id end) then',
    'remark parent board');

  v_def := pg_temp.cut(v_def,
    '    (company_id, client_id, category, period_month, half, parent_id, kind, body, author_id, author_name)' || chr(10) ||
    '  values (v_company, p_client_id, case when p_client_id is null then p_category end,',
    '    (company_id, client_id, category, branch_id, period_month, half, parent_id, kind, body, author_id, author_name)' || chr(10) ||
    '  values (v_company, p_client_id, case when p_client_id is null then p_category end,' || chr(10) ||
    '          case when p_client_id is null then p_branch_id end,',
    'remark insert');

  execute v_def;
end $$;

drop function public.attendance_board_remark(uuid, text, date, integer, text, uuid);
revoke all on function public.attendance_board_remark(uuid, text, date, integer, text, uuid, uuid) from public;
grant execute on function public.attendance_board_remark(uuid, text, date, integer, text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Payroll gate: a staff group needs every region verified.
-- ---------------------------------------------------------------------------
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.attendance_month_cleared(uuid,text,date)'::regprocedure);
  if position('attendance_staff_regions' in v_def) > 0 then return; end if;
  v_def := pg_temp.cut(v_def,
    '      or (select count(*) = 2' || chr(10) ||
    '            from public.attendance_half_verifications h' || chr(10) ||
    '           where h.period_month = date_trunc(''month'', p_period_month)::date' || chr(10) ||
    '             and h.ops_verified_at is not null' || chr(10) ||
    '             and (h.client_id = p_client_id or (p_client_id is null and h.category = p_category)));',
    '      or (p_client_id is not null and (select count(*) = 2' || chr(10) ||
    '            from public.attendance_half_verifications h' || chr(10) ||
    '           where h.period_month = date_trunc(''month'', p_period_month)::date' || chr(10) ||
    '             and h.ops_verified_at is not null' || chr(10) ||
    '             and h.client_id = p_client_id))' || chr(10) ||
    '      -- 0498: a staff group is cleared when EVERY region that had its staff' || chr(10) ||
    '      -- on attendance this month has both halves Ops-verified.' || chr(10) ||
    '      or (p_client_id is null' || chr(10) ||
    '          and exists (select 1 from public.attendance_staff_regions(public.current_company_id(), p_category, p_period_month))' || chr(10) ||
    '          and not exists (' || chr(10) ||
    '            select 1 from public.attendance_staff_regions(public.current_company_id(), p_category, p_period_month) r' || chr(10) ||
    '             where (select count(*) from public.attendance_half_verifications h' || chr(10) ||
    '                     where h.period_month = date_trunc(''month'', p_period_month)::date' || chr(10) ||
    '                       and h.category = p_category' || chr(10) ||
    '                       and h.branch_id is not distinct from r.branch_id' || chr(10) ||
    '                       and h.ops_verified_at is not null) < 2));',
    'month_cleared');
  execute v_def;
end $$;

comment on function public.attendance_month_cleared(uuid, text, date) is
  'Payroll gate: a client is cleared when both halves are OPS-verified (0494); a staff group when every region with its staff on attendance that month has both halves OPS-verified (0498); or a pre-0493 monthly verification exists.';

-- ---------------------------------------------------------------------------
-- 7. Reminders and in-app alerts: staff groups per region, and a regional
--    user sees their own region.
-- ---------------------------------------------------------------------------
select pg_temp.expect_body('public.attendance_unverified_halves(uuid,date)', '7d01fa6eff7f90e433aaa9088d91fd97');
drop function public.attendance_unverified_halves(uuid, date);

create function public.attendance_unverified_halves(p_company_id uuid, p_date date default null)
returns table(period_month date, half int, half_start date, half_end date,
              client_id uuid, category text, branch_id uuid, scope_name text, stage text, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := coalesce(p_date, current_date);
begin
  -- tenant guard [claimed, as invoice_reminder_items]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  return query
  with halves as (
    select m::date as pm, h.h as hf, b.half_start as hs, b.half_end as he
      from generate_series(date_trunc('month', v_today) - interval '1 month',
                           date_trunc('month', v_today), interval '1 month') m
      cross join (values (1), (2)) h(h)
      cross join lateral public.attendance_half_bounds(m::date, h.h) b
     where b.half_end < v_today
  ),
  scoped as (
    select distinct hv.pm, hv.hf, hv.hs, hv.he,
           case when e.category::text = 'reliever' then ar.worked_for_client_id else e.client_id end as cid,
           case when e.category::text <> 'reliever' and e.client_id is null then e.category::text end as cat,
           case when e.category::text <> 'reliever' and e.client_id is null then e.branch_id end as bid
      from halves hv
      join public.attendance_records ar on ar.attendance_date between hv.hs and hv.he
      join public.employees e on e.id = ar.employee_id
     where e.company_id = p_company_id
  )
  select s.pm, s.hf, s.hs, s.he, s.cid, s.cat, s.bid,
         coalesce(c.name, initcap(replace(s.cat, '_', ' ')) || coalesce(' — ' || br.name, '')),
         case when v.hr_verified_at is null then 'hr' else 'ops' end,
         to_char(s.hs, 'FMDD') || '–' || to_char(s.he, 'FMDD Mon YYYY') ||
           case when v.hr_verified_at is null then ' not HR-verified'
                else ' HR-verified, waiting on Ops' end
    from scoped s
    left join public.clients c on c.id = s.cid
    left join public.branches br on br.id = s.bid
    left join public.attendance_half_verifications v
           on v.company_id = p_company_id and v.period_month = s.pm and v.half = s.hf
          and coalesce(v.client_id::text, 'cat:' || v.category) = coalesce(s.cid::text, 'cat:' || s.cat)
          and v.branch_id is not distinct from s.bid
   where (s.cid is not null or s.cat is not null)
     and (v.ops_verified_at is null)
     -- A regional user is shown their own region; head office, cron and the
     -- email (no region) see everything.
     and public.can_see_region(coalesce(c.branch_id, s.bid))
     and not exists (
           select 1 from public.attendance_month_verifications lm
            where lm.company_id = p_company_id and lm.period_month = s.pm
              and coalesce(lm.client_id::text, 'cat:' || lm.category) = coalesce(s.cid::text, 'cat:' || s.cat))
   order by s.pm, s.hf, 8;
end;
$$;

comment on function public.attendance_unverified_halves(uuid, date) is
  'Every ended half-month (previous or current month) with attendance not yet HR-verified, or waiting on Ops (0497). Staff groups per region and filtered to the caller''s region (0498). Pre-0493 monthly verifications count as done.';
revoke all on function public.attendance_unverified_halves(uuid, date) from public;
grant execute on function public.attendance_unverified_halves(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Checks.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.attendance_half_action(uuid,text,date,integer,text,text,uuid)') is null
     or to_regprocedure('public.attendance_half_action(uuid,text,date,integer,text,text)') is not null then
    raise exception '0498 FAILED: attendance_half_action overloads are not as intended.';
  end if;
  if to_regprocedure('public.attendance_board_remark(uuid,text,date,integer,text,uuid,uuid)') is null
     or to_regprocedure('public.attendance_board_remark(uuid,text,date,integer,text,uuid)') is not null then
    raise exception '0498 FAILED: attendance_board_remark overloads are not as intended.';
  end if;
  if position('assert_branch_writable' in pg_get_functiondef('public.attendance_half_action(uuid,text,date,integer,text,text,uuid)'::regprocedure)) = 0 then
    raise exception '0498 FAILED: the step function has no region guard.';
  end if;
  if position('new.branch_id)' in pg_get_functiondef('public.purge_attendance_after_separation()'::regprocedure)) = 0 then
    raise exception '0498 FAILED: separation purge does not pass the region.';
  end if;
  if exists (select 1 from public.permission_key_gaps()) then
    raise exception '0498 FAILED: permission_key_gaps() is not empty.';
  end if;
end $$;

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
