-- 0599 — employee phones are digits only
--
-- Shayan, 29 Oct 2026: "alot of them has - in between like 0333-330xyz remove
-- that dash". The same release saves every employee phone through cleanPhone()
-- (src/app/lib/validation.ts): digits only, a leading "+" kept. This brings the
-- numbers already on record to that form, on GGS.
--
--   1. Two numbers in one box. 22 phones read "0335-8535638 / 0336-1982103".
--      Stripping them would fuse two numbers into one 22-digit string, so they
--      are split first: the first stays in phone, the second moves to
--      secondary_phone — which is empty on all 22 (checked before writing).
--   2. Then every phone column loses its dashes and spaces:
--        phone 156, secondary_phone 1, emergency_contact_phone 116,
--        emergency_contact2_phone 2, next_of_kin_contact 0.
--
-- Digits are never added, dropped or reordered; one 10-digit number
-- (0342-559841) stays 10 digits, as typed. audit_log records each row.
--
-- Asserted: each step changes exactly its counted rows (or none, on a replay),
-- and afterwards no GGS employee phone holds anything but digits and a
-- leading "+".

do $phones$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  n int;
begin
  update public.employees
     set secondary_phone = regexp_replace(split_part(phone, '/', 2), '\D', '', 'g'),
         phone           = regexp_replace(split_part(phone, '/', 1), '\D', '', 'g')
   where company_id = v_co
     and phone ~ '^\s*[0-9+\-\s]+\s*/\s*[0-9+\-\s]+\s*$'
     and nullif(btrim(secondary_phone), '') is null;
  get diagnostics n = row_count;
  if n not in (0, 22) then raise exception '0599 REFUSED: % two-number phones split, not 22.', n; end if;

  update public.employees set phone = (case when btrim(phone) like '+%' then '+' else '' end) || regexp_replace(phone, '\D', '', 'g')
   where company_id = v_co and phone !~ '^\+?\d+$' and regexp_replace(phone, '\D', '', 'g') <> '';
  get diagnostics n = row_count;
  if n not in (0, 156) then raise exception '0599 REFUSED: phone would change % rows, not 156.', n; end if;

  update public.employees set secondary_phone = (case when btrim(secondary_phone) like '+%' then '+' else '' end) || regexp_replace(secondary_phone, '\D', '', 'g')
   where company_id = v_co and secondary_phone !~ '^\+?\d+$' and regexp_replace(secondary_phone, '\D', '', 'g') <> '';
  get diagnostics n = row_count;
  if n not in (0, 1) then raise exception '0599 REFUSED: secondary_phone would change % rows, not 1.', n; end if;

  update public.employees set emergency_contact_phone = (case when btrim(emergency_contact_phone) like '+%' then '+' else '' end) || regexp_replace(emergency_contact_phone, '\D', '', 'g')
   where company_id = v_co and emergency_contact_phone !~ '^\+?\d+$' and regexp_replace(emergency_contact_phone, '\D', '', 'g') <> '';
  get diagnostics n = row_count;
  if n not in (0, 116) then raise exception '0599 REFUSED: emergency_contact_phone would change % rows, not 116.', n; end if;

  update public.employees set emergency_contact2_phone = (case when btrim(emergency_contact2_phone) like '+%' then '+' else '' end) || regexp_replace(emergency_contact2_phone, '\D', '', 'g')
   where company_id = v_co and emergency_contact2_phone !~ '^\+?\d+$' and regexp_replace(emergency_contact2_phone, '\D', '', 'g') <> '';
  get diagnostics n = row_count;
  if n not in (0, 2) then raise exception '0599 REFUSED: emergency_contact2_phone would change % rows, not 2.', n; end if;

  update public.employees set next_of_kin_contact = (case when btrim(next_of_kin_contact) like '+%' then '+' else '' end) || regexp_replace(next_of_kin_contact, '\D', '', 'g')
   where company_id = v_co and next_of_kin_contact !~ '^\+?\d+$' and regexp_replace(next_of_kin_contact, '\D', '', 'g') <> '';
  get diagnostics n = row_count;
  if n <> 0 then raise exception '0599 REFUSED: next_of_kin_contact would change % rows, not 0.', n; end if;

  if exists (select 1 from public.employees where company_id = v_co and (
       phone !~ '^\+?\d+$' or secondary_phone !~ '^\+?\d+$' or emergency_contact_phone !~ '^\+?\d+$'
       or emergency_contact2_phone !~ '^\+?\d+$' or next_of_kin_contact !~ '^\+?\d+$')) then
    raise exception '0599 REFUSED: a GGS employee phone still holds something other than digits.';
  end if;
end $phones$;
