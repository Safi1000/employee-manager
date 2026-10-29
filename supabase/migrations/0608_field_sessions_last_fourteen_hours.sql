-- 0608 — field sessions last fourteen hours
--
-- Shayan, 29 Oct 2026: asked whether supervisors should keep 0600's 8-hour
-- session cap, which would sign them out partway through a long shift — "yes
-- 14 hours minimum". A site-supervisor login's session now lasts 14 hours from
-- sign-in; every other login keeps 8. The field app shows its own countdown
-- against the same 14.
--
-- Surgery on api_request_gate (authors 0585, 0591, 0600, 0607): 0600's
-- interval becomes conditional on is_site_supervisor() (0607), anchor asserted
-- exactly once. A second run finds the new text and changes nothing.
--
-- Asserted with sessions made for the test (rolled back by a sentinel whose
-- message is checked): as a supervisor, a 10-hour-old session passes and a
-- 15-hour-old one is refused with 0600's exact message; as an office login, a
-- 10-hour-old session is still refused.

do $surgery$
declare
  v_def text := pg_get_functiondef('public.api_request_gate()'::regprocedure);
  v_old constant text := $old$s.created_at < now() - interval '8 hours') then$old$;
  v_new constant text := $new$s.created_at < now() - case when public.is_site_supervisor() then interval '14 hours' else interval '8 hours' end) then  -- 0608: field logins 14h$new$;
  v_n int;
begin
  if position('-- 0608: field logins 14h' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_n <> 1 then raise exception '0608 REFUSED: the anchor appears % times in api_request_gate, not once.', v_n; end if;
  execute replace(v_def, v_old, v_new);
end $surgery$;

do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_s10 uuid := gen_random_uuid(); v_s15 uuid := gen_random_uuid(); v_b10 uuid := gen_random_uuid();
  v_msg text;
begin
  begin
    update public.profiles set user_type = 'site_supervisor' where id = v_hr;
    insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
      (v_s10, v_hr, now() - interval '10 hours', now(), 'aal1'),
      (v_s15, v_hr, now() - interval '15 hours', now(), 'aal1'),
      (v_b10, v_boss, now() - interval '10 hours', now(), 'aal2');
    insert into public.field_devices (user_id, device_id, status) values (v_hr, 'test-phone-0608', 'active');
    perform set_config('request.path', '/rpc/field_me', true);
    perform set_config('request.method', 'POST', true);
    perform set_config('request.headers', '{"x-bastion-device":"test-phone-0608"}', true);

    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated', 'session_id', v_s10, 'aal', 'aal1')::text, true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is not null then raise exception '0608 REFUSED: a 10-hour field session was refused: "%".', v_msg; end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated', 'session_id', v_s15, 'aal', 'aal1')::text, true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'session expired: sessions last 8 hours, sign in again' then raise exception '0608 REFUSED: a 15-hour field session said "%".', v_msg; end if;

    perform set_config('request.path', '/companies', true);
    perform set_config('request.method', 'GET', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated', 'session_id', v_b10, 'aal', 'aal2')::text, true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'session expired: sessions last 8 hours, sign in again' then raise exception '0608 REFUSED: a 10-hour office session said "%".', v_msg; end if;
    raise exception '0608-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0608-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.headers', '', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0608 REFUSED: security_gaps() reports a gap.'; end if;
end $test$;
