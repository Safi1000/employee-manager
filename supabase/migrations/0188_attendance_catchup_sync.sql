-- 0188: re-runnable attendance catch-up from the source org into the clone.
--
-- The clone in 0186 is a POINT-IN-TIME snapshot, and the source org is live.
-- It captured attendance up to 2026-08-12; by the time it was verified, 166
-- further August rows had been marked in the source (the rest of the 12th, plus
-- the 13th) and existed nowhere in the clone. Anything marked between now and
-- cutover will have the same problem.
--
-- So this is a FUNCTION, not a one-shot script. Run it as often as needed —
-- right up to the moment you stop using the old org — from the Supabase
-- dashboard SQL editor, which connects as postgres:
--
--     set session_replication_role = replica;
--     select * from public.sync_attendance_0188();
--     set session_replication_role = default;
--
-- The two SET statements are the caller's job, not the function's. Suppressing
-- triggers requires a privilege that neither SECURITY DEFINER nor the PostgREST
-- role can obtain — set_config inside the function runs as the function OWNER
-- and fails with "permission denied to set parameter". Setting it at statement
-- level in a postgres session works. The function raises rather than inserting
-- if the caller forgets, so a run with triggers live cannot half-succeed.
--
-- It is idempotent. org_copy_map_0186 records every row already carried across,
-- so a second run copies nothing and reports zero. It never updates or deletes
-- anything in either org; it only inserts rows that are genuinely absent.
--
-- Two rows are deliberately SKIPPED rather than copied, and both are counted in
-- the return value so they can never pass unnoticed:
--
--   • skipped_no_employee — the mark belongs to someone hired in the source
--     org AFTER the clone ran, so there is no employee in the target to hang it
--     on. Copying the person would mean re-running the whole employee/deployment
--     chain, which is 0186's job, not this function's.
--   • skipped_deleted_employee — the mark belongs to one of the 16 records
--     pruned by 0187. Their map entries still exist, but the employee rows are
--     gone. Recreating them here would silently undo that prune.
--
-- Triggers are suppressed for the same reasons as 0186: enforce_attendance_window
-- would reject marks for anyone since separated, and the audit trigger would
-- log an import as a pile of user edits.
--
-- APPLIED to production 2026-08-13; first run carried 166 rows.

create or replace function public.sync_attendance_0188()
returns table (
  copied                    bigint,
  skipped_no_employee       bigint,
  skipped_deleted_employee  bigint,
  target_total              bigint
)
language plpgsql
set search_path = public
as $fn$
declare
  v_src  uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_new  uuid;
  v_cut  date := date '2026-08-01';
  v_cols text;
begin
  select id into v_new from public.companies where name = 'guards n guides';
  if v_new is null then
    raise exception 'Company "guards n guides" not found.';
  end if;

  -- Refuse rather than insert with triggers live. enforce_attendance_window
  -- would reject marks for anyone since separated and enforce_attendance_backfill
  -- would reject the backdated ones, so a run without this would copy an
  -- arbitrary subset and report success.
  if current_setting('session_replication_role') <> 'replica' then
    raise exception 'Run "set session_replication_role = replica;" first (and reset it after) - see migration 0188.';
  end if;

  -- Report what will NOT be carried, before doing anything.
  select count(*) into skipped_no_employee
    from public.attendance_records a
   where a.company_id = v_src and a.attendance_date >= v_cut
     and not exists (select 1 from public.org_copy_map_0186 m
                      where m.entity='attendance_records' and m.old_id = a.id)
     and not exists (select 1 from public.org_copy_map_0186 m
                      where m.entity='employees' and m.old_id = a.employee_id);

  select count(*) into skipped_deleted_employee
    from public.attendance_records a
    join public.org_copy_map_0186 em
      on em.entity='employees' and em.old_id = a.employee_id
   where a.company_id = v_src and a.attendance_date >= v_cut
     and not exists (select 1 from public.org_copy_map_0186 m
                      where m.entity='attendance_records' and m.old_id = a.id)
     and not exists (select 1 from public.employees e where e.id = em.new_id);

  -- Allocate ids for the rows that CAN travel: not already carried, and whose
  -- employee still exists in the target.
  insert into public.org_copy_map_0186(entity, old_id, new_id)
  select 'attendance_records', a.id, gen_random_uuid()
    from public.attendance_records a
    join public.org_copy_map_0186 em
      on em.entity='employees' and em.old_id = a.employee_id
    join public.employees e on e.id = em.new_id
   where a.company_id = v_src and a.attendance_date >= v_cut
     and not exists (select 1 from public.org_copy_map_0186 m
                      where m.entity='attendance_records' and m.old_id = a.id);

  -- Column list from the catalogue, skipping GENERATED ALWAYS columns.
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema='public' and table_name='attendance_records' and is_generated='NEVER';

  execute format(
    'insert into public.attendance_records (%1$s) select %1$s from (
       select (jsonb_populate_record(null::public.attendance_records,
                to_jsonb(a) || jsonb_build_object(
                  ''id'', m.new_id, ''company_id'', %2$L::uuid,
                  ''employee_id'', em.new_id,
                  ''worked_for_client_id'', cm.new_id,
                  ''branch_id'', bm.new_id,
                  ''swap_partner_id'', sp.new_id,
                  ''covering_for_guard_id'', cg.new_id))).*
         from public.attendance_records a
         join public.org_copy_map_0186 m  on m.entity=''attendance_records'' and m.old_id=a.id
         join public.org_copy_map_0186 em on em.entity=''employees'' and em.old_id=a.employee_id
         join public.employees te on te.id = em.new_id
         left join public.org_copy_map_0186 cm on cm.entity=''clients'' and cm.old_id=a.worked_for_client_id
         left join public.org_copy_map_0186 bm on bm.entity=''branches'' and bm.old_id=a.branch_id
         left join public.org_copy_map_0186 sp on sp.entity=''employees'' and sp.old_id=a.swap_partner_id
         left join public.org_copy_map_0186 cg on cg.entity=''employees'' and cg.old_id=a.covering_for_guard_id
        where a.company_id = %3$L and a.attendance_date >= %4$L::date
          and not exists (select 1 from public.attendance_records x where x.id = m.new_id)
     ) q',
    v_cols, v_new, v_src, v_cut);

  get diagnostics copied = row_count;

  select count(*) into target_total
    from public.attendance_records where company_id = v_new;

  return next;
end $fn$;

revoke all on function public.sync_attendance_0188() from public, anon, authenticated;
