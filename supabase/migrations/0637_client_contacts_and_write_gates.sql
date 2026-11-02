-- 0637 — client contacts, and permission gates on four tables anyone could write.
--
-- From the 3 Nov 2026 audit:
--   1. A client record has no people on it: not who in accounts to chase for
--      payment, not the admin contact, not the site in-charge (32 live clients,
--      a phone on 7). client_contacts holds them; the client record and the
--      follow-up screen read them.
--   2. client_complaints, client_service_reviews, recruitment_candidates and
--      employee_training_records had only the company_members policy — any
--      signed-in login in the company could insert, edit or delete them. Each
--      now asks the key a direct write to its subject would ask:
--        complaints  clients.edit, incidents.edit or roster.edit (ops log a
--                    complaint from the daily report)
--        reviews     clients.edit
--        candidates  employees.edit
--        training    employees.edit
--      Reading is unchanged.

create table public.client_contacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  client_id   uuid not null references public.clients(id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  role        text,
  phone       text,
  email       text,
  is_primary  boolean not null default false,
  notes       text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index client_contacts_client_idx on public.client_contacts (client_id);
comment on table public.client_contacts is
  '0637 (3 Nov 2026): the people at a client — accounts, admin, site in-charge — with phone and email. No money. Read by anyone in the company; written with clients.edit or receivables.follow_up (the ops team chasing payment adds the person they spoke to).';
alter table public.client_contacts enable row level security;
create policy company_members on public.client_contacts for all
  using (company_id = (select public.current_company_id())) with check (company_id = (select public.current_company_id()));
create policy ssa_all on public.client_contacts for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
create policy perm_write_ins on public.client_contacts as restrictive for insert
  with check ((select public.has_perm('clients.edit')) or (select public.has_perm('receivables.follow_up')));
create policy perm_write_upd on public.client_contacts as restrictive for update
  using ((select public.has_perm('clients.edit')) or (select public.has_perm('receivables.follow_up')))
  with check ((select public.has_perm('clients.edit')) or (select public.has_perm('receivables.follow_up')));
create policy perm_write_del on public.client_contacts as restrictive for delete
  using ((select public.has_perm('clients.edit')) or (select public.has_perm('receivables.follow_up')));
grant select, insert, update, delete on public.client_contacts to authenticated;

-- Write gates on the four open tables.
do $gates$
declare r record;
begin
  for r in select * from (values
    ('client_complaints',         '(select public.has_perm(''clients.edit'')) or (select public.has_perm(''incidents.edit'')) or (select public.has_perm(''roster.edit''))'),
    ('client_service_reviews',    '(select public.has_perm(''clients.edit''))'),
    ('recruitment_candidates',    '(select public.has_perm(''employees.edit''))'),
    ('employee_training_records', '(select public.has_perm(''employees.edit''))')
  ) t(tbl, expr) loop
    execute format('drop policy if exists perm_write_ins on public.%I', r.tbl);
    execute format('drop policy if exists perm_write_upd on public.%I', r.tbl);
    execute format('drop policy if exists perm_write_del on public.%I', r.tbl);
    execute format('create policy perm_write_ins on public.%I as restrictive for insert with check (%s)', r.tbl, r.expr);
    execute format('create policy perm_write_upd on public.%I as restrictive for update using (%s) with check (%s)', r.tbl, r.expr, r.expr);
    execute format('create policy perm_write_del on public.%I as restrictive for delete using (%s)', r.tbl, r.expr);
  end loop;
end
$gates$;

-- ───────────────────────── Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_client uuid; v_co uuid; v_msg text; v_ran int := 0; v_n int;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_co := public.current_company_id();
    select id into v_client from public.clients where company_id = v_co and name = 'HMC Taxila';
    execute 'set local role authenticated';

    -- 1. A super admin adds a contact and reads it back.
    insert into public.client_contacts (company_id, client_id, name, role, phone) values (v_co, v_client, 'Test accounts officer', 'Accounts', '03000000000');
    select count(*) into v_n from public.client_contacts where client_id = v_client and name = 'Test accounts officer';
    if v_n <> 1 then raise exception '0637 REFUSED: the contact was not saved.'; end if;
    v_ran := v_ran + 1;

    -- 2. A login with only attendance.view cannot add a contact or a complaint.
    execute 'reset role';
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['attendance.view'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    v_msg := null;
    begin insert into public.client_contacts (company_id, client_id, name) values (v_co, v_client, 'Nope'); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like '%row-level security%' then raise exception '0637 REFUSED: an attendance-only login added a contact (%).', coalesce(v_msg, 'no error'); end if;
    v_msg := null;
    begin insert into public.client_complaints (company_id, client_id, raised_on, description, status) values (v_co, v_client, current_date, 'Nope', 'open'); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like '%row-level security%' then raise exception '0637 REFUSED: an attendance-only login logged a complaint (%).', coalesce(v_msg, 'no error'); end if;
    v_ran := v_ran + 1;

    -- 3. The same login can still read contacts.
    select count(*) into v_n from public.client_contacts where client_id = v_client;
    if v_n < 1 then raise exception '0637 REFUSED: reading contacts is gated, it should not be.'; end if;
    v_ran := v_ran + 1;

    execute 'reset role';
    if v_ran <> 3 then raise exception '0637 REFUSED: % of 3 assertions ran.', v_ran; end if;
    raise exception '0637-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0637-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0637 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0637 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
