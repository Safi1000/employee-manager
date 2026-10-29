-- 0601 — profile completion, client by client, with targets
--
-- Shayan, 29 Oct 2026: "task HR to start by completing one client at a time
-- say Emaar or HMC … and then there are people as HO or Reliver and open who
-- are not yet under any client … then i can give them targets to complete".
-- Then "yes on both": targets also go to the Task Board; only a super admin
-- sets them.
--
--   employee_missing_fields(employees)  the Incomplete badge's eleven checks,
--       as labels. A SECOND COPY of missingRequiredFields() in
--       src/app/pages/super-admin/EmployeeManagement.tsx — change one, change
--       both. (A screen-side badge per row and a server-side count per group
--       are both needed; neither can read the other.)
--   profile_completion()  one row per group: each client, then Head Office,
--       Relievers, Not under any client. Staff, complete, incomplete, the field
--       most often missing, and the group's open target. SECURITY INVOKER: it
--       counts only the employees the caller can already read, so a regional
--       login sees its own region's figures and nobody else's.
--   profile_targets  who is completing which group, by when. One open target
--       per group. Progress is never stored — it is profile_completion()'s live
--       count — so a target cannot be marked further along than the records.
--   set_profile_target(...)  super admin only. Creates or moves the group's
--       target and its Task Board task (high priority, due that date, assigned
--       to that login), in one transaction.
--   close_profile_target(id)  super admin only. Closes the target and marks its
--       task done.
--
-- Both write functions are SECURITY INVOKER and single-row: tasks and
-- profile_targets already admit only a super admin's writes, so RLS is the
-- gate and nothing is restated.
--
-- Asserted: the groups add up to every active employee; a target for Emaar DHA
-- ISB creates exactly one task for the assignee and a second call moves it
-- rather than adding one; the HR login is refused with the exact message;
-- closing marks the task done (rolled back by a sentinel whose message is
-- checked).

create or replace function public.employee_missing_fields(e public.employees)
returns text[]
language sql
immutable
set search_path = public
as $$
  -- 0601. Mirrors missingRequiredFields() in EmployeeManagement.tsx.
  select array_remove(array[
    case when nullif(btrim(e.phone), '') is null then 'Phone' end,
    case when nullif(btrim(e.cnic_number), '') is null then 'CNIC' end,
    case when e.date_of_birth is null then 'Date of Birth' end,
    case when nullif(btrim(e.father_or_husband_name), '') is null then 'Father / Husband Name' end,
    case when e.cnic_expiry is null then 'CNIC Expiry' end,
    case when not ((nullif(btrim(e.emergency_contact_name), '') is not null and nullif(btrim(e.emergency_contact_phone), '') is not null)
                or (nullif(btrim(e.emergency_contact2_name), '') is not null and nullif(btrim(e.emergency_contact2_phone), '') is not null))
         then 'Emergency Contact' end,
    case when e.join_date is null then 'Join Date' end,
    case when nullif(btrim(e.bank_name), '') is null then 'Bank Name' end,
    case when nullif(btrim(e.account_title), '') is null then 'Account Title' end,
    case when nullif(btrim(e.bank_account), '') is null then 'Bank Account Number' end,
    case when btrim(coalesce(e.bank_name, '')) not in ('Easypaisa (Wallet)', 'JazzCash (Wallet)', 'NayaPay (Wallet)', 'SadaPay (Wallet)')
          and nullif(btrim(e.bank_branch_code), '') is null then 'Branch Code' end
  ], null);
$$;
comment on function public.employee_missing_fields(public.employees) is
  '0601: the Incomplete badge''s checks as labels. SECOND COPY of missingRequiredFields() in EmployeeManagement.tsx — change both together.';

create table if not exists public.profile_targets (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  bucket      text not null check (bucket in ('client', 'office_staff', 'reliever', 'unassigned')),
  client_id   uuid references public.clients(id) on delete cascade,
  assigned_to uuid not null references public.profiles(id),
  due_date    date not null,
  note        text,
  task_id     uuid references public.tasks(id) on delete set null,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz,
  constraint profile_targets_client_iff_client_bucket check ((bucket = 'client') = (client_id is not null))
);
comment on table public.profile_targets is
  'DECIDED 0601: who completes which group''s employee profiles, by when. Progress is profile_completion()''s live count, never stored. Written by a super admin only.';
create unique index if not exists profile_targets_one_open
  on public.profile_targets (company_id, bucket, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where closed_at is null;
alter table public.profile_targets enable row level security;
revoke all on public.profile_targets from anon, authenticated;
grant select, insert, update on public.profile_targets to authenticated;
drop policy if exists company_read on public.profile_targets;
create policy company_read on public.profile_targets for select using (
  (company_id = (select public.current_company_id())
    and (assigned_to = (select auth.uid()) or (select public.has_perm('employees.view'))))
  or (select public.is_ssa_unscoped()));
drop policy if exists super_admin_write on public.profile_targets;
create policy super_admin_write on public.profile_targets for all using (
  company_id = (select public.current_company_id())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'super_admin'))
  with check (
  company_id = (select public.current_company_id())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'super_admin'));

