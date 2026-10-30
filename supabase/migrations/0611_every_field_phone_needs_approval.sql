-- 0611 — every field phone waits for approval, the first one too
--
-- Shayan, 30 Oct 2026, testing the field app on a spare phone: "it didn't wait
-- for my approval, logged in directly". 0607 approved a login's FIRST phone at
-- once and held only later phones. So whoever signed in first with a code and
-- PIN owned the login — a PIN overheard before the supervisor ever opened the
-- app was enough to take it. Now every new phone is 'pending' until a super
-- admin approves it, and every one raises the alert.
--
-- The alert named Access & Governance › Field accounts; that card is gone
-- (c571906). It now names Operations › Field Supervisors, where the phone shows
-- as "phone waiting" with Approve / Refuse.
--
-- Each alert now names its own phone row. 0607 passed no reference, and
-- raise_alert folds open alerts on (company, category, ref_table, ref_id) — so
-- every phone request rewrote the one open phone alert instead of adding its
-- own, and two supervisors asking at once left only the second visible. Found
-- by this migration's own test, which expected a new row and got none.
--
-- Phones already approved stay approved: re-registering a known phone returns
-- its status unchanged (Safi EMP-0709's Redmi, approved on the page at 08:08
-- today after his TECNO was cut off, keeps working).
--
-- field_register_device has one author (0607), so it is restated — behind a
-- digest of the body 0607 left. Any other body means an edit nobody recorded,
-- and the migration refuses rather than overwrite it.
--
-- Asserted with the HR login made a field login for the test (rolled back by a
-- sentinel whose message is checked): its first phone comes back 'pending' and
-- the gate refuses that phone's roster call with the approval message; an
-- approved phone re-registers as 'active'; each new phone raises its OWN alert
-- naming Field Supervisors.

do $pre$
begin
  if encode(sha256(convert_to(pg_get_functiondef('public.field_register_device(text,text)'::regprocedure), 'UTF8')), 'hex')
       not in ('eb0e493ec88a5788ac95bf2c3a61104749dd587f358a475997bc4832fdaa27ed')
     and position('-- 0611.' in pg_get_functiondef('public.field_register_device(text,text)'::regprocedure)) = 0 then
    raise exception '0611 REFUSED: field_register_device is not the body 0607 left — an unrecorded edit. Amend by surgery instead.';
  end if;
end $pre$;

create or replace function public.field_register_device(p_device_id text, p_label text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
  -- 0611. This phone: its status if known; otherwise 'pending' until a super admin approves it.
  declare v_status text; v_name text; v_dev uuid; v_label text := nullif(left(btrim(coalesce(p_label, '')), 120), '');
  begin
    if not public.is_site_supervisor() then raise exception 'Only field logins register phones.' using errcode = '42501'; end if;
    if length(coalesce(btrim(p_device_id), '')) < 8 then raise exception 'This phone did not identify itself.'; end if;
    select status into v_status from public.field_devices where user_id = auth.uid() and device_id = btrim(p_device_id);
    if v_status is not null then
      update public.field_devices set last_seen = now(), label = coalesce(v_label, label)
       where user_id = auth.uid() and device_id = btrim(p_device_id);
      return v_status;
    end if;
    insert into public.field_devices (user_id, device_id, label, status, last_seen)
    values (auth.uid(), btrim(p_device_id), v_label, 'pending', now())
    returning id into v_dev;
    select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
    perform public.raise_alert(public.current_company_id(), 'warning', 'security',
      v_name || ' wants to use the field app on ' || coalesce(v_label, 'a phone') || '. Approve or refuse it in Operations › Field Supervisors.',
      'field_devices', v_dev, null);
    return 'pending';
  end $$;
comment on function public.field_register_device(text, text) is
  'TENANT GUARD EXEMPT: no uuid argument; registers the CALLER''s phone. Every new phone is pending until a super admin approves it (0611; 0607 approved the first at once).';

do $test$
declare
  v_hr constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site uuid := (select s.id from public.sites s where s.company_id = v_co order by s.name limit 1);
  v_got text; v_msg text; v_alerts int;
begin
  begin
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    delete from public.field_devices where user_id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    perform set_config('request.method', 'POST', true);

    select count(*) into v_alerts from public.alerts where company_id = v_co;
    v_got := public.field_register_device('test-phone-0611-a', 'Test phone A');
    if v_got is distinct from 'pending' then raise exception '0611 REFUSED: a login''s first phone came back "%".', v_got; end if;
    if not exists (select 1 from public.alerts where company_id = v_co and message like '% wants to use the field app on Test phone A. Approve or refuse it in Operations › Field Supervisors.')
       or (select count(*) from public.alerts where company_id = v_co) <> v_alerts + 1 then
      raise exception '0611 REFUSED: the first phone raised no alert naming Field Supervisors.';
    end if;

    perform set_config('request.path', '/rpc/field_site_roster', true);
    perform set_config('request.headers', json_build_object('x-bastion-device', 'test-phone-0611-a')::text, true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'This phone is not approved for this login. Ask your office to approve it.' then
      raise exception '0611 REFUSED: the gate let a pending phone through: "%".', v_msg;
    end if;

    update public.field_devices set status = 'active' where user_id = v_hr and device_id = 'test-phone-0611-a';
    v_got := public.field_register_device('test-phone-0611-a', null);
    if v_got is distinct from 'active' then raise exception '0611 REFUSED: an approved phone re-registered as "%".', v_got; end if;
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is not null then raise exception '0611 REFUSED: the gate refused an approved phone: "%".', v_msg; end if;

    v_got := public.field_register_device('test-phone-0611-b', 'Test phone B');
    if v_got is distinct from 'pending' then raise exception '0611 REFUSED: a second phone came back "%".', v_got; end if;
    if (select count(*) from public.alerts where company_id = v_co) <> v_alerts + 2 then
      raise exception '0611 REFUSED: the second phone folded into the first phone''s alert.';
    end if;
    raise exception '0611-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0611-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.headers', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0611 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0611 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
