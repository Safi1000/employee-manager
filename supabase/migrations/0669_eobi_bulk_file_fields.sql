-- 0669 — what the EOBI bulk upload file needs that Bastion did not hold.
--
-- The EOBI challan (Statutory → EOBI) builds the bulk CSV the EOBI website
-- takes (FAA04781FS_BULK.csv, studied 13 Nov 2026). Each row carries the
-- employer's registration (area code + serial, e.g. FAA / 4781) and the
-- guard's EOBI number, CNIC, date of birth and EOBI date of joining. Two of
-- those had no home:
--
--   1. companies.eobi_registration_no — the employer's EOBI registration,
--      e.g. 'FAA04781'. The file splits it: letters = EMP_AREA_CODE, the
--      number = EMP_REG_SERIAL_NO. GGS's is set here (a company registration,
--      not personal data).
--   2. employees.eobi_join_date — the date of joining AS REGISTERED WITH EOBI.
--      It is not the guard's joining date: most of GGS's registrations read
--      1 Aug 2026 whatever the guard's real start. The file falls back to
--      join_date when it is empty. Filled from the screen: the employee
--      form, beside the EOBI number (same commit).
--
-- No money, no RLS change: both are columns on tables whose policies already
-- govern who reads and writes them.

alter table public.companies add column if not exists eobi_registration_no text;
comment on column public.companies.eobi_registration_no is
  '0669: employer EOBI registration, e.g. FAA04781. Split into area code (letters) and serial (number) on the EOBI bulk upload file.';

alter table public.employees add column if not exists eobi_join_date date;
comment on column public.employees.eobi_join_date is
  '0669: date of joining as registered with EOBI (not join_date). Written to DOJ on the EOBI bulk upload file; join_date is used when empty. Edited on the employee form beside the EOBI number.';

update public.companies set eobi_registration_no = 'FAA04781'
 where id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and eobi_registration_no is distinct from 'FAA04781';

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'employees' and column_name = 'eobi_join_date' and data_type = 'date') then
    raise exception '0669 FAILED: employees.eobi_join_date is missing.';
  end if;
  if (select eobi_registration_no from public.companies where id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e') is distinct from 'FAA04781' then
    raise exception '0669 FAILED: GGS''s EOBI registration was not set.';
  end if;
end $$;