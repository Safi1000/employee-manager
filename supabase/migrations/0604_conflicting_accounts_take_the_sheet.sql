-- 0604 — the ten conflicting accounts take the September sheet's number
--
-- Shayan, 29 Oct 2026, on 0603's conflict list: "replace conflicts with sheet
-- acc numbers except muhammad bilal". 0603 left these eleven untouched because
-- Bastion held a different account from the salary sheet; the sheet is what
-- was paid in September, so it wins. Muhammad Bilal (Bank of AJK) stays as he
-- is — the sheets themselves disagreed about him.
--
-- Each row is changed only if it still holds exactly the account it held when
-- the conflict list was read (the "was" column); anything else means someone
-- edited it since, and that row is refused rather than overwritten blind. A
-- replay finds the new value already there and skips it.
--
-- Where the bank changes, the old IBAN goes with it (set to the sheet's IBAN,
-- or cleared when the sheet gave none) so no record pairs one bank's number
-- with another's IBAN. Account title is filled with the employee's name only
-- if it was blank. Askari numbers are stored as 13 digits (as 0603 did);
-- Allied as 13 digits and HBL as 14, matching how Bastion stores those banks.
--
-- Asserted: all ten hold the sheet's bank, account, IBAN and branch afterwards,
-- and a title. Muhammad Bilal is not in the list, so nothing here touches him.

do $fix$
declare
  r record; n int; v_done int := 0;
begin
  for r in
    select * from (values
      ('2747e98c-f2ee-4966-993d-b7094790d365'::uuid, 'Mansoor Ali',        '6780000021',                'Askari Bank',        '3976780000021',   null::text,                  '397'),
      ('12af9595-c487-4698-9d36-384bdabeff61'::uuid, 'Muhammad Ilyas Khan', '4009955831003731',          'Askari Bank',        '3410320019379',   null,                        '341'),
      ('85e72fca-d488-40c3-ba76-7b5124fcc373'::uuid, 'Safeer Ahmed',       '3053189742',                'Askari Bank',        '3410900000116',   null,                        '341'),
      ('20b3db59-76c7-49b3-a24e-74fdb94fb845'::uuid, 'Taha Bin Arshad',    'FAYS 3420301000004480',     'Askari Bank',        '3410200005706',   'PK26ASCM0003410200005706',  '341'),
      ('ccf1ba8f-299e-445c-b38c-e767c36dd5c4'::uuid, 'Zafar Iqbal',        'PK94ASCM00024305900000403', 'Askari Bank',        '2430590000403',   'PK94ASCM0002430590000403',  '243'),
      ('64326ab4-dc68-420d-8d7a-8b3a58fd086c'::uuid, 'Abdul Zahir',        '24711540000047',            'Askari Bank',        '2471540000047',   null,                        '247'),
      ('9359905e-aaf6-4b62-97c5-70bb8648bd19'::uuid, 'Allah Ditta Abbasi', '76002000015081',            'Askari Bank',        '7600200015081',   null,                        '760'),
      ('6fae1979-6f3f-4231-a925-95f14cc664d8'::uuid, 'Ikhlaq Iqbal',       '1016097550016',             'Allied Bank',        '0116097550016',   'PK81ABPA0010116097550016',  '106'),
      ('2551df85-9c5d-4556-8ff5-13adbc2188a3'::uuid, 'Tufail Hussain',     '1536003050701059',          'Habib Bank (HBL)',   '02467900739203',  'PK29HABB0002467900739203',  '107'),
      ('f5055162-6540-4c23-92e7-19c6f099f420'::uuid, 'Riaz Ahmed',         '61651616516516',            'JazzCash (Wallet)',  '03021550454',     null,                        null)
    ) v(id, who, was, bank, acct, iban, branch)
  loop
    update public.employees e
       set bank_name = r.bank, bank_account = r.acct, iban = r.iban, bank_branch_code = r.branch,
           account_title = coalesce(nullif(btrim(e.account_title), ''), e.full_name)
     where e.id = r.id and e.bank_account = r.was;
    get diagnostics n = row_count;
    if n = 1 then v_done := v_done + 1;
    elsif not exists (select 1 from public.employees where id = r.id and bank_account = r.acct) then
      raise exception '0604 REFUSED: % no longer holds % — edited since the conflict list; not overwritten.', r.who, r.was;
    end if;
  end loop;

  if (select count(*) from public.employees e
       join (values
         ('2747e98c-f2ee-4966-993d-b7094790d365'::uuid, 'Askari Bank', '3976780000021', null::text, '397'),
         ('12af9595-c487-4698-9d36-384bdabeff61'::uuid, 'Askari Bank', '3410320019379', null, '341'),
         ('85e72fca-d488-40c3-ba76-7b5124fcc373'::uuid, 'Askari Bank', '3410900000116', null, '341'),
         ('20b3db59-76c7-49b3-a24e-74fdb94fb845'::uuid, 'Askari Bank', '3410200005706', 'PK26ASCM0003410200005706', '341'),
         ('ccf1ba8f-299e-445c-b38c-e767c36dd5c4'::uuid, 'Askari Bank', '2430590000403', 'PK94ASCM0002430590000403', '243'),
         ('64326ab4-dc68-420d-8d7a-8b3a58fd086c'::uuid, 'Askari Bank', '2471540000047', null, '247'),
         ('9359905e-aaf6-4b62-97c5-70bb8648bd19'::uuid, 'Askari Bank', '7600200015081', null, '760'),
         ('6fae1979-6f3f-4231-a925-95f14cc664d8'::uuid, 'Allied Bank', '0116097550016', 'PK81ABPA0010116097550016', '106'),
         ('2551df85-9c5d-4556-8ff5-13adbc2188a3'::uuid, 'Habib Bank (HBL)', '02467900739203', 'PK29HABB0002467900739203', '107'),
         ('f5055162-6540-4c23-92e7-19c6f099f420'::uuid, 'JazzCash (Wallet)', '03021550454', null, null)
       ) v(id, bank, acct, iban, branch) on v.id = e.id
      where e.bank_name = v.bank and e.bank_account = v.acct and e.iban is not distinct from v.iban
        and e.bank_branch_code is not distinct from v.branch and nullif(btrim(e.account_title), '') is not null) <> 10 then
    raise exception '0604 REFUSED: not all ten hold the sheet''s details afterwards.';
  end if;
end $fix$;
