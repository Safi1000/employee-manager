-- 0624 — the employee file at a site visit: see it, fill what is missing, scan documents
--
-- Shayan, 30 Oct 2026: office staff should "see employee data and fill it while
-- at a site visit, take pictures, scan the ID card directly from a mobile, the
-- police certificate etc". DECIDED the same day:
--   * filled-in details WAIT FOR HR's APPROVAL before the employee record
--     changes (employees.edit applies or refuses them on the web);
--   * a scanned document is filed on the employee as "received from the app, to
--     be checked by HR"; HR accepting it ticks the document checklist.
-- The record itself is never written from the phone.
--
-- What the phone sees (field_employee_card): name, code, designation, site,
-- phones, addresses, father/husband, date of birth, blood group, emergency
-- contact, joining date, licence numbers and expiries, CNIC EXPIRY, police
-- verification status, the document checklist, and what is already waiting.
-- NOT the CNIC number, pay, bank or anything financial — as for supervisors
-- (0607). Who: office logins with field.employees (new); a pinned login sees its
-- region's employees only. Supervisors: no.
--
-- The fields the phone may propose are a fixed list (v_editable); anything else
-- is refused, and applying re-checks the list, so a stored proposal can never
-- write a column it should not.
--
--   field_employee_search(q)                   active employees the caller may see
--   field_employee_card(employee)              the card above
--   field_propose_employee_change(emp, changes, note)
--   field_upload_document(emp, doc_type, photos)
--   decide_field_employee_change(id, apply, note)   employees.edit
--   decide_field_document(id, accept, note)          employees.edit
--
-- Asserted under a sentinel: search and card work for an office login with the
-- key and carry no CNIC number, pay or bank key; a non-listed field is refused;
-- a change waits, then applying writes exactly the proposed fields and logs;
-- a document waits, accepting ticks the checklist; a supervisor and a login
-- without the key are refused by message; deciding needs employees.edit.

insert into public.permission_keys (key, grp, label) values
  ('field.employees', 'Field app', 'Field: see employee files, propose missing details, scan documents (HR approves)')
on conflict (key) do nothing;

-- -------------------------------------------------------------- the panels
create table if not exists public.field_employee_changes (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  employee_id    uuid not null references public.employees (id) on delete cascade,
  changes        jsonb not null,
  old_values     jsonb not null,
  note           text,
  proposed_by    uuid not null references public.profiles (id),
  proposer_name  text not null,
  status         text not null default 'pending' check (status in ('pending', 'applied', 'refused')),
  decided_by     uuid references public.profiles (id),
  decided_by_name text,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);
create index if not exists field_employee_changes_open on public.field_employee_changes (company_id, status);
comment on table public.field_employee_changes is
  '0624: employee details proposed from the field app (field.employees). DECIDED 30 Oct 2026: they wait for HR (employees.edit) to apply or refuse; the phone never writes employees.';
alter table public.field_employee_changes enable row level security;
drop policy if exists field_employee_changes_read on public.field_employee_changes;
create policy field_employee_changes_read on public.field_employee_changes for select using (
  company_id = (select public.current_company_id()) and not (select public.is_site_supervisor()));
revoke all on public.field_employee_changes from anon;
grant select on public.field_employee_changes to authenticated;

create table if not exists public.field_documents (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  employee_id    uuid not null references public.employees (id) on delete cascade,
  doc_type       public.checklist_doc_type not null,
  uploaded_by    uuid not null references public.profiles (id),
  uploader_name  text not null,
  status         text not null default 'received' check (status in ('received', 'accepted', 'rejected')),
  decided_by     uuid references public.profiles (id),
  decided_by_name text,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);
create index if not exists field_documents_emp on public.field_documents (employee_id, status);
comment on table public.field_documents is
  '0624: documents scanned in the field app (photos in field_photos, ref_table field_documents). DECIDED 30 Oct 2026: filed as received, to be checked by HR; accepting (employees.edit) ticks employee_document_checklist.';
