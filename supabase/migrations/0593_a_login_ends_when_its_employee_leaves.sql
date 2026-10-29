-- 0593 — a login ends when its employee leaves
--
-- Shayan, 29 Oct 2026: "continue with the list" — item 6 of the security
-- sweep: offboarding on autopilot.
--
-- When an employee's lifecycle_state moves into left, terminated, fired,
-- absconded or archived, every login linked to that employee
-- (profiles.employee_id, 0424) is disabled at once, exactly as
-- set_user_disabled (0591) would: profiles.disabled_at with the reason, the
-- auth user banned, every session ended. A 'security' alert says so. Moving
-- back to active does NOT re-enable the login — re-admitting someone is a
-- decision, taken in Access & Governance.
--
-- And security_gaps() (0590) gains a kind, 'login': a login linked to an
-- employee who has left but still enabled. So the nightly checks go red if the
-- trigger is ever bypassed (a bulk import, a disabled trigger).
--
-- What this cannot see: a login not linked to its employee. On 29 Oct only one
-- of nine logins was linked; the rest must be linked in Access & Governance for
-- this to reach them.
--
-- security_gaps has one author (0590): amended by surgery, anchor asserted once.
--
-- Asserted, in a block rolled back by a sentinel whose message is checked:
-- marking the linked employee 'left' disables and bans the linked login, ends
-- its sessions and raises one alert; security_gaps() stays empty; a login left
-- enabled against a departed employee is reported by security_gaps().

create or replace function public.disable_logins_of_departed_employee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
  -- 0593. A trigger on employees: the employee left, so the login linked to
  -- them stops. Never on re-activation.
  declare p record;
  begin
    if new.lifecycle_state::text not in ('left', 'terminated', 'fired', 'absconded', 'archived') then return new; end if;
    if old.lifecycle_state::text in ('left', 'terminated', 'fired', 'absconded', 'archived') then return new; end if;
    for p in select id, company_id, coalesce(full_name, email) as name from public.profiles
              where employee_id = new.id and disabled_at is null loop
      perform set_config('bastion.access_change', '0591', true);
      update public.profiles
         set disabled_at = now(),
             disabled_reason = format('Employee marked %s on %s', new.lifecycle_state, to_char(current_date, 'DD Mon YYYY')),
             disabled_by = auth.uid()
       where id = p.id;
      perform set_config('bastion.access_change', '', true);
      update auth.users set banned_until = 'infinity' where id = p.id;
      delete from auth.sessions where user_id = p.id;
      if p.company_id is not null then
        perform public.raise_alert(p.company_id, 'warning', 'security',
          format('%s''s login was disabled: their employee record was marked %s.', p.name, new.lifecycle_state),
          'profiles', p.id, null);
      end if;
    end loop;
    return new;
  end $$;
revoke all on function public.disable_logins_of_departed_employee() from public, anon, authenticated;
drop trigger if exists trg_zz_disable_logins_of_departed_employee on public.employees;
create trigger trg_zz_disable_logins_of_departed_employee
  after update of lifecycle_state on public.employees
  for each row execute function public.disable_logins_of_departed_employee();

do $surgery$
declare
  v_def text := pg_get_functiondef('public.security_gaps()'::regprocedure);
  a constant text := E'  union all\n  select ''api'', ''authenticator''';
  v_n int;
begin
  if position('0593' in v_def) > 0 then return; end if;   -- replay
  v_n := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
  if v_n <> 1 then raise exception '0593 REFUSED: the api anchor appears % times in security_gaps.', v_n; end if;
  execute replace(v_def, a,
       E'  union all\n'
    || E'  -- 0593. A login whose linked employee has left, still able to sign in.\n'
    || E'  select ''login'', coalesce(p.full_name, p.email, p.id::text), ''linked employee is '' || e.lifecycle_state::text || '' but the login is not disabled''\n'
    || E'    from public.profiles p join public.employees e on e.id = p.employee_id\n'
    || E'   where p.disabled_at is null\n'
    || E'     and e.lifecycle_state::text in (''left'', ''terminated'', ''fired'', ''absconded'', ''archived'')\n'
    || a);
end $surgery$;

do $test$
declare
  v_profile uuid; v_emp uuid; v_alerts bigint; v_msg text; v_state text;
begin
  select p.id, p.employee_id, e.lifecycle_state::text into v_profile, v_emp, v_state
    from public.profiles p join public.employees e on e.id = p.employee_id limit 1;
  if v_profile is null then raise exception '0593 REFUSED: no linked login to test with.'; end if;
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into auth.sessions (id, user_id, created_at, updated_at) values (gen_random_uuid(), v_profile, now(), now());
    select count(*) into v_alerts from public.alerts where category = 'security';
    update public.employees set lifecycle_state = 'left' where id = v_emp;
    if (select disabled_at from public.profiles where id = v_profile) is null then raise exception '0593 REFUSED: the login was not disabled.'; end if;
    if (select banned_until from auth.users where id = v_profile) is distinct from 'infinity'::timestamptz then raise exception '0593 REFUSED: the login was not banned.'; end if;
    if exists (select 1 from auth.sessions where user_id = v_profile) then raise exception '0593 REFUSED: a session survived.'; end if;
    if (select count(*) from public.alerts where category = 'security') <> v_alerts + 1 then raise exception '0593 REFUSED: not exactly one alert.'; end if;
    if exists (select 1 from public.security_gaps()) then raise exception '0593 REFUSED: security_gaps() reports a gap after the disable.'; end if;
    -- and a login left enabled against a departed employee is reported
    perform set_config('bastion.access_change', '0591', true);
    update public.profiles set disabled_at = null where id = v_profile;
    perform set_config('bastion.access_change', '', true);
    if not exists (select 1 from public.security_gaps() where kind = 'login') then raise exception '0593 REFUSED: security_gaps() missed an enabled login of a departed employee.'; end if;
    raise exception '0593-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0593-SENTINEL' then raise; end if;
  end;
  if exists (select 1 from public.security_gaps()) then raise exception '0593 REFUSED: security_gaps() reports a gap.'; end if;
end $test$;
