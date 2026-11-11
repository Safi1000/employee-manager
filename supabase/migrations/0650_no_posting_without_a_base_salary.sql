-- 0650: Nobody is posted, transferred, recategorised or rehired without a base
-- salary on record.
--
-- Found on Nasir Ali (GGS-00646). Added 13 Oct 2026 08:49 with no pay, posted
-- to Regent 1 at 08:50 through Assignments & Pay → Assign, whose salary box
-- said "Leave blank to set later". Nobody did. He worked all 31 days of
-- October and his payslip was generated at Regent 1's finance verify on
-- 10 Nov at base 0, net 0. Nothing anywhere refused it: the Payroll screen's
-- red "No base salary" tag is a warning, not a gate.
--
-- On the day this was written, 42 active client guards and 1 active reliever
-- at Guards and Guides have no base salary. A CHECK constraint would refuse
-- the migration (or, NOT VALID, would refuse every unrelated edit to those
-- rows). So this gates the MOMENTS, not the state:
--
--   * a posting begins       — client_id or contract_line_id is set or changes
--                              (Assign, Transfer, Change category, rehire_guard;
--                              a posting insert reaches here through the
--                              deployments → employees sync)
--   * the category changes   — Transfer / Change category to office staff or
--                              reliever, rehire_to_office_staff
--   * a leaver comes back    — terminated/fired/left/absconded → active
--                              (both rehires, Undo exit)
--   * an employee is INSERTED already on a posting
--
-- and only while the row ends up 'active'. Adding a record (no posting yet),
-- hiring a candidate onto the unposted roster, editing, separating and
-- archiving are not gated: none of them puts anyone to work.
--
-- "A base salary on record" is any of:
--   base_salary > 0 on the row;
--   pay_basis = 'per_day' with daily_rate > 0 (per-day guards have no monthly base);
--   an employee_salary_history row with base_salary > 0 — because
--   set_employee_salary() only writes the row when the effective date is not in
--   the future, so a forward-dated hire's pay lives in history alone.
--
-- The screens now require the salary on Assign and both rehires, and ask for
-- one on Transfer / Change category when the person has none. This is the
-- backstop for every path that does not go through those screens.

create or replace function public.enforce_pay_on_record()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_gate text;
begin
  if new.lifecycle_state::text <> 'active' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.client_id is not null or new.contract_line_id is not null then
      v_gate := 'posted';
    end if;
  else
    if old.lifecycle_state::text in ('terminated', 'fired', 'left', 'absconded') then
      v_gate := 'rehired';
    elsif new.category is distinct from old.category then
      v_gate := 'moved to ' || replace(new.category::text, '_', ' ');
    elsif (new.client_id is not null and new.client_id is distinct from old.client_id)
       or (new.contract_line_id is not null and new.contract_line_id is distinct from old.contract_line_id) then
      v_gate := 'posted';
    end if;
  end if;

  if v_gate is null then
    return new;
  end if;

  if coalesce(new.base_salary, 0) > 0
     or (new.pay_basis::text = 'per_day' and coalesce(new.daily_rate, 0) > 0)
     or exists (select 1 from public.employee_salary_history h
                 where h.employee_id = new.id and coalesce(h.base_salary, 0) > 0) then
    return new;
  end if;

  raise exception '% has no base salary, so cannot be %. Set the base salary first. Nothing has been recorded.',
    coalesce(new.full_name, 'This employee'), v_gate
    using errcode = '23514';
end $function$;

comment on function public.enforce_pay_on_record() is
  '0650: refuses posting / category change / rehire of an active employee with no base salary on record '
  '(row base_salary, per-day daily_rate, or salary history). Gates the moment, not the state: existing '
  'no-salary rows are refused only when someone tries to move them.';

drop trigger if exists trg_zzzz_employees_pay_on_record on public.employees;
create trigger trg_zzzz_employees_pay_on_record
  before insert or update of lifecycle_state, category, client_id, contract_line_id
  on public.employees
  for each row execute function public.enforce_pay_on_record();

-- It must refuse what it is for. Nasir Ali's own shape — an active client
-- guard with no pay on record being posted — must raise THIS message, and a
-- guard with pay on record must pass. Run on a throwaway copy of a real row
-- inside a subtransaction that is always rolled back.
do $$
declare
  v_co uuid; v_cli uuid; v_id uuid := gen_random_uuid(); v_msg text; v_ok boolean := false;
begin
  select e.company_id, e.client_id into v_co, v_cli
    from public.employees e where e.client_id is not null limit 1;
  if v_cli is null then
    raise exception '0650 REFUSED: no posted employee to test against.';
  end if;

  begin
    insert into public.employees (id, company_id, full_name, category, lifecycle_state, base_salary)
    values (v_id, v_co, '0650 test guard', 'client', 'active', null);
    update public.employees set client_id = v_cli where id = v_id;
    raise exception '0650 TEST: not refused';
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg not like '0650 test guard has no base salary, so cannot be posted.%' then
    raise exception '0650 REFUSED: the gate did not refuse a no-salary posting with its own message; got: %', v_msg;
  end if;

  begin
    insert into public.employees (id, company_id, full_name, category, lifecycle_state, base_salary)
    values (v_id, v_co, '0650 test guard', 'client', 'active', 30000);
    update public.employees set client_id = v_cli where id = v_id;
    v_ok := true;
    raise exception '0650 TEST: rollback';
  exception when others then
    if not v_ok then
      raise exception '0650 REFUSED: the gate refused a guard WITH a base salary: %', sqlerrm;
    end if;
  end;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql §2).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0650 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see.',
      v_n, v_who;
  end if;
end $$;
