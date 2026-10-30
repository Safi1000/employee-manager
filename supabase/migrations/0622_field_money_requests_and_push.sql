-- 0622 — expense and advance requests from the field app, and push notifications
--
-- DECIDED by Shayan, 30 Oct 2026:
--   * Office staff record their own expenses and advances on the phone and see
--     ONLY what they added — "not the whole tab as shown in web".
--   * Money, "in a different way": NO two-way link. The app does not touch the
--     real money tables (expenses, advances, bank, cash). It writes to its own
--     panel, field_money_requests, and the web reads from there.
--   * Every request waits for approval on the web. Who approves is Shayan's to
--     decide: field.money_approve (new), granted per person.
--   * Push notifications: a new request reaches the approvers' phones; the
--     decision goes back to whoever asked.
--
-- What "approved" does: it approves the REQUEST. The office then records the
-- real expense or advance in Bastion as it does today (Expenses & Advances), and
-- marks the request "recorded" with a note — so the request, the decision and
-- the books stay separate, and nothing posts money from a phone.
--
--   field_money_requests              the app's own panel (kind expense | advance)
--   field_expense_categories()        the category list for the phone's picker
--   field_request_money(...)          field.expenses (new): own request, receipt photos
--   field_my_requests()               the caller's own requests, last 90 days
--   decide_field_money_request(...)   field.money_approve: approved / returned / rejected
--   mark_field_money_recorded(...)    field.money_approve or expenses.edit: put in the books
--
-- PUSH. push_tokens holds each phone's Expo push token (field_register_push).
-- queue_push() writes push_outbox and asks the push-send Edge Function to
-- deliver it (pg_net — sent only after the transaction commits, so a rolled-back
-- request notifies nobody). Delivery needs the phone build's push credentials
-- (Firebase for Android, the Apple push key for iPhone); until then the outbox
-- records "no devices" and the Bastion alert still fires.
--
-- Asserted under a sentinel: an office login with field.expenses requests an
-- expense with a receipt and sees only its own; without the key it is refused; a
-- supervisor is refused; the request alerts, logs a line and queues a push to
-- the approvers; deciding needs field.money_approve; returning needs a note; the
-- decision acknowledges the line and queues a push back; only an approved
-- request can be marked recorded; nothing is written to expenses or advances.

-- -------------------------------------------------------------- keys
insert into public.permission_keys (key, grp, label) values
  ('field.expenses', 'Field app', 'Field: request own expenses and advances (sees only their own)')
on conflict (key) do nothing;

-- -------------------------------------------------------------- photos may now be receipts, trip odometers and documents
alter table public.field_photos drop constraint if exists field_photos_kind_check;
alter table public.field_photos add constraint field_photos_kind_check
  check (kind in ('visit', 'incident', 'sos', 'task', 'daily_report', 'receipt', 'trip', 'document'));

-- field_store_photos (one author: 0614) — a photo need not belong to a site any
-- more: a receipt, a trip's odometer and an employee's document have none. The
-- site's company is still asserted whenever a site is given. Surgery, one line.
do $surgery$
declare
  v_def text := pg_get_functiondef('public.field_store_photos(uuid, text, text, uuid, text[], jsonb)'::regprocedure);
  a_old constant text := $a$    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));$a$;
  a_new constant text := $a$    -- 0622: a receipt, an odometer or a document has no site; the site is checked when given.
    if p_site_id is not null then perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id)); end if;$a$;
  v_n int;
begin
  if position('-- 0622: a receipt, an odometer' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, a_old, ''))) / length(a_old);
  if v_n <> 1 then raise exception '0622 REFUSED: field_store_photos anchor appears % times, not once.', v_n; end if;
  execute replace(v_def, a_old, a_new);
end $surgery$;

-- -------------------------------------------------------------- the app's money panel
create table if not exists public.field_money_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  kind            text not null check (kind in ('expense', 'advance')),
  requested_by    uuid not null references public.profiles (id),
  requester_name  text not null,
  amount          numeric(14, 2) not null check (amount > 0 and amount <= 10000000),
  category_id     uuid references public.expense_categories (id),
  category_name   text,
  description     text not null check (btrim(description) <> ''),
  expense_date    date not null,
  site_id         uuid references public.sites (id),
  status          text not null default 'pending' check (status in ('pending', 'approved', 'returned', 'rejected')),
  decided_by      uuid references public.profiles (id),
  decided_by_name text,
  decided_at      timestamptz,
  decision_note   text,
  recorded_at     timestamptz,
  recorded_by     uuid references public.profiles (id),
  recorded_note   text,
  geo             jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists field_money_requests_open on public.field_money_requests (company_id, status, created_at);
