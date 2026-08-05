-- 0167: a company with any child rows could never be deleted.
--
-- Deleting a company cascades to its children (audit_log.company_id is
-- ON DELETE CASCADE, as are branches, employees and the rest). Postgres removes
-- the parent row first and then runs the cascade, so by the time a child's
-- DELETE fires log_audit_change(), the company is already gone. The trigger
-- then tries to write an audit row pointing at it and trips
-- audit_log_company_id_fkey:
--
--   insert or update on table "audit_log" violates foreign key constraint
--   "audit_log_company_id_fkey"
--
-- So EVERY company delete failed, whatever the caller. That surfaced through
-- signup-complete, whose rollback path deletes the half-built company when
-- creating the super admin fails — without this fix a failed signup would
-- strand an orphan company that nobody could remove.
--
-- Fix: skip the audit row when its company no longer exists. Nothing is lost —
-- an audit trail scoped to a company that is being erased has nowhere to live
-- and is cascaded away in the same statement anyway.
create or replace function public.log_audit_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  begin v_user := auth.uid(); exception when others then v_user := null; end;
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
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('before', v_old->v_key, 'after', v_new->v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then return new; end if;
  else
    v_action := 'delete';
    v_old := to_jsonb(old);
    begin v_record := (v_old->>'id')::uuid; exception when others then v_record := null; end;
    begin v_company := nullif(v_old->>'company_id', '')::uuid; exception when others then v_company := null; end;
    for v_key in select jsonb_object_keys(v_old) loop
      if v_key = any(v_skip) then continue; end if;
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('before', v_old->v_key));
    end loop;
  end if;

  -- THE FIX. A cascade from a deleted company leaves v_company pointing at a
  -- row that is already gone; writing the audit entry would fail the foreign
  -- key and abort the whole delete.
  if v_company is not null
     and not exists (select 1 from public.companies c where c.id = v_company) then
    return coalesce(new, old);
  end if;

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, tg_table_name, v_record, v_action, v_user, v_changes);
  return coalesce(new, old);
end;
$function$;
