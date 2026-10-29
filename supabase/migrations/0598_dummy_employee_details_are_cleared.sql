-- 0598 — dummy employee details are cleared
--
-- Shayan, 29 Oct 2026: "check for dummy data that exists like 123456789 as bank
-- number or 000000 as cnic etc and remove them". The Edit form used to refuse a
-- save until every required field was filled, so people typed placeholders to
-- get one through. The same release stops Edit refusing blanks (it refuses
-- only malformed values, as Add always did), so a blank is now the honest
-- answer and the Incomplete badge reports it.
--
-- Cleared to NULL, on GGS, exactly these values and no others (each list was
-- read and agreed before this file was written):
--
--   cnic_number              4  00000-0000000-0, 00000-0000000-1,
--                               12345-6789012-3, 33333-3333333-3
--   bank_account            16  all-zero runs, 12345678910, 2222…, and the four
--                               padded numbers on records titled "ww"/"ss" or
--                               carrying a dummy CNIC
--   phone                    8  00000000000, 03000000000, 03001234567, 033300000003
--   emergency_contact_phone 14  0300…0, 000…0, +92300000000, 0000-0000000,
--                               03121234567, 03111234567, 03001234567
--   bank_branch_code        30  1234, 0000, 2222, 111
--
-- Nothing else on the rows changes. None of the four CNIC rows is identity-
-- verified, so enforce_identity_lock does not apply. audit_log records each
-- row's before/after as for any edit.
--
-- Asserted: each column clears exactly its counted rows (or none, on a replay),
-- and afterwards no listed value remains.

do $clear$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  c_cnic   constant text[] := array['00000-0000000-0','00000-0000000-1','12345-6789012-3','33333-3333333-3'];
  c_acct   constant text[] := array['12345678910','0000000000000','00100123456789654','00000000000','0000000000000000',
                                    '22222222222222','000000000000000','2222222222222222','00000000000000',
                                    '39705900000000','03410320000000'];
  c_phone  constant text[] := array['00000000000','03000000000','03001234567','033300000003'];
  c_ephone constant text[] := array['03000000000','00000000000','+92300000000','03121234567','0000-0000000','03111234567','03001234567'];
  c_branch constant text[] := array['1234','0000','111','2222'];
  n int;
begin
  update public.employees set cnic_number = null where company_id = v_co and cnic_number = any (c_cnic);
  get diagnostics n = row_count;
  if n not in (0, 4) then raise exception '0598 REFUSED: cnic_number would clear % rows, not 4.', n; end if;

  update public.employees set bank_account = null where company_id = v_co and bank_account = any (c_acct);
  get diagnostics n = row_count;
  if n not in (0, 16) then raise exception '0598 REFUSED: bank_account would clear % rows, not 16.', n; end if;

  update public.employees set phone = null where company_id = v_co and phone = any (c_phone);
  get diagnostics n = row_count;
  if n not in (0, 8) then raise exception '0598 REFUSED: phone would clear % rows, not 8.', n; end if;

  update public.employees set emergency_contact_phone = null where company_id = v_co and emergency_contact_phone = any (c_ephone);
  get diagnostics n = row_count;
  if n not in (0, 14) then raise exception '0598 REFUSED: emergency_contact_phone would clear % rows, not 14.', n; end if;

  update public.employees set bank_branch_code = null where company_id = v_co and bank_branch_code = any (c_branch);
  get diagnostics n = row_count;
  if n not in (0, 30) then raise exception '0598 REFUSED: bank_branch_code would clear % rows, not 30.', n; end if;

  if exists (select 1 from public.employees where company_id = v_co and (
       cnic_number = any (c_cnic) or bank_account = any (c_acct) or phone = any (c_phone)
       or emergency_contact_phone = any (c_ephone) or bank_branch_code = any (c_branch))) then
    raise exception '0598 REFUSED: a listed dummy value remains.';
  end if;
end $clear$;
