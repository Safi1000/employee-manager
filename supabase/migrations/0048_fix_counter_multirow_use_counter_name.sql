-- Item 10: "query returned more than one row" when logging an incident (and the
-- identical latent bug when creating a contract).
--
-- Root cause: public.company_counters has PRIMARY KEY (company_id, counter_name)
-- — one row per named counter (e.g. 'client', 'employee'). But assign_contract_code
-- and assign_incident_code were written to UPDATE ... RETURNING ... INTO scoped only
-- by `company_id`, which matches EVERY counter row for that company. For a
-- data-modifying statement, RETURNING ... INTO raises "query returned more than one
-- row" when more than one row is affected — so any company with 2+ counter rows
-- (client + employee) blew up on incident/contract creation.
--
-- Fix: use the same (company_id, counter_name) upsert pattern as the other counters,
-- with dedicated counter_name values 'contract' and 'incident', writing the shared
-- `value` column. Atomic, single-row, and immune to how many other counters exist.
-- (Tables currently have 0 contracts and 0 incidents, so starting these counters at
-- 1 introduces no code collisions.)
--
-- Functions remain SECURITY DEFINER (from migration 0045) so the counter write
-- bypasses RLS.

create or replace function public.assign_contract_code()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  next_seq integer;
begin
  if new.contract_code is null or new.contract_code = '' then
    insert into public.company_counters (company_id, counter_name, value)
      values (new.company_id, 'contract', 1)
      on conflict (company_id, counter_name)
        do update set value = company_counters.value + 1
      returning value into next_seq;
    new.contract_code := 'CON-' || lpad(next_seq::text, 4, '0');
  end if;
  return new;
end;
$$;

create or replace function public.assign_incident_code()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  next_seq integer;
begin
  if new.incident_code is null or new.incident_code = '' then
    insert into public.company_counters (company_id, counter_name, value)
      values (new.company_id, 'incident', 1)
      on conflict (company_id, counter_name)
        do update set value = company_counters.value + 1
      returning value into next_seq;
    new.incident_code := 'INC-' || lpad(next_seq::text, 4, '0');
  end if;
  return new;
end;
$$;
