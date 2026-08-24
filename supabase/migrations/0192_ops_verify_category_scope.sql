-- 0192: OPS Verify for client-less "synthetic" attendance groups.
--
-- The attendance board groups non-client staff (office_staff, armed, gunman) into
-- synthetic (category) rows whose id is 'cat:<category>' and whose employees have
-- client_id = NULL. OPS Verify must key those on CATEGORY, not a client uuid.
-- Verification is now scoped by client_id XOR category.

alter table public.attendance_month_verifications alter column client_id drop not null;
alter table public.attendance_month_verifications add column if not exists category text;
alter table public.attendance_month_verifications
  drop constraint if exists attendance_month_verification_company_id_client_id_period_m_key;
create unique index if not exists amv_scope_unique on public.attendance_month_verifications
  (company_id, period_month, coalesce(client_id::text, 'cat:' || category));
alter table public.attendance_month_verifications
  add constraint amv_scope_ck check ((client_id is not null) <> (category is not null));

alter table public.attendance_overrides alter column client_id drop not null;
alter table public.attendance_overrides add column if not exists category text;

-- Lock a verified month for the right scope: by client for client staff, by
-- category for client-less staff.
create or replace function public.enforce_attendance_month_lock() returns trigger
language plpgsql as $$
declare v_emp uuid; v_date date; v_client uuid; v_cat text;
begin
  if TG_OP = 'DELETE' then v_emp := OLD.employee_id; v_date := OLD.attendance_date;
  else v_emp := NEW.employee_id; v_date := NEW.attendance_date; end if;
  select client_id, category into v_client, v_cat from public.employees where id = v_emp;
  if v_client is not null then
    if exists (select 1 from public.attendance_month_verifications v
               where v.client_id = v_client and v.period_month = date_trunc('month', v_date)::date) then
      raise exception 'This month is OPS-verified for this client and locked. Un-verify it to edit attendance.';
    end if;
  elsif v_cat is not null then
    if exists (select 1 from public.attendance_month_verifications v
               where v.category = v_cat and v.period_month = date_trunc('month', v_date)::date) then
      raise exception 'This month is OPS-verified for this group and locked. Un-verify it to edit attendance.';
    end if;
  end if;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end $$;
