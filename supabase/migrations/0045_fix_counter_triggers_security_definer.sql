
-- Fix: creating a contract or incident as a company admin fails with
--   "new row violates row-level security policy for table company_counters"
--
-- Same class of bug as 0044. The code-assignment triggers on contracts and
-- incidents write to public.company_counters from a BEFORE INSERT trigger, but
-- were not declared SECURITY DEFINER. company_counters only exposes a read
-- policy to company members (company_read_counters) plus an unscoped-SSA policy
-- (ssa_all) — by design, the sequence table is infrastructure that members may
-- read but not write directly. Because the trigger functions run as the caller,
-- a company admin's UPDATE matches no write policy (0 rows), the code falls
-- through to INSERT, and the WITH CHECK is rejected — rolling back the whole
-- contract/incident insert.
--
-- This path has never succeeded for a non-SSA user (there are 0 contracts and
-- 0 incidents). Declaring both functions SECURITY DEFINER lets the sequence
-- bookkeeping bypass RLS, which is the intended design. Bodies are unchanged.

create or replace function public.assign_contract_code()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  next_seq integer;
begin
  if new.contract_code is null or new.contract_code = '' then
    update public.company_counters
       set next_contract_seq = next_contract_seq + 1
     where company_id = new.company_id
     returning next_contract_seq - 1 into next_seq;
    if next_seq is null then
      insert into public.company_counters (company_id, next_contract_seq)
        values (new.company_id, 2)
        on conflict (company_id) do update set next_contract_seq = company_counters.next_contract_seq + 1
        returning next_contract_seq - 1 into next_seq;
    end if;
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
    update public.company_counters set next_incident_seq = next_incident_seq + 1
      where company_id = new.company_id returning next_incident_seq - 1 into next_seq;
    if next_seq is null then
      insert into public.company_counters (company_id, next_incident_seq) values (new.company_id, 2)
        on conflict (company_id) do update set next_incident_seq = company_counters.next_incident_seq + 1
        returning next_incident_seq - 1 into next_seq;
    end if;
    new.incident_code := 'INC-' || lpad(next_seq::text, 4, '0');
  end if;
  return new;
end;
$$;
