-- 0600 — a session lasts eight hours
--
-- Shayan, 29 Oct 2026: "a session time limit of 8 hrs", then "yes" to holding
-- it on the server too. The browser already signs a session out 8 hours after
-- sign-in (InactivityLogout.tsx, after a 10-minute countdown), but a browser
-- rule binds only browsers that run it: a token copied out of one keeps working
-- against the API for as long as it can be refreshed. api_request_gate() now
-- refuses any request whose session began more than 8 hours ago.
--
--   auth.sessions.created_at is the sign-in. A token refresh does not move it,
--   and neither does the two-factor step-up (same session, aal raised).
--
-- Surgery: api_request_gate() has two authors (0585, restated by 0591), so the
-- check is inserted against the live definition, after the "session ended"
-- check, with that anchor asserted exactly once. A second run finds the new
-- check already present and changes nothing.
--
-- Asserted on what can break, with two sessions made for the test and rolled
-- back by a sentinel whose message is checked: a 9-hour-old session is refused
-- with exactly this message, and a 1-hour-old one passes.

do $surgery$
declare
  v_def text := pg_get_functiondef('public.api_request_gate()'::regprocedure);
  v_old constant text := $old$      raise exception 'session ended: sign in again' using errcode = '42501';
    end if;$old$;
  v_new constant text := $new$      raise exception 'session ended: sign in again' using errcode = '42501';
    end if;
    -- 0600: a session lasts 8 hours from sign-in; a refresh does not restart it.
    if v_sid is not null and exists (select 1 from auth.sessions s where s.id = v_sid and s.created_at < now() - interval '8 hours') then
      raise exception 'session expired: sessions last 8 hours, sign in again' using errcode = '42501';
    end if;$new$;
  v_n int;
begin
  if position('-- 0600: a session lasts 8 hours' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_n <> 1 then raise exception '0600 REFUSED: the anchor appears % times in api_request_gate, not once.', v_n; end if;
  execute replace(v_def, v_old, v_new);
end $surgery$;

do $test$
declare
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_old_s uuid := gen_random_uuid();
  v_new_s uuid := gen_random_uuid();
  v_msg text;
begin
  begin
    insert into auth.sessions (id, user_id, created_at, updated_at, aal)
    values (v_old_s, v_boss, now() - interval '9 hours', now(), 'aal2'),
           (v_new_s, v_boss, now() - interval '1 hour', now(), 'aal2');
    perform set_config('request.path', '/companies', true);
    perform set_config('request.method', 'GET', true);

    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated', 'session_id', v_old_s, 'aal', 'aal2')::text, true);
    v_msg := null;
    begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'session expired: sessions last 8 hours, sign in again' then
      raise exception '0600 REFUSED: a 9-hour-old session got "%".', v_msg;
    end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated', 'session_id', v_new_s, 'aal', 'aal2')::text, true);
    v_msg := null;
    begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is not null then raise exception '0600 REFUSED: a 1-hour-old session was refused: "%".', v_msg; end if;

    raise exception '0600-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0600-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0600 REFUSED: security_gaps() reports a gap.'; end if;
end $test$;
