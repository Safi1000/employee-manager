-- 0497 — The Attendance Run has its own permission, and unverified attendance
--        is reminded about the way uninvoiced clients are.
--
-- Asked for on 2026-10-05:
--
-- 1. attendance.run_view — "View the Attendance Run". The page is reachable
--    with it or with attendance.ops_verify (Ops must see what they verify).
--    It gates a page, not a write, so no function demands it; it is catalogued
--    so the grant screen can offer it.
--
-- 2. Reminders. "Same rules as the invoice reminders": the invoice arm of the
--    daily compliance email (0358/0362) lists, on every ODD day of the month
--    (is_invoice_reminder_day), what is still not done, and keeps arriving until
--    it is. Attendance follows the same cadence, reusing that predicate rather
--    than restating it, so the two cannot drift.
--
--    What is "not done": every half-month that has ENDED, in the previous or
--    the current month, for every client / staff group that has attendance in
--    it, that is either not HR-verified, or HR-verified and still waiting on Ops.
--    A month carrying a pre-0493 monthly verification counts as done.
--
--    attendance_unverified_halves() is the list with no cadence — the
--    Compliance Calendar shows it every day as in-app alerts.
--    attendance_reminder_items() is the same list on reminder days only — the
--    email reads that one.
--
-- Scoping matches the half lock (0493): a client's own guards by their
-- client, relievers by the client they worked for, client-less staff by their
-- group.

-- ---------------------------------------------------------------------------
-- 1. Permission key.
-- ---------------------------------------------------------------------------
insert into public.permission_keys (key, grp, label)
values ('attendance.run_view', 'Attendance', 'View the Attendance Run')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The outstanding halves.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_unverified_halves(p_company_id uuid, p_date date default null)
returns table(period_month date, half int, half_start date, half_end date,
              client_id uuid, category text, scope_name text, stage text, reason text)
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
           case when e.category::text <> 'reliever' and e.client_id is null then e.category::text end as cat
      from halves hv
      join public.attendance_records ar on ar.attendance_date between hv.hs and hv.he
      join public.employees e on e.id = ar.employee_id
     where e.company_id = p_company_id
  )
  select s.pm, s.hf, s.hs, s.he, s.cid, s.cat,
         coalesce(c.name, initcap(replace(s.cat, '_', ' '))),
         case when v.hr_verified_at is null then 'hr' else 'ops' end,
         to_char(s.hs, 'FMDD') || '–' || to_char(s.he, 'FMDD Mon YYYY') ||
           case when v.hr_verified_at is null then ' not HR-verified'
                else ' HR-verified, waiting on Ops' end
    from scoped s
    left join public.clients c on c.id = s.cid
    left join public.attendance_half_verifications v
           on v.company_id = p_company_id and v.period_month = s.pm and v.half = s.hf
          and coalesce(v.client_id::text, 'cat:' || v.category) = coalesce(s.cid::text, 'cat:' || s.cat)
   where (s.cid is not null or s.cat is not null)
     and (v.ops_verified_at is null)
     and not exists (
           select 1 from public.attendance_month_verifications lm
            where lm.company_id = p_company_id and lm.period_month = s.pm
              and coalesce(lm.client_id::text, 'cat:' || lm.category) = coalesce(s.cid::text, 'cat:' || s.cat))
   order by s.pm, s.hf, 7;
end;
$$;

comment on function public.attendance_unverified_halves(uuid, date) is
  'Every ended half-month (previous or current month) with attendance that is not yet HR-verified, or HR-verified and waiting on Ops (0497). Pre-0493 monthly verifications count as done. Shown as in-app alerts on the Compliance Calendar.';

create or replace function public.attendance_reminder_items(p_company_id uuid, p_date date default null)
returns table(period_month date, half int, scope_name text, stage text, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_today date := coalesce(p_date, current_date);
begin
  -- tenant guard [claimed, as invoice_reminder_items]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- Same cadence as the invoice reminders, by the same predicate.
  if not public.is_invoice_reminder_day(v_today) then return; end if;
  return query
  select u.period_month, u.half, u.scope_name, u.stage, u.reason
    from public.attendance_unverified_halves(p_company_id, v_today) u;
end;
$$;

comment on function public.attendance_reminder_items(uuid, date) is
  'attendance_unverified_halves on reminder days only (every odd day, is_invoice_reminder_day — the invoice reminders'' cadence). Read by the send-compliance-alerts email (0497).';

revoke all on function public.attendance_unverified_halves(uuid, date) from public;
revoke all on function public.attendance_reminder_items(uuid, date) from public;
grant execute on function public.attendance_unverified_halves(uuid, date) to authenticated, service_role;
grant execute on function public.attendance_reminder_items(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Checks.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.permission_key_gaps()) then
    raise exception '0497 FAILED: permission_key_gaps() is not empty.';
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