create or replace function public.profile_completion()
returns table (bucket text, client_id uuid, label text, staff integer, complete integer, incomplete integer,
               top_missing text, target_id uuid, assigned_to uuid, assignee_name text, due_date date, overdue boolean)
language sql
stable
security invoker
set search_path = public
as $$
  -- 0601. Each group's completion, over the employees the caller can read.
  with emp as (
    select case when e.category = 'client' and e.client_id is not null then 'client'
                when e.category = 'office_staff' then 'office_staff'
                when e.category = 'reliever' then 'reliever'
                else 'unassigned' end as bucket,
           case when e.category = 'client' then e.client_id end as client_id,
           public.employee_missing_fields(e) as missing
      from public.employees e
     where e.company_id = public.current_company_id()
       and e.status in ('Active', 'On Leave')
       and (e.lifecycle_state is null or e.lifecycle_state::text not in ('applicant', 'waitlisted'))
  ),
  g as (
    select emp.bucket, emp.client_id, count(*)::int staff,
           count(*) filter (where cardinality(emp.missing) = 0)::int complete,
           count(*) filter (where cardinality(emp.missing) > 0)::int incomplete
      from emp group by emp.bucket, emp.client_id
  ),
  top as (
    select distinct on (emp.bucket, emp.client_id) emp.bucket, emp.client_id, m.f
      from emp cross join lateral unnest(emp.missing) m(f)
     group by emp.bucket, emp.client_id, m.f
     order by emp.bucket, emp.client_id, count(*) desc, m.f
  )
  select g.bucket, g.client_id,
         case g.bucket when 'client' then coalesce(c.name, 'Client') when 'office_staff' then 'Head Office'
                       when 'reliever' then 'Relievers' else 'Not under any client' end,
         g.staff, g.complete, g.incomplete, top.f,
         t.id, t.assigned_to, coalesce(p.full_name, p.email), t.due_date,
         (t.id is not null and g.incomplete > 0 and t.due_date < (now() at time zone 'Asia/Karachi')::date)
    from g
    left join public.clients c on c.id = g.client_id
    left join top on top.bucket = g.bucket and top.client_id is not distinct from g.client_id
    left join public.profile_targets t on t.company_id = public.current_company_id() and t.closed_at is null
         and t.bucket = g.bucket and t.client_id is not distinct from g.client_id
    left join public.profiles p on p.id = t.assigned_to
   order by (g.bucket = 'client') desc, g.incomplete desc, 3;
$$;
comment on function public.profile_completion() is
  '0601: employee profile completion per client / Head Office / Relievers / unassigned, with each group''s open target. INVOKER — counts only rows the caller can read.';
revoke all on function public.profile_completion() from public, anon;
grant execute on function public.profile_completion() to authenticated;

create or replace function public.set_profile_target(p_bucket text, p_client_id uuid, p_assigned_to uuid, p_due_date date, p_note text default null)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
  -- 0601. Create or move one group's target and its Task Board task.
  declare
    v_co uuid := public.current_company_id();
    v_label text;
    v_t public.profile_targets;
    v_task uuid;
    v_desc text;
    n int;
  begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin') then
      raise exception 'only a super admin can set profile targets' using errcode = '42501';
    end if;
    -- tenant guard: p_client_id and p_assigned_to must be this company's
    if p_client_id is not null and not exists (select 1 from public.clients c where c.id = p_client_id and c.company_id = v_co) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    if not exists (select 1 from public.profiles p where p.id = p_assigned_to and p.company_id = v_co and p.disabled_at is null) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    if p_due_date is null then raise exception 'a target needs a date'; end if;

    v_label := case p_bucket when 'client' then (select name from public.clients where id = p_client_id)
                             when 'office_staff' then 'Head Office' when 'reliever' then 'Relievers'
                             when 'unassigned' then 'Not under any client' end;
    if v_label is null then raise exception 'unknown group %', p_bucket; end if;
    v_desc := 'Complete the employee profiles for ' || v_label || '. Open Employees › Profile completion › '
              || v_label || ' to see who is incomplete and which fields they owe.'
              || coalesce(E'\n\n' || nullif(btrim(p_note), ''), '');

    select * into v_t from public.profile_targets t
     where t.company_id = v_co and t.closed_at is null and t.bucket = p_bucket and t.client_id is not distinct from p_client_id;

    if v_t.id is not null and v_t.task_id is not null and exists (select 1 from public.tasks where id = v_t.task_id) then
      update public.tasks set assignee_id = p_assigned_to, due_date = p_due_date, description = v_desc, updated_at = now()
       where id = v_t.task_id;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'the target''s task could not be updated'; end if;
      v_task := v_t.task_id;
    else
      insert into public.tasks (company_id, title, description, status, assignee_id, created_by, due_date, priority)
      values (v_co, 'Complete employee profiles — ' || v_label, v_desc, 'todo', p_assigned_to, auth.uid(), p_due_date, 'high')
      returning id into v_task;
    end if;

    if v_t.id is not null then
      update public.profile_targets set assigned_to = p_assigned_to, due_date = p_due_date, note = nullif(btrim(p_note), ''), task_id = v_task
       where id = v_t.id;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'the target could not be updated'; end if;
      return v_t.id;
    end if;
    insert into public.profile_targets (company_id, bucket, client_id, assigned_to, due_date, note, task_id, created_by)
    values (v_co, p_bucket, p_client_id, p_assigned_to, p_due_date, nullif(btrim(p_note), ''), v_task, auth.uid())
    returning id into v_t.id;
    return v_t.id;
  end $$;