comment on table public.field_money_requests is
  'DECIDED 30 Oct 2026 (0622): the field app''s own money panel — expense and advance REQUESTS from office staff (field.expenses). No link to expenses/advances/bank/cash: approval (field.money_approve) approves the request; the office then records the real entry in Bastion and marks it recorded. Readable by the requester (own rows) and field.money_approve.';
alter table public.field_money_requests enable row level security;
drop policy if exists field_money_requests_read on public.field_money_requests;
create policy field_money_requests_read on public.field_money_requests for select using (
  company_id = (select public.current_company_id())
  and (requested_by = (select auth.uid()) or (select public.has_perm('field.money_approve'))));
revoke all on public.field_money_requests from anon;
grant select on public.field_money_requests to authenticated;

-- -------------------------------------------------------------- push
create table if not exists public.push_tokens (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  token      text not null,
  platform   text,
  updated_at timestamptz not null default now(),
  primary key (user_id, token)
);
comment on table public.push_tokens is '0622: Expo push tokens of the field app, one per phone per login. Written by field_register_push; read only by the push-send Edge Function (service role).';
alter table public.push_tokens enable row level security;
revoke all on public.push_tokens from anon, authenticated;

create table if not exists public.push_outbox (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id),
  user_ids   uuid[] not null,
  title      text not null,
  body       text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  result     text
);
comment on table public.push_outbox is '0622: push notifications to deliver; push-send marks each sent with its result ("no devices" until phones register).';
alter table public.push_outbox enable row level security;
revoke all on public.push_outbox from anon, authenticated;

create or replace function public.field_register_push(p_token text, p_platform text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0622. This phone's push token for the signed-in field login.
  begin
    if auth.uid() is null then raise exception 'Row not found' using errcode = '42501'; end if;
    if p_token is null or length(p_token) not between 10 and 300 then raise exception 'That push token is not valid.'; end if;
    insert into public.push_tokens (user_id, token, platform) values (auth.uid(), p_token, left(p_platform, 20))
    on conflict (user_id, token) do update set updated_at = now(), platform = excluded.platform;
  end $$;
comment on function public.field_register_push(text, text) is '0622: the field app registers the phone''s push token for the signed-in login.';
revoke all on function public.field_register_push(text, text) from public, anon;
grant execute on function public.field_register_push(text, text) to authenticated;

create or replace function public.queue_push(p_company_id uuid, p_user_ids uuid[], p_title text, p_body text, p_data jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
  -- 0622. Internal: queue a push and ask push-send to deliver it (after commit; never blocks the caller).
  -- tenant guard [exempt]: internal, revoked from every API role; callers pass their own company.
  declare v_id uuid; v_key text; v_url text;
  begin
    if coalesce(cardinality(p_user_ids), 0) = 0 then return null; end if;
    insert into public.push_outbox (company_id, user_ids, title, body, data) values (p_company_id, p_user_ids, p_title, p_body, coalesce(p_data, '{}'))
    returning id into v_id;
    begin
      select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key' limit 1;
      select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url' limit 1;
      v_url := coalesce(v_url, 'https://mmkfpnshxjcyijhuydgr.supabase.co');
      if v_key is not null then
        perform net.http_post(url := v_url || '/functions/v1/push-send',
          headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
          body := jsonb_build_object('outbox_id', v_id), timeout_milliseconds := 20000);
      end if;
    exception when others then null;  -- a push is a courtesy; the request itself must never fail for it
    end;
    return v_id;
  end $$;
comment on function public.queue_push(uuid, uuid[], text, text, jsonb) is
  'TENANT GUARD EXEMPT: internal (0622) — queues a push notification and invokes push-send; never raises.';
revoke all on function public.queue_push(uuid, uuid[], text, text, jsonb) from public, anon, authenticated;

create or replace function public.field_money_approvers(p_company_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  -- 0622. Internal: logins who may approve field money requests (field.money_approve, or super admin).
  -- tenant guard [exempt]: internal, revoked from every API role; reads the given company only.
  select coalesce(array_agg(p.id), '{}') from public.profiles p
   where p.company_id = p_company_id and p.disabled_at is null
     and (p.role in ('super_admin', 'super_super_admin') or 'field.money_approve' = any (coalesce(p.permissions, '{}')));
$$;
comment on function public.field_money_approvers(uuid) is 'TENANT GUARD EXEMPT: internal (0622) — who receives a new field money request push.';
revoke all on function public.field_money_approvers(uuid) from public, anon, authenticated;

-- -------------------------------------------------------------- the phone asks
create or replace function public.field_expense_categories()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0622. The expense categories, for the phone's picker. Names only.
  begin
    perform public.field_require('field.expenses');
    return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name), '[]'::jsonb)
              from public.expense_categories c where c.company_id = public.current_company_id());
  end $$;
