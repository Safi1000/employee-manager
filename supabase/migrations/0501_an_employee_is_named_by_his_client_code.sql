-- 0501 — an employee is named by the code of the client he works for.
--
-- DECIDED (2026-10-07, Shayan): everywhere the app names an employee it uses
-- the client display code (HMC-024), not the permanent guard code (GGS-00012).
-- Bank and cash history were the visible case: describe_advance() wrote the
-- permanent employee_code into every advance's bank_transactions row.
--
-- 1. employee_display_code(id) — the same rule as the frontend's
--    guardDisplayCode(): {current client's employee_id_prefix}-{lpad(display_number, 3)},
--    falling back to guard_code, then employee_code, when there is no prefix
--    or no display number (office staff, unposted guards).
-- 2. describe_advance() names the employee by it. One author (0382), so it is
--    restated behind a check that the live body is still 0382's.
--
-- Rows already written keep their text; the web screens relabel the
-- permanent code on read, so old history shows the client code too.

create or replace function public.employee_display_code(p_employee_id uuid)
returns text
language sql
stable
set search_path to 'public'
as $function$
  select case
           when e.display_number is not null and nullif(c.employee_id_prefix, '') is not null
             then c.employee_id_prefix || '-' || lpad(e.display_number::text, 3, '0')
           else coalesce(e.guard_code, e.employee_code)
         end
    from public.employees e
    left join public.clients c on c.id = e.client_id
   where e.id = p_employee_id;
$function$;

comment on function public.employee_display_code(uuid) is
  '0501: the code an employee is known by — client prefix + display number, else the permanent guard_code/employee_code. Mirrors guardDisplayCode() in src/app/lib/guardCode.ts. DECIDED 2026-10-07.';

grant execute on function public.employee_display_code(uuid) to authenticated;

do $$
declare v_def text;
begin
  select pg_get_functiondef('public.describe_advance(uuid, uuid)'::regprocedure) into v_def;
  if position('e.employee_code || '' '' || e.full_name' in v_def) = 0
     and position('employee_display_code' in v_def) = 0 then
    raise exception '0501: describe_advance is not the 0382 body this migration replaces. Nothing changed.';
  end if;
end $$;

create or replace function public.describe_advance(p_employee_id uuid, p_client_id uuid)
returns text
language sql
stable
set search_path to 'public'
as $function$
  -- 0501: named by the client display code, not the permanent employee_code.
  select 'Advance · '
      || coalesce((select public.employee_display_code(e.id) || ' ' || e.full_name
                     from public.employees e where e.id = p_employee_id), 'employee')
      || coalesce(' (' || (select c.name from public.clients c where c.id = p_client_id) || ')', '');
$function$;

grant execute on function public.describe_advance(uuid, uuid) to authenticated;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0501 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
