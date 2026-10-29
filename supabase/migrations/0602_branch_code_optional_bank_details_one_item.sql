-- 0602 — Branch Code is optional; bank details count as one item
--
-- Shayan, 29 Oct 2026: "branch code shouldnt be a necessary field remove
-- that", then "dont just limit it to account title or account number rather
-- mark it as missing bank details". The same release changes
-- missingRequiredFields() in EmployeeManagement.tsx; this is the database's
-- copy (0601's employee_missing_fields), kept in step:
--
--   * Branch Code is no longer checked at all.
--   * Bank Name, Account Title and Bank Account Number become one label,
--     "Bank Details", missing when any of the three is blank.
--
-- Restated, not operated on: 0601 is the function's only author, and the
-- restatement first asserts the live body is the one 0601 wrote (md5 below).
-- Any other body means an edit nobody recorded, and is refused. A replay finds
-- 0602's own body and passes.
--
-- Asserted: no employee is reported missing "Branch Code" or any of the three
-- old bank labels; "Bank Details" is reported for exactly the employees with
-- a blank bank name, title or account number.

do $pre$
declare v text := (select prosrc from pg_proc where oid = 'public.employee_missing_fields(public.employees)'::regprocedure);
begin
  if md5(v) <> '0871f5e94a72d4f06f9aade22a39af9b' and position('-- 0602.' in v) = 0 then
    raise exception '0602 REFUSED: employee_missing_fields is not the body 0601 wrote (md5 %).', md5(v);
  end if;
end $pre$;

create or replace function public.employee_missing_fields(e public.employees)
returns text[]
language sql
immutable
set search_path = public
as $$
  -- 0602. Mirrors missingRequiredFields() in EmployeeManagement.tsx.
  select array_remove(array[
    case when nullif(btrim(e.phone), '') is null then 'Phone' end,
    case when nullif(btrim(e.cnic_number), '') is null then 'CNIC' end,
    case when e.date_of_birth is null then 'Date of Birth' end,
    case when nullif(btrim(e.father_or_husband_name), '') is null then 'Father / Husband Name' end,
    case when e.cnic_expiry is null then 'CNIC Expiry' end,
    case when not ((nullif(btrim(e.emergency_contact_name), '') is not null and nullif(btrim(e.emergency_contact_phone), '') is not null)
                or (nullif(btrim(e.emergency_contact2_name), '') is not null and nullif(btrim(e.emergency_contact2_phone), '') is not null))
         then 'Emergency Contact' end,
    case when e.join_date is null then 'Join Date' end,
    case when nullif(btrim(e.bank_name), '') is null or nullif(btrim(e.account_title), '') is null
           or nullif(btrim(e.bank_account), '') is null then 'Bank Details' end
  ], null);
$$;
comment on function public.employee_missing_fields(public.employees) is
  '0601, restated 0602 (Branch Code optional; bank block = one "Bank Details" item): the Incomplete badge''s checks as labels. SECOND COPY of missingRequiredFields() in EmployeeManagement.tsx — change both together.';

do $test$
declare v_bad int; v_bank int; v_blank int;
begin
  select count(*) into v_bad from public.employees e
   where public.employee_missing_fields(e) && array['Branch Code', 'Bank Name', 'Account Title', 'Bank Account Number'];
  if v_bad <> 0 then raise exception '0602 REFUSED: % employees still report an old label.', v_bad; end if;
  select count(*) filter (where 'Bank Details' = any (public.employee_missing_fields(e))),
         count(*) filter (where nullif(btrim(e.bank_name), '') is null or nullif(btrim(e.account_title), '') is null
                             or nullif(btrim(e.bank_account), '') is null)
    into v_bank, v_blank from public.employees e;
  if v_bank <> v_blank then raise exception '0602 REFUSED: "Bank Details" on % employees, % have a blank bank field.', v_bank, v_blank; end if;
end $test$;