comment on function public.field_expense_categories() is '0622: expense category names for the field app (field.expenses).';

create or replace function public.field_request_money(
  p_kind text, p_amount numeric, p_category_id uuid, p_description text, p_expense_date date,
  p_site_id uuid default null, p_photos text[] default '{}', p_geo jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
  -- 0622. An office login's own expense or advance REQUEST, into the app's panel. Touches no money table.
  declare v_me record; v_cat text; v_id uuid; v_geo jsonb; v_site uuid;
  begin
    perform public.field_require('field.expenses');
    -- tenant guard [resolved]: the category's and the site's company (each optional, so checked when given).
    if p_category_id is not null then perform public.assert_same_company((select c.company_id from public.expense_categories c where c.id = p_category_id)); end if;
    if p_site_id is not null then perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id)); end if;
    if p_kind is null or p_kind not in ('expense', 'advance') then raise exception 'Choose an expense or an advance.'; end if;
    if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount.'; end if;
    if p_amount > 10000000 then raise exception 'That amount is too large for the app. Record it in Bastion on the web.'; end if;
    if nullif(btrim(p_description), '') is null then raise exception 'Say what it was for.'; end if;
    if p_kind = 'expense' and p_category_id is null then raise exception 'Choose a category.'; end if;
    if p_expense_date is null or p_expense_date > public.field_today() or p_expense_date < public.field_today() - 30 then
      raise exception 'The date must be today or within the last 30 days.';
    end if;
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    select name into v_cat from public.expense_categories where id = p_category_id;
    v_site := case when p_site_id is not null and public.field_can_see_site(p_site_id) then p_site_id end;
    v_geo := case when v_site is not null then public.field_geo(v_site, p_geo) else null end;
    insert into public.field_money_requests (company_id, kind, requested_by, requester_name, amount, category_id, category_name,
                                            description, expense_date, site_id, geo)
    values (public.current_company_id(), p_kind, v_me.id, v_me.name, round(p_amount, 2), p_category_id, v_cat,
            btrim(p_description), p_expense_date, v_site, coalesce(v_geo, p_geo))
    returning id into v_id;
    perform public.field_store_photos(v_site, 'receipt', 'field_money_requests', v_id, p_photos, coalesce(v_geo, p_geo));

    perform public.field_log(p_kind, 'field_money_requests', v_id, v_site,
      initcap(p_kind) || ' request PKR ' || to_char(round(p_amount, 2), 'FM999,999,990.00') || coalesce(' — ' || v_cat, '') || ': ' || btrim(p_description), v_geo);
    perform public.raise_alert(public.current_company_id(), 'dashboard', 'field',
      v_me.name || ' requested ' || case when p_kind = 'advance' then 'an advance' else 'an expense' end || ' of PKR '
        || to_char(round(p_amount, 2), 'FM999,999,990') || ' from the field app. Decide it on Workforce › Field Review › Expense requests.',
      'field_money_requests', v_id, null);
    perform public.queue_push(public.current_company_id(), array_remove(public.field_money_approvers(public.current_company_id()), v_me.id),
      'New ' || p_kind || ' request', v_me.name || ': PKR ' || to_char(round(p_amount, 2), 'FM999,999,990') || ' — ' || btrim(p_description),
      jsonb_build_object('kind', 'money_request', 'id', v_id));
    return jsonb_build_object('id', v_id, 'status', 'pending');
  end $$;
comment on function public.field_request_money(text, numeric, uuid, text, date, uuid, text[], jsonb) is
  '0622: an office login''s own expense/advance request from the field app (field.expenses). Into field_money_requests only; alerts and pushes the approvers.';

