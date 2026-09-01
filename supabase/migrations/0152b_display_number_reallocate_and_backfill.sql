-- 0152b — Guards falling back to the company prefix: reallocate display_number
--         on client change, make assign_display_number idempotent, backfill.
--
-- RECOVERED from supabase_migrations.schema_migrations on 2026-08-31, where it
-- is recorded as `0152_display_number_reallocate_and_backfill`. It was applied
-- directly to the database and never written back to the repo, while the repo's
-- own 0152 slot was taken by `0152_attendance_employment_window`. Committed here
-- as 0152b so both keep their identity. See docs/MIGRATION_DIVERGENCE.md.
--
-- Part C is a ONE-TIME data backfill. It is guarded (it only touches rows where
-- display_number is null, and only preserves a legacy number when it is unique
-- within the client), so re-running is safe — but it has already run against the
-- live database and must not be replayed there.

-- PART A: sync trigger now reallocates the per-client display number on client change
create or replace function public.sync_employee_active_client()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_guard  uuid;
  v_client uuid;
begin
  v_guard := coalesce(NEW.guard_id, OLD.guard_id);

  select d.client_id into v_client
    from public.deployments d
   where d.guard_id = v_guard
   order by (d.end_date is null) desc, d.start_date desc nulls last, d.created_at desc
   limit 1;

  if v_client is null then
    return null;
  end if;

  update public.employees e
     set client_id = v_client,
         display_number = case when v_client is distinct from e.client_id then null else e.display_number end,
         updated_at = now()
   where e.id = v_guard and (e.client_id is distinct from v_client);

  if found then
    perform public.assign_display_number(v_guard);
  end if;

  return null;
end $$;

-- PART B: idempotent assign_display_number
create or replace function public.assign_display_number(p_employee_id uuid)
returns text language plpgsql security definer set search_path to 'public' as $$
declare
  v_company uuid; v_client uuid; v_prefix text; v_existing int; v_n bigint;
begin
  select e.company_id, e.client_id, e.display_number
    into v_company, v_client, v_existing
  from public.employees e where e.id = p_employee_id;

  if v_company is null then
    raise exception 'Employee % not found', p_employee_id;
  end if;

  if v_client is null then
    update public.employees set display_number = null where id = p_employee_id;
    return null;
  end if;

  select employee_id_prefix into v_prefix from public.clients where id = v_client;

  if v_prefix is null then
    update public.employees set display_number = null where id = p_employee_id;
    return null;
  end if;

  if v_existing is not null then
    return v_prefix || '-' || lpad(v_existing::text, 3, '0');
  end if;

  v_n := public.next_counter(v_company, 'disp:' || v_client::text);
  update public.employees set display_number = v_n, updated_at = now()
   where id = p_employee_id;
  return v_prefix || '-' || lpad(v_n::text, 3, '0');
end $$;

-- PART C: one-time backfill
do $$
declare r record; v_n bigint;
begin
  with affected as (
    select e.id, e.client_id, c.employee_id_prefix as pfx,
      case when split_part(coalesce(e.legacy_code,''),'-',1) = c.employee_id_prefix
           then nullif(regexp_replace(coalesce(e.legacy_code,''),'^.*-(\d+)$','\1'),'')::int end as legacy_num
    from public.employees e join public.clients c on c.id = e.client_id
    where e.display_number is null
      and c.employee_id_prefix is not null and c.employee_id_prefix <> ''
  ),
  preserve as (
    select a.id, a.legacy_num from affected a
    where a.legacy_num is not null
      and not exists (select 1 from public.employees u
                      where u.client_id = a.client_id and u.display_number = a.legacy_num)
      and (select count(*) from affected a2
           where a2.client_id = a.client_id and a2.legacy_num = a.legacy_num) = 1
  )
  update public.employees e set display_number = p.legacy_num, updated_at = now()
  from preserve p where e.id = p.id;

  update public.company_counters cc set value = sub.mx
  from (
    select e.company_id, 'disp:'||e.client_id::text as ck, max(e.display_number) as mx
    from public.employees e
    where e.display_number is not null and e.client_id is not null
    group by e.company_id, e.client_id
  ) sub
  where cc.company_id = sub.company_id and cc.counter_name = sub.ck and cc.value < sub.mx;

  for r in
    select e.id, e.company_id, e.client_id
    from public.employees e join public.clients c on c.id = e.client_id
    where e.display_number is null
      and c.employee_id_prefix is not null and c.employee_id_prefix <> ''
  loop
    v_n := public.next_counter(r.company_id, 'disp:'||r.client_id::text);
    update public.employees set display_number = v_n, updated_at = now() where id = r.id;
  end loop;
end $$;
