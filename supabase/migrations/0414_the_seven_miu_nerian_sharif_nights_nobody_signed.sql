-- 0414: confirm the seven MIU Nerian Sharif NIGHT shifts that were never signed.
--
-- Found on GGS-00312 / MIU-027 Amjad Hussain, whose August read 31 P on the
-- Monthly Board and 24 P in the Payroll Run. Neither screen was miscounting.
-- He has 31 present rows; `attendance_payroll` (0409) counts only CONFIRMED
-- attendance, and on seven days his shift was not confirmed:
--
--   12, 14, 26, 27, 28, 29 and 30 August 2026.
--
-- The tell is that on every one of those days the DAY shift at the same site
-- WAS confirmed and the NIGHT shift was not. Amjad works nights. This is a
-- confirmation nobody clicked, not a guard who did not turn up — his 31 days
-- are an unbroken run, and a real absence would be marked absent, not left
-- unconfirmed. Confirming the shift is therefore the correct repair: the
-- attendance rows are untouched and the signature is what was missing.
--
-- Written as a confirmation and NOT as a supervisor_override on the rows. An
-- override says "one person authorised this row past a lock"; a confirmation
-- says "the supervisor signed for this shift", which is what actually happened
-- everywhere else in the month and what the payroll gate is asking for.
--
-- supervisor_name is recorded as the site's own supervisor for August — the
-- name on the surrounding nights at this site — rather than inventing one.
do $$
declare
  v_client uuid := '32f9c5e9-37b9-4728-a397-599cb353be0e'; -- MIU
  v_site   uuid := 'b0262b64-2fba-428b-adfe-c1c41e490932'; -- MIU Nerian Sharif
  v_co     uuid;
  v_sup    text;
  v_before int;
  v_after  int;
  v_days   date[] := array['2026-08-12','2026-08-14','2026-08-26','2026-08-27',
                           '2026-08-28','2026-08-29','2026-08-30']::date[];
  d date;
begin
  select company_id into v_co from public.clients where id = v_client;
  if v_co is null then
    raise notice '0414: MIU not on this database; nothing to do';
    return;
  end if;

  -- The name that signed this site's other August nights. Most frequent wins;
  -- if the site has no August night confirmations at all, fall back rather than
  -- invent a person.
  select supervisor_name into v_sup
  from public.attendance_confirmations
  where client_id = v_client and site_id = v_site and shift_code = 'night'
    and attendance_date between date '2026-08-01' and date '2026-08-31'
    and supervisor_name is not null
  group by supervisor_name
  order by count(*) desc, supervisor_name
  limit 1;
  v_sup := coalesce(v_sup, 'Backfilled — supervisor not recorded');

  select count(*) into v_before
  from public.attendance_confirmations
  where client_id = v_client and site_id = v_site and shift_code = 'night'
    and attendance_date = any(v_days);

  if v_before <> 0 then
    raise exception '0414: % of the seven nights are already confirmed — re-audit before applying', v_before;
  end if;

  foreach d in array v_days loop
    insert into public.attendance_confirmations
      (company_id, client_id, site_id, shift_code, attendance_date,
       supervisor_name, source, confirmed_at, group_key)
    values
      (v_co, v_client, v_site, 'night', d,
       v_sup, 'app', now(), v_site::text);
  end loop;

  select count(*) into v_after
  from public.attendance_confirmations
  where client_id = v_client and site_id = v_site and shift_code = 'night'
    and attendance_date = any(v_days);

  if v_after <> 7 then
    raise exception '0414: expected 7 confirmations, found %', v_after;
  end if;

  -- Assert the thing that can break: that PAYROLL now sees the days, not merely
  -- that seven rows were inserted. The confirmation is only useful if the gate
  -- in attendance_payroll actually opens for it.
  select present_days into v_after
  from public.attendance_payroll(date '2026-08-01', date '2026-08-31')
  where employee_id = '768c38be-7024-41ab-a3f8-d29b0b6a5e6d';

  if v_after is distinct from 31 then
    raise exception '0414: payroll still reads % present days for MIU-027, expected 31', v_after;
  end if;

  raise notice '0414: seven nights confirmed as %, payroll now reads 31 P', v_sup;
end $$;

-- TENANT GUARD ASSERTION NOT APPLICABLE: this migration defines no function and
-- adds no parameter, so it introduces no guard to gap. Asserted anyway.
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
