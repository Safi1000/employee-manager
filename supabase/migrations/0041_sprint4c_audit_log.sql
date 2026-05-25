-- Sprint 4 — Part C: Audit log everywhere.
-- Spec section 6.4: every change to a major table is logged with who/when/
-- what field/before/after. Implemented as a single generic trigger function
-- attached to every audited table; storage is one row per change with a
-- per-field JSONB diff for updates.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'audit_action') then
    create type audit_action as enum ('insert', 'update', 'delete');
  end if;
end$$;

create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete cascade,
  table_name  text not null,
  record_id   uuid,
  action      audit_action not null,
  changed_by  uuid,                 -- auth.uid() at the time of write; null for service-role
  changed_at  timestamptz not null default now(),
  -- For INSERT: { field: { after: <value> } } for every non-null field.
  -- For UPDATE: { field: { before: <oldval>, after: <newval> } } only for changed fields.
  -- For DELETE: { field: { before: <oldval> } } for every field.
  changes     jsonb not null
);

create index if not exists idx_audit_company       on public.audit_log(company_id);
create index if not exists idx_audit_table_record  on public.audit_log(table_name, record_id);
create index if not exists idx_audit_changed_at    on public.audit_log(changed_at desc);
create index if not exists idx_audit_changed_by    on public.audit_log(changed_by);
create index if not exists idx_audit_action        on public.audit_log(action);

alter table public.audit_log enable row level security;

-- SSA sees all audit entries across companies.
drop policy if exists "ssa_all" on public.audit_log;
create policy "ssa_all" on public.audit_log for select
  using (public.is_ssa_unscoped());

-- Company members see their own audit only.
drop policy if exists "company_members_read" on public.audit_log;
create policy "company_members_read" on public.audit_log for select
  using (company_id = public.current_company_id());

-- Writes are trigger-only. No direct INSERT/UPDATE/DELETE policy → all
-- direct writes from any role except trigger-owner are rejected.

-- ---------------------------------------------------------------------------
-- Generic audit-capture trigger function.
-- Skips noise columns (timestamps), only stores changed fields on UPDATE,
-- skips no-op updates entirely.
-- ---------------------------------------------------------------------------
create or replace function public.log_audit_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes  jsonb := '{}'::jsonb;
  v_record   uuid;
  v_company  uuid;
  v_action   audit_action;
  v_user     uuid;
  v_old      jsonb;
  v_new      jsonb;
  v_key      text;
  v_skip     text[] := array['created_at', 'updated_at'];
begin
  begin
    v_user := auth.uid();
  exception when others then
    v_user := null;
  end;

  if tg_op = 'INSERT' then
    v_action := 'insert';
    v_new := to_jsonb(new);
    begin v_record := (v_new->>'id')::uuid; exception when others then v_record := null; end;
    begin v_company := nullif(v_new->>'company_id', '')::uuid; exception when others then v_company := null; end;
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any(v_skip) then continue; end if;
      if (v_new->v_key) is not null and (v_new->v_key)::text <> 'null' then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('after', v_new->v_key));
      end if;
    end loop;

  elsif tg_op = 'UPDATE' then
    v_action := 'update';
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    begin v_record := (v_new->>'id')::uuid; exception when others then v_record := null; end;
    begin v_company := nullif(v_new->>'company_id', '')::uuid; exception when others then v_company := null; end;
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any(v_skip) then continue; end if;
      if (v_old->v_key) is distinct from (v_new->v_key) then
        v_changes := v_changes || jsonb_build_object(
          v_key,
          jsonb_build_object('before', v_old->v_key, 'after', v_new->v_key)
        );
      end if;
    end loop;
    -- Skip pure no-ops (only timestamps changed).
    if v_changes = '{}'::jsonb then
      return new;
    end if;

  else  -- DELETE
    v_action := 'delete';
    v_old := to_jsonb(old);
    begin v_record := (v_old->>'id')::uuid; exception when others then v_record := null; end;
    begin v_company := nullif(v_old->>'company_id', '')::uuid; exception when others then v_company := null; end;
    for v_key in select jsonb_object_keys(v_old) loop
      if v_key = any(v_skip) then continue; end if;
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('before', v_old->v_key));
    end loop;
  end if;

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, tg_table_name, v_record, v_action, v_user, v_changes);

  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- Attach the trigger to every audited table. "zzz_" prefix so it runs
-- AFTER other AFTER triggers (e.g. period_lock fires BEFORE; audit fires AFTER).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  audited_tables text[] := array[
    'employees',
    'clients',
    'contracts',
    'invoices',
    'invoice_payments',
    'expenses',
    'payslips',
    'advances',
    'cheques',
    'bank_accounts',
    'bank_transactions',
    'branches',
    'profiles',
    'chart_of_accounts',
    'accounting_periods',
    'posts',
    'incidents',
    'roster_assignments'
  ];
begin
  foreach t in array audited_tables loop
    execute format('drop trigger if exists trg_zzz_%I_audit on public.%I', t, t);
    execute format(
      'create trigger trg_zzz_%I_audit
         after insert or update or delete on public.%I
         for each row execute function public.log_audit_change()',
      t, t
    );
  end loop;
end$$;