alter table public.field_documents enable row level security;
drop policy if exists field_documents_read on public.field_documents;
create policy field_documents_read on public.field_documents for select using (
  company_id = (select public.current_company_id()) and not (select public.is_site_supervisor()));
revoke all on public.field_documents from anon;
grant select on public.field_documents to authenticated;

-- -------------------------------------------------------------- who may see an employee
create or replace function public.field_can_see_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- 0624. An office field login (not a supervisor): any employee of its company, or its region's when pinned.
  -- tenant guard [resolved]: the employee must belong to the caller's company (the join below).
  select exists (
    select 1 from public.profiles p
      join public.employees e on e.id = p_employee_id and e.company_id = p.company_id
     where p.id = auth.uid() and p.disabled_at is null and p.user_type is distinct from 'site_supervisor'
       and public.has_perm('field.app') and (p.branch_id is null or e.branch_id = p.branch_id));
$$;
comment on function public.field_can_see_employee(uuid) is 'TENANT GUARD EXEMPT: internal (0624) — may the caller see this employee in the field app (company, and region when pinned).';
revoke all on function public.field_can_see_employee(uuid) from public, anon, authenticated;

create or replace function public.field_employee_editable()
returns text[]
language sql
immutable
set search_path = public
as $$
  -- 0624. The only employee columns the field app may propose.
  select array['phone', 'secondary_phone', 'home_contact_number', 'current_address', 'permanent_address',
               'father_or_husband_name', 'date_of_birth', 'blood_group',
               'emergency_contact_name', 'emergency_contact_relation', 'emergency_contact_phone',
               'cnic_expiry', 'guard_service_licence_number', 'guard_service_licence_expiry',
               'weapon_licence_number', 'weapon_licence_expiry', 'medical_fitness_expiry'];
$$;
comment on function public.field_employee_editable() is '0624: the fixed list of employee columns the field app may propose (contact, address, licences and expiries — never CNIC number, pay or bank).';
revoke all on function public.field_employee_editable() from public, anon, authenticated;