create or replace function public.field_my_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0622. The caller's OWN requests, last 90 days — never anyone else's.
  begin
    perform public.field_require('field.expenses');
    return (select coalesce(jsonb_agg(jsonb_build_object(
              'id', r.id, 'kind', r.kind, 'amount', r.amount, 'category', r.category_name, 'description', r.description,
              'expense_date', r.expense_date, 'status', r.status, 'decision_note', r.decision_note, 'decided_by_name', r.decided_by_name,
              'recorded', r.recorded_at is not null, 'created_at', r.created_at) order by r.created_at desc), '[]'::jsonb)
              from public.field_money_requests r
             where r.requested_by = auth.uid() and r.created_at >= now() - interval '90 days');
  end $$;
comment on function public.field_my_requests() is '0622: the caller''s own expense/advance requests (last 90 days) for the field app.';

-- -------------------------------------------------------------- the web decides
create or replace function public.decide_field_money_request(p_id uuid, p_decision text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0622. Approve, return (fix and send again) or reject a pending request. Touches no money table.
  declare v_r record; v_name text; n int;
  begin
    if not public.has_perm('field.money_approve') then
      raise exception 'Deciding app expense requests needs the "Field: approve or return expense and advance requests from the app" permission.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the request's company.
    perform public.assert_same_company((select company_id from public.field_money_requests where id = p_id));
    if p_decision is null or p_decision not in ('approved', 'returned', 'rejected') then raise exception 'Approve, return or reject.'; end if;
    if p_decision <> 'approved' and nullif(btrim(p_note), '') is null then raise exception 'Say why, so the person who asked knows.'; end if;
    select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
    update public.field_money_requests set status = p_decision, decided_by = auth.uid(), decided_by_name = v_name, decided_at = now(),
           decision_note = nullif(btrim(p_note), '')
     where id = p_id and status = 'pending'
    returning * into v_r;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'That request is not waiting for a decision.'; end if;
    perform public.field_ack_ref('field_money_requests', p_id, initcap(v_r.kind) || ' request ' || p_decision);
    update public.alerts set state = 'resolved', acknowledged_by = auth.uid(), acknowledged_at = now()
     where ref_table = 'field_money_requests' and ref_id = p_id and state = 'open';
    perform public.queue_push(v_r.company_id, array[v_r.requested_by],
      initcap(v_r.kind) || ' request ' || p_decision,
      'PKR ' || to_char(v_r.amount, 'FM999,999,990') || ' — ' || v_r.description || coalesce(' · ' || nullif(btrim(p_note), ''), ''),
      jsonb_build_object('kind', 'money_decision', 'id', p_id));
  end $$;
comment on function public.decide_field_money_request(uuid, text, text) is
  '0622: field.money_approve approves, returns or rejects a field-app expense/advance request; acknowledges its line and pushes the decision to the requester.';

create or replace function public.mark_field_money_recorded(p_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0622. The office has recorded this approved request in Bastion's books (by hand, on the web).
  declare n int;
  begin
    if not (public.has_perm('field.money_approve') or public.has_perm('expenses.edit')) then
      raise exception 'Marking a request recorded needs app-request approval or expenses permission.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the request's company.
    perform public.assert_same_company((select company_id from public.field_money_requests where id = p_id));
    update public.field_money_requests set recorded_at = now(), recorded_by = auth.uid(), recorded_note = nullif(btrim(p_note), '')
     where id = p_id and status = 'approved' and recorded_at is null;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'Only an approved request that is not yet recorded can be marked recorded.'; end if;
  end $$;
comment on function public.mark_field_money_recorded(uuid, text) is '0622: marks an approved field-app request as entered in Bastion''s books by the office.';

revoke all on function public.field_expense_categories() from public, anon;
grant execute on function public.field_expense_categories() to authenticated;
revoke all on function public.field_request_money(text, numeric, uuid, text, date, uuid, text[], jsonb) from public, anon;
grant execute on function public.field_request_money(text, numeric, uuid, text, date, uuid, text[], jsonb) to authenticated;
revoke all on function public.field_my_requests() from public, anon;
grant execute on function public.field_my_requests() to authenticated;
revoke all on function public.decide_field_money_request(uuid, text, text) from public, anon;
grant execute on function public.decide_field_money_request(uuid, text, text) to authenticated;
revoke all on function public.mark_field_money_recorded(uuid, text) from public, anon;
grant execute on function public.mark_field_money_recorded(uuid, text) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('field_register_push', null, 'EXEMPT 0622: the caller''s own phone token'),
  ('field_expense_categories', null, 'EXEMPT 0622: field_require(field.expenses) inside'),
  ('field_request_money', null, 'EXEMPT 0622: field_require(field.expenses) inside'),
  ('field_my_requests', null, 'EXEMPT 0622: field_require(field.expenses) inside; own rows only'),
  ('decide_field_money_request', '{field.money_approve}', '0622: decide a field-app money request'),
  ('mark_field_money_recorded', '{field.money_approve,expenses.edit}', '0622: mark a field-app money request recorded')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_jpeg  constant text := 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  v_cat uuid; v_req uuid; v_req2 uuid; v_msg text; v_exp_before bigint; v_adv_before bigint; v_mine jsonb;
begin
  select count(*) into v_exp_before from public.expenses;
  select count(*) into v_adv_before from public.advances;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select id into v_cat from public.expense_categories where company_id = v_co order by name limit 1;

    -- the HR login as office staff, field.app only: refused; with field.expenses: allowed
    update public.profiles set user_type = 'office_staff', site_scope = '{}', permissions = array['field.app'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.field_request_money('expense', 500, v_cat, 'Tea', public.field_today(), null, '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Your login needs the "Field: request own expenses and advances (sees only their own)" permission for this. Ask a super admin.' then
      raise exception '0622 REFUSED: a request without field.expenses got "%".', v_msg;
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set permissions = array['field.app', 'field.expenses'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.field_request_money('expense', 500, v_cat, 'Tea', public.field_today() - 40, null, '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'The date must be today or within the last 30 days.' then raise exception '0622 REFUSED: an old date got "%".', v_msg; end if;
    v_req := (public.field_request_money('expense', 1250.50, v_cat, 'Rickshaw to 68 HS', public.field_today(), v_site, array[v_jpeg], '{"lat": 33.6, "lng": 73.0}') ->> 'id')::uuid;
    v_mine := public.field_my_requests();
    if jsonb_array_length(v_mine) <> 1 or (v_mine -> 0 ->> 'amount')::numeric <> 1250.50 then raise exception '0622 REFUSED: my requests shows %.', v_mine; end if;
    if (select count(*) from public.field_photos where ref_table = 'field_money_requests' and ref_id = v_req and kind = 'receipt') <> 1
       or not exists (select 1 from public.field_activity where ref_table = 'field_money_requests' and ref_id = v_req and kind = 'expense' and ack_at is null)
       or not exists (select 1 from public.alerts where ref_table = 'field_money_requests' and ref_id = v_req and state = 'open')
       or not exists (select 1 from public.push_outbox where data ->> 'id' = v_req::text and v_boss = any (user_ids)) then
      raise exception '0622 REFUSED: the request has no receipt, line, alert or push to the approvers.';
    end if;
    v_msg := null; begin perform public.decide_field_money_request(v_req, 'approved', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Deciding app expense requests needs the "Field: approve or return expense and advance requests from the app" permission.' then
      raise exception '0622 REFUSED: the requester deciding got "%".', v_msg;
    end if;

    -- a supervisor is refused
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site], permissions = array['field.app', 'field.expenses'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.field_request_money('advance', 3000, null, 'Advance', public.field_today(), null, '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'This is done by the office, not in the site supervisor''s app.' then raise exception '0622 REFUSED: a supervisor requesting got "%".', v_msg; end if;

    -- the approver: a return needs a note; approving acknowledges and pushes back; recorded only once approved
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.decide_field_money_request(v_req, 'returned', ''); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Say why, so the person who asked knows.' then raise exception '0622 REFUSED: a return without a note got "%".', v_msg; end if;
    v_msg := null; begin perform public.mark_field_money_recorded(v_req, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Only an approved request that is not yet recorded can be marked recorded.' then raise exception '0622 REFUSED: recording a pending request got "%".', v_msg; end if;
    perform public.decide_field_money_request(v_req, 'approved', null);
    if not exists (select 1 from public.field_activity where ref_table = 'field_money_requests' and ref_id = v_req and ack_by = v_boss)
       or not exists (select 1 from public.push_outbox where data ->> 'kind' = 'money_decision' and data ->> 'id' = v_req::text and v_hr = any (user_ids)) then
      raise exception '0622 REFUSED: approving did not acknowledge the line or push back to the requester.';
    end if;
    perform public.mark_field_money_recorded(v_req, 'EXP entered');
    if (select recorded_at from public.field_money_requests where id = v_req) is null then raise exception '0622 REFUSED: not marked recorded.'; end if;

    -- no money table was touched
    if (select count(*) from public.expenses) <> v_exp_before or (select count(*) from public.advances) <> v_adv_before then
      raise exception '0622 REFUSED: a field request wrote to expenses or advances.';
    end if;
    raise exception '0622-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0622-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0622 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0622 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0622 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
