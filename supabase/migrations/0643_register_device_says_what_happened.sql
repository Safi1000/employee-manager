-- 0643 — field_register_device answers with the phone's real status.
--
-- Shayan, 5 Nov 2026, after Apple asked for a screen recording: "if you click on
-- check again it opens". On a new phone field_register_device inserted the row
-- as 'pending' and then RETURNED the literal 'pending' — but for the demo
-- company the BEFORE INSERT triggers from 0629/0630 approve the phone on the way
-- in, so the row was already 'active'. The app showed "waiting for approval"
-- until the person pressed Check again, when the second call found the row and
-- returned its true status. That is the first thing a store reviewer sees.
--
-- The fix returns the status the row was actually saved with. For every real
-- company nothing changes: a new phone is still pending until a super admin
-- approves it. field_register_device has several authors (0607, 0611, 0612,
-- 0636), so this is surgery against the live text, its anchor asserted once.

do $surgery$
declare
  v_def text := pg_get_functiondef('public.field_register_device'::regproc);
  a1 constant text := E'    return ''pending'';\n  end';
  n int;
begin
  n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  if n <> 1 then raise exception '0643 REFUSED: the return anchor in field_register_device appears % times, expected once.', n; end if;
  execute replace(v_def, a1,
    E'    -- 0643: the status the row was saved with — a trigger may have approved it on the way in.\n'
    || E'    return coalesce((select status from public.field_devices where id = v_dev), ''pending'');\n  end');
end
$surgery$;

-- ───────────────────────── Tests (rolled back) ─────────────────────────
do $test$
declare
  v_demo constant uuid := '562a641e-40f0-4bce-9cbe-6713159a4753';  -- NGS-001, Northgate Security (Demo)
  v_safi constant uuid := '5ecf72e7-3b6b-494c-86e3-0200ad5c2e13';  -- a GGS supervisor login
  v_r text; v_msg text; v_ran int := 0;
begin
  begin
    -- 1. A new phone on the demo login comes back active on the FIRST call.
    perform set_config('request.jwt.claims', json_build_object('sub', v_demo, 'role', 'authenticated')::text, true);
    v_r := public.field_register_device('TEST-0643-DEMO-PHONE', 'Reviewer iPhone');
    if v_r is distinct from 'active' then raise exception '0643 REFUSED: an auto-approved phone still answered %.', v_r; end if;
    v_ran := v_ran + 1;

    -- 2. A new phone on a real company's login still waits for approval.
    perform set_config('request.jwt.claims', json_build_object('sub', v_safi, 'role', 'authenticated')::text, true);
    v_r := public.field_register_device('TEST-0643-GGS-PHONE', 'Test phone');
    if v_r is distinct from 'pending' then raise exception '0643 REFUSED: a real company''s new phone answered % instead of pending.', v_r; end if;
    v_ran := v_ran + 1;

    perform set_config('request.jwt.claims', '{}', true);
    if v_ran <> 2 then raise exception '0643 REFUSED: % of 2 assertions ran.', v_ran; end if;
    raise exception '0643-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0643-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0643 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0643 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