-- -------------------------------------------------------------- the phone
create or replace function public.field_employee_search(p_q text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0624. Active employees the caller may see, by name or code. 20 at most.
  declare v_q text := lower(btrim(coalesce(p_q, '')));
  begin
    perform public.field_require('field.employees');
    if length(v_q) < 2 then return '[]'::jsonb; end if;
    return (select coalesce(jsonb_agg(x order by x ->> 'full_name'), '[]'::jsonb) from (
      select jsonb_build_object('id', e.id, 'full_name', e.full_name, 'employee_code', e.employee_code, 'designation', e.designation,
                                'site', (select s.name from public.sites s where s.id = public.deployment_site_on(e.id, public.field_today())),
                                'has_photo', coalesce(nullif(btrim(e.photo_url), ''), '') <> '') as x
        from public.employees e
       where e.company_id = public.current_company_id() and e.lifecycle_state::text = 'active'
         and (lower(e.full_name) like '%' || v_q || '%' or lower(e.employee_code) like '%' || v_q || '%')
         and public.field_can_see_employee(e.id)
       order by e.full_name limit 20) t);
  end $$;
comment on function public.field_employee_search(text) is '0624: active employees the caller may see, by name or code (field.employees). No CNIC number, pay or bank.';

create or replace function public.field_employee_card(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0624. One employee's file for the phone — never the CNIC number, pay or bank.
  declare e record;
  begin
    perform public.field_require('field.employees');
    -- tenant guard [resolved]: the employee's company; then field_can_see_employee (region when pinned).
    perform public.assert_same_company((select x.company_id from public.employees x where x.id = p_employee_id));
    if not public.field_can_see_employee(p_employee_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    select * into e from public.employees where id = p_employee_id;
    return jsonb_build_object(
      'id', e.id, 'full_name', e.full_name, 'employee_code', e.employee_code, 'designation', e.designation,
      'site', (select s.name from public.sites s where s.id = public.deployment_site_on(e.id, public.field_today())),
      'join_date', e.join_date, 'police_verification', e.police_verification_status::text,
      'has_photo', coalesce(nullif(btrim(e.photo_url), ''), '') <> '',
      'fields', jsonb_build_object(
        'phone', e.phone, 'secondary_phone', e.secondary_phone, 'home_contact_number', e.home_contact_number,
        'current_address', e.current_address, 'permanent_address', e.permanent_address,
        'father_or_husband_name', e.father_or_husband_name, 'date_of_birth', e.date_of_birth, 'blood_group', e.blood_group,
        'emergency_contact_name', e.emergency_contact_name, 'emergency_contact_relation', e.emergency_contact_relation,
        'emergency_contact_phone', e.emergency_contact_phone, 'cnic_expiry', e.cnic_expiry,
        'guard_service_licence_number', e.guard_service_licence_number, 'guard_service_licence_expiry', e.guard_service_licence_expiry,
        'weapon_licence_number', e.weapon_licence_number, 'weapon_licence_expiry', e.weapon_licence_expiry,
        'medical_fitness_expiry', e.medical_fitness_expiry),
      'documents', (select coalesce(jsonb_agg(jsonb_build_object('doc_type', d.doc_type, 'received', d.received, 'verified', d.verified_at is not null)
                                              order by d.doc_type), '[]'::jsonb)
                      from public.employee_document_checklist d where d.employee_id = e.id),
      'waiting', jsonb_build_object(
        'changes', (select count(*) from public.field_employee_changes c where c.employee_id = e.id and c.status = 'pending'),
        'documents', (select coalesce(jsonb_agg(f.doc_type), '[]'::jsonb) from public.field_documents f where f.employee_id = e.id and f.status = 'received')));
  end $$;
comment on function public.field_employee_card(uuid) is '0624: an employee''s file for the field app (field.employees): contact, licences, expiries, checklist, what is waiting. Never the CNIC number, pay or bank.';

create or replace function public.field_propose_employee_change(p_employee_id uuid, p_changes jsonb, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
  -- 0624. Propose missing or wrong details; HR applies or refuses them.
  declare v_me record; v_old jsonb := '{}'::jsonb; v_clean jsonb := '{}'::jsonb; k text; v_id uuid; v_emp record;
  begin
    perform public.field_require('field.employees');
    -- tenant guard [resolved]: the employee's company; then field_can_see_employee.
    perform public.assert_same_company((select x.company_id from public.employees x where x.id = p_employee_id));
    if not public.field_can_see_employee(p_employee_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'Nothing to change.'; end if;
    select to_jsonb(e) as j, e.full_name, e.employee_code into v_emp from public.employees e where e.id = p_employee_id;
    for k in select jsonb_object_keys(p_changes) loop
      if not (k = any (public.field_employee_editable())) then raise exception 'The app cannot change "%". Ask HR to change it on the web.', k; end if;
      if k in ('date_of_birth', 'cnic_expiry', 'guard_service_licence_expiry', 'weapon_licence_expiry', 'medical_fitness_expiry')
         and nullif(p_changes ->> k, '') is not null then
        begin perform (p_changes ->> k)::date; exception when others then raise exception 'Write dates as YYYY-MM-DD (%).', k; end;
      end if;
      if (v_emp.j -> k) is distinct from (p_changes -> k) and nullif(btrim(p_changes ->> k), '') is not null then
        v_clean := v_clean || jsonb_build_object(k, btrim(p_changes ->> k));
        v_old := v_old || jsonb_build_object(k, v_emp.j -> k);
      end if;
    end loop;
    if v_clean = '{}'::jsonb then raise exception 'Nothing to change.'; end if;
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    insert into public.field_employee_changes (company_id, employee_id, changes, old_values, note, proposed_by, proposer_name)
    values (public.current_company_id(), p_employee_id, v_clean, v_old, nullif(btrim(p_note), ''), v_me.id, v_me.name)
    returning id into v_id;
    perform public.field_log('employee_update', 'field_employee_changes', v_id, null,
      'Details for ' || v_emp.full_name || ' (' || v_emp.employee_code || '): ' || (select string_agg(replace(x, '_', ' '), ', ') from jsonb_object_keys(v_clean) x), null);
    return v_id;
  end $$;
comment on function public.field_propose_employee_change(uuid, jsonb, text) is '0624: the field app proposes employee details from the fixed list; they wait for HR (employees.edit).';

create or replace function public.field_upload_document(p_employee_id uuid, p_doc_type text, p_photos text[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
  -- 0624. Scanned pages of one document, filed as received for HR to check.
  declare v_me record; v_id uuid; v_emp record;
  begin
    perform public.field_require('field.employees');
    -- tenant guard [resolved]: the employee's company; then field_can_see_employee.
    perform public.assert_same_company((select x.company_id from public.employees x where x.id = p_employee_id));
    if not public.field_can_see_employee(p_employee_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    if p_doc_type is null or not (p_doc_type = any (enum_range(null::public.checklist_doc_type)::text[])) then raise exception 'Choose which document it is.'; end if;
    if coalesce(cardinality(p_photos), 0) = 0 then raise exception 'Scan at least one page.'; end if;
    select full_name, employee_code into v_emp from public.employees where id = p_employee_id;
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    insert into public.field_documents (company_id, employee_id, doc_type, uploaded_by, uploader_name)
    values (public.current_company_id(), p_employee_id, p_doc_type::public.checklist_doc_type, v_me.id, v_me.name)
    returning id into v_id;
    perform public.field_store_photos(null, 'document', 'field_documents', v_id, p_photos, null);
    perform public.field_log('document', 'field_documents', v_id, null,
      replace(initcap(replace(p_doc_type, '_', ' ')), 'Id ', 'ID ') || ' scanned for ' || v_emp.full_name || ' (' || v_emp.employee_code || '), '
        || cardinality(p_photos) || ' page' || case when cardinality(p_photos) = 1 then '' else 's' end, null);
    return v_id;
  end $$;
comment on function public.field_upload_document(uuid, text, text[]) is '0624: the field app files a scanned document for an employee, as received, for HR to check.';

-- -------------------------------------------------------------- HR decides
create or replace function public.decide_field_employee_change(p_id uuid, p_apply boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0624. HR applies (writes exactly the proposed, listed fields) or refuses a proposal.
  declare v_c record; k text; v_name text; v_sets text := ''; n int;
  begin
    if not public.has_perm('employees.edit') then
      raise exception 'Applying employee details needs the "Add / edit / delete employees" permission.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the proposal's company.
    perform public.assert_same_company((select company_id from public.field_employee_changes where id = p_id));
    select * into v_c from public.field_employee_changes where id = p_id and status = 'pending' for update;
    if v_c.id is null then raise exception 'Those details are not waiting for a decision.'; end if;
    if not p_apply and nullif(btrim(p_note), '') is null then raise exception 'Say why, so whoever sent it knows.'; end if;
    if p_apply then
      for k in select jsonb_object_keys(v_c.changes) loop
        if not (k = any (public.field_employee_editable())) then raise exception 'The app cannot change "%".', k; end if;
        v_sets := v_sets || format('%I = %L::%s, ', k, v_c.changes ->> k,
                    (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = 'public.employees'::regclass and a.attname = k));
      end loop;
      execute format('update public.employees set %s updated_at = now() where id = %L', v_sets, v_c.employee_id);
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'Row not found' using errcode = '42501'; end if;
    end if;
    select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
    update public.field_employee_changes set status = case when p_apply then 'applied' else 'refused' end, decided_by = auth.uid(),
           decided_by_name = v_name, decided_at = now(), decision_note = nullif(btrim(p_note), '')
     where id = p_id;
    perform public.field_ack_ref('field_employee_changes', p_id, case when p_apply then 'Applied by HR' else 'Refused by HR' end);
  end $$;
comment on function public.decide_field_employee_change(uuid, boolean, text) is '0624: employees.edit applies (exactly the proposed fields on the fixed list) or refuses employee details from the field app; acknowledges its line.';

create or replace function public.decide_field_document(p_id uuid, p_accept boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0624. HR accepts a scanned document (ticks the checklist, verified) or rejects it.
  declare v_d record; v_name text;
  begin
    if not public.has_perm('employees.edit') then
      raise exception 'Checking documents needs the "Add / edit / delete employees" permission.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the document's company.
    perform public.assert_same_company((select company_id from public.field_documents where id = p_id));
    select * into v_d from public.field_documents where id = p_id and status = 'received' for update;
    if v_d.id is null then raise exception 'That document is not waiting to be checked.'; end if;
    if not p_accept and nullif(btrim(p_note), '') is null then raise exception 'Say why, so whoever scanned it knows.'; end if;
    select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
    if p_accept then
      insert into public.employee_document_checklist (company_id, employee_id, doc_type, received, verified_by, verified_at, notes)
      values (v_d.company_id, v_d.employee_id, v_d.doc_type, true, auth.uid(), now(), 'Scanned in the field app by ' || v_d.uploader_name)
      on conflict (employee_id, doc_type) do update
        set received = true, verified_by = auth.uid(), verified_at = now(),
            notes = coalesce(public.employee_document_checklist.notes || ' · ', '') || 'Scanned in the field app by ' || v_d.uploader_name;
    end if;
    update public.field_documents set status = case when p_accept then 'accepted' else 'rejected' end, decided_by = auth.uid(),
           decided_by_name = v_name, decided_at = now(), decision_note = nullif(btrim(p_note), '')
     where id = p_id;
    perform public.field_ack_ref('field_documents', p_id, case when p_accept then 'Accepted by HR' else 'Rejected by HR' end);
  end $$;
comment on function public.decide_field_document(uuid, boolean, text) is '0624: employees.edit accepts (ticks the document checklist as received and verified) or rejects a document scanned in the field app.';

revoke all on function public.field_employee_search(text) from public, anon;
grant execute on function public.field_employee_search(text) to authenticated;
revoke all on function public.field_employee_card(uuid) from public, anon;
grant execute on function public.field_employee_card(uuid) to authenticated;
revoke all on function public.field_propose_employee_change(uuid, jsonb, text) from public, anon;
grant execute on function public.field_propose_employee_change(uuid, jsonb, text) to authenticated;
revoke all on function public.field_upload_document(uuid, text, text[]) from public, anon;
grant execute on function public.field_upload_document(uuid, text, text[]) to authenticated;
revoke all on function public.decide_field_employee_change(uuid, boolean, text) from public, anon;
grant execute on function public.decide_field_employee_change(uuid, boolean, text) to authenticated;
revoke all on function public.decide_field_document(uuid, boolean, text) from public, anon;
grant execute on function public.decide_field_document(uuid, boolean, text) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('field_employee_search', null, 'EXEMPT 0624: field_require(field.employees) inside'),
  ('field_employee_card', null, 'EXEMPT 0624: field_require(field.employees) + field_can_see_employee inside'),
  ('field_propose_employee_change', null, 'EXEMPT 0624: field_require(field.employees) + field_can_see_employee inside'),
  ('field_upload_document', null, 'EXEMPT 0624: field_require(field.employees) + field_can_see_employee inside'),
  ('decide_field_employee_change', '{employees.edit}', '0624: HR applies or refuses employee details from the app'),
  ('decide_field_document', '{employees.edit}', '0624: HR accepts or rejects a document scanned in the app')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_jpeg  constant text := 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  v_guard uuid; v_code text; v_card jsonb; v_chg uuid; v_doc uuid; v_msg text; v_bad text;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select r.employee_id, r.employee_code into v_guard, v_code from public.field_site_roster(v_site) r order by r.full_name limit 1;
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['field.app'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.field_employee_card(v_guard); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Your login needs the "Field: see employee files, propose missing details, scan documents (HR approves)" permission for this. Ask a super admin.' then
      raise exception '0624 REFUSED: no field.employees got "%".', v_msg;
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set permissions = array['field.app', 'field.employees'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);

    if not exists (select 1 from jsonb_array_elements(public.field_employee_search(v_code)) x where (x ->> 'id')::uuid = v_guard) then
      raise exception '0624 REFUSED: searching the code did not find the guard.';
    end if;
    v_card := public.field_employee_card(v_guard);
    select string_agg(k, ', ') into v_bad from (select jsonb_object_keys(v_card) k union all select jsonb_object_keys(v_card -> 'fields')) x
     where k ~ '(cnic_number|salary|pay|bank|iban|account|allowance|rate)';
    if v_bad is not null then raise exception '0624 REFUSED: the card carries %.', v_bad; end if;

    v_msg := null; begin perform public.field_propose_employee_change(v_guard, '{"base_salary": "99999"}'::jsonb, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'The app cannot change "base_salary". Ask HR to change it on the web.' then raise exception '0624 REFUSED: a pay change got "%".', v_msg; end if;
    v_chg := public.field_propose_employee_change(v_guard, jsonb_build_object('emergency_contact_phone', '0300-1112223', 'blood_group', 'B+'), 'Seen on visit');
    if not exists (select 1 from public.field_employee_changes where id = v_chg and status = 'pending')
       or (select emergency_contact_phone from public.employees where id = v_guard) = '0300-1112223'
       or not exists (select 1 from public.field_activity where ref_table = 'field_employee_changes' and ref_id = v_chg) then
      raise exception '0624 REFUSED: the proposal did not wait, wrote the record early, or logged nothing.';
    end if;
    v_doc := public.field_upload_document(v_guard, 'police_verification', array[v_jpeg, v_jpeg]);
    if (select count(*) from public.field_photos where ref_table = 'field_documents' and ref_id = v_doc and kind = 'document') <> 2 then
      raise exception '0624 REFUSED: the document''s pages were not stored.';
    end if;
    v_msg := null; begin perform public.decide_field_employee_change(v_chg, true, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Applying employee details needs the "Add / edit / delete employees" permission.' then raise exception '0624 REFUSED: applying without employees.edit got "%".', v_msg; end if;

    -- a supervisor is refused
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.field_employee_search(v_code); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'This is done by the office, not in the site supervisor''s app.' then raise exception '0624 REFUSED: a supervisor got "%".', v_msg; end if;

    -- HR (a super admin here) applies the change and accepts the document
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.decide_field_employee_change(v_chg, true, null);
    if (select emergency_contact_phone from public.employees where id = v_guard) is distinct from '0300-1112223'
       or (select blood_group from public.employees where id = v_guard) is distinct from 'B+'
       or not exists (select 1 from public.field_activity where ref_table = 'field_employee_changes' and ref_id = v_chg and ack_at is not null) then
      raise exception '0624 REFUSED: applying did not write the fields or acknowledge the line.';
    end if;
    perform public.decide_field_document(v_doc, true, null);
    if not exists (select 1 from public.employee_document_checklist where employee_id = v_guard and doc_type = 'police_verification' and received and verified_at is not null) then
      raise exception '0624 REFUSED: accepting did not tick the checklist.';
    end if;
    v_msg := null; begin perform public.decide_field_document(v_doc, true, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'That document is not waiting to be checked.' then raise exception '0624 REFUSED: deciding twice got "%".', v_msg; end if;
    raise exception '0624-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0624-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0624 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0624 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0624 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