comment on function public.set_profile_target(text, uuid, uuid, date, text) is
  '0601: super admin sets or moves one group''s profile-completion target and its Task Board task. INVOKER, single row; tasks / profile_targets RLS admit only a super admin.';
revoke all on function public.set_profile_target(text, uuid, uuid, date, text) from public, anon;
grant execute on function public.set_profile_target(text, uuid, uuid, date, text) to authenticated;

create or replace function public.close_profile_target(p_target_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
  -- 0601. Close a target; its task is marked done.
  declare v_task uuid; n int;
  begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin') then
      raise exception 'only a super admin can close profile targets' using errcode = '42501';
    end if;
    update public.profile_targets set closed_at = now()
     where id = p_target_id and company_id = public.current_company_id() and closed_at is null
    returning task_id into v_task;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'Row not found' using errcode = '42501'; end if;
    if v_task is not null then
      update public.tasks set status = 'done', completed_at = coalesce(completed_at, now()), updated_at = now() where id = v_task;
    end if;
  end $$;
comment on function public.close_profile_target(uuid) is
  '0601: super admin closes a profile-completion target and marks its task done. INVOKER, single row.';
revoke all on function public.close_profile_target(uuid) from public, anon;
grant execute on function public.close_profile_target(uuid) to authenticated;

insert into public.api_function_gates (function_name, any_of, reason) values
  ('profile_completion', '{employees.view}', 'Employees › Profile completion (0601)'),
  ('set_profile_target', null, 'EXEMPT 0601: super admin only, checked inside and by tasks / profile_targets RLS'),
  ('close_profile_target', null, 'EXEMPT 0601: super admin only, checked inside and by profile_targets RLS')
on conflict (function_name) do nothing;

do $test$
declare
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_emaar uuid := (select id from public.clients where company_id = v_co and name = 'Emaar DHA ISB');
  v_sum int; v_all int; v_t1 uuid; v_t2 uuid; v_msg text; v_n int;
begin
  if v_emaar is null then raise exception '0601 REFUSED: no client named Emaar DHA ISB.'; end if;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select sum(staff) into v_sum from public.profile_completion();
    select count(*) into v_all from public.employees e
     where e.company_id = v_co and e.status in ('Active', 'On Leave')
       and (e.lifecycle_state is null or e.lifecycle_state::text not in ('applicant', 'waitlisted'));
    if v_sum is distinct from v_all then raise exception '0601 REFUSED: the groups hold % staff, the company has %.', v_sum, v_all; end if;

    v_t1 := public.set_profile_target('client', v_emaar, v_hr, current_date + 7, 'test');
    v_t2 := public.set_profile_target('client', v_emaar, v_hr, current_date + 9, null);
    if v_t1 is distinct from v_t2 then raise exception '0601 REFUSED: a second call made a second target.'; end if;
    select count(*) into v_n from public.tasks where title = 'Complete employee profiles — Emaar DHA ISB' and assignee_id = v_hr and status = 'todo';
    if v_n <> 1 then raise exception '0601 REFUSED: % open tasks for the target, not 1.', v_n; end if;
    if (select due_date from public.profile_completion() where client_id = v_emaar) <> current_date + 9 then
      raise exception '0601 REFUSED: the moved date does not show on the panel.';
    end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null;
    begin perform public.set_profile_target('client', v_emaar, v_hr, current_date, null);
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'only a super admin can set profile targets' then raise exception '0601 REFUSED: HR said "%".', v_msg; end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.close_profile_target(v_t1);
    if (select status from public.tasks t join public.profile_targets p on p.task_id = t.id where p.id = v_t1) <> 'done' then
      raise exception '0601 REFUSED: closing did not mark the task done.';
    end if;
    execute 'reset role';
    raise exception '0601-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0601-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0601 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0601 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
