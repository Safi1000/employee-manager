-- 0532 — one line per post, now that contracts carry no shift
--
-- Shift came off the contract screen, but the lines under it stayed split by
-- shift: a post of 66 guards was two rows, 33 "day" and 33 "night", and the
-- screen now draws them as two identical "Guard" rows. On Emaar DHA ISB the
-- night row's rate was 0, which is the 203% billed-vs-contract gap (the
-- billing was right; the contract value counted half the post).
--
-- DECIDED 2026-10-21 (Shayan): each such pair is one post, its headcount is
-- the SUM of the two rows, and it merges into one line. Two pairs whose rates
-- differ stay two lines on purpose and are NOT touched here:
--   Nova Group, site 24024ef5 — 7 @ 51,643 and 10 @ 42,000
--   CBR Town, weapons         — 1 @ 52,800 and 1 @ 29,040
-- The expired 68 HS-PCI-PFM contract (9d947603) is left as it was.
--
-- For each pair below: the kept line takes the sum, every row pointing at the
-- absorbed line (employees, deployments, attendance_confirmations, vacancies,
-- contract_addendums) moves to the kept line, and the absorbed line is
-- deleted. The kept line is the one carrying billing_rate where one does,
-- else the one carrying the rate (Emaar: the day line at 62,263 — so the 0
-- goes with the absorbed row and no rate changes anywhere).
--
-- The kept line's shift_code is cleared. client_shift_roster schedules a
-- guard by coalesce(line.shift_code, employee.shift): left as 'day', every
-- night guard moved onto it would be rostered by day. Cleared, each guard's
-- own shift decides, which is what "contracts carry no shift" means.
--
-- No lock is bypassed. Rates are not written, so the rate lock does not
-- fire; each post's committed total is the same before and after, so the
-- deferred group-sum invariant passes on merit at commit.
--
-- Also, Sweet Palace (stated 2026-10-21): the post drops from 2 to 1 from
-- 2026-10-20 — the additional guard's last working day was 2026-10-19. That
-- is a real reduction, so it goes in as the dated addendum the contract
-- expects, against the merged line.
--
-- Idempotent: a pair whose absorbed line is already gone is skipped, and the
-- addendum is inserted only if it is not already there.

create temp table m0532_before on commit drop as
select contract_id, category, site_id, sum(committed_count)::int total
  from public.contract_lines group by contract_id, category, site_id;

do $mig$
declare
  r record; v_keep public.contract_lines; v_abs public.contract_lines; v_status text; v_done int := 0;
begin
  for r in
    select * from (values
      ('0925d33d-c38e-4c90-81e0-aba8556ae8df'::uuid, '089ad682-73c8-47cd-88e7-af5494efff9a'::uuid, '68 HS-PCI-PFM'),
      ('d475f905-99d1-4564-b78e-7155c93cc1e7'::uuid, '57d908c4-ff6a-4229-b5fe-10a38c33c239'::uuid, 'AWT'),
      ('eb66afe0-4ad7-47b8-9ee4-d1d236873dfa'::uuid, 'ee1cc964-b551-447f-8876-68d3c9b495fb'::uuid, 'Bin Zahid (weapons)'),
      ('b41a42cc-a49c-43b9-916d-0f1f46efd075'::uuid, 'a6d8cc48-acd0-4c88-9c7e-ce589dcd2f5b'::uuid, 'Dolmen City'),
      ('3bb3ba27-ab4d-4d5f-948a-bb5241947158'::uuid, '43082c0f-22e1-4540-9613-733b97ba0d30'::uuid, 'Emaar DHA ISB'),
      ('3d1be963-2e34-4670-b9b8-9026a3f1b271'::uuid, 'ff5691b6-7166-4c2f-97f9-2d0e4f89ae60'::uuid, 'MIU a1daa96e'),
      ('f37e64ea-30ad-4fe6-88a9-9848be270dd4'::uuid, '5114637d-b4b6-42a1-a40f-997026892ff9'::uuid, 'MIU b0262b64'),
      ('450e63c0-35d0-47ee-840c-2ee39dd92fc0'::uuid, '115647d4-2c2f-48ea-9b7b-3909f2ff50cb'::uuid, 'Mr Raza Firdous Market'),
      ('2a643d13-985c-47b1-91a8-a943a5ebd088'::uuid, '6036cc1b-531e-4376-88d5-a51e0082b56d'::uuid, 'Nova Group 56b29324'),
      ('e2def38b-60f7-4d91-84fc-b5c56bc0556f'::uuid, 'bd255df5-6bd9-4707-b646-3857759a5bb0'::uuid, 'Nova Group 997a4117'),
      ('a72b7e92-3eee-45b0-9749-046c6f983956'::uuid, '1b0f6594-a4ac-473a-a45a-58cf5299a9dc'::uuid, 'Nova Group d3e63678'),
      ('940cdc1b-7b36-44fc-99b3-2d76beab71b8'::uuid, '8a2aef62-7031-4083-ba32-6f3d87cc6c2a'::uuid, 'PRG Scheme 3'),
      ('3e870faf-ce62-42a2-b2d1-5ab5a4c34c57'::uuid, '8be5fe4a-3e91-4e99-a79c-191ade763e16'::uuid, 'Rising Sun Lodges'),
      ('e6dd176c-f2bb-4018-8815-5a9b4e04eded'::uuid, '49b0ef20-51d3-4af6-b107-1326e8b5b0a1'::uuid, 'Sweet Palace'),
      ('8249c9f0-85d1-4a4f-85f6-78a07f9824f4'::uuid, '2ce06a0c-890f-4f46-a21c-b5fc7b7d3a41'::uuid, 'Wusat- Emaar')
    ) as t(keep_id, abs_id, who)
  loop
    select * into v_keep from public.contract_lines where id = r.keep_id;
    if v_keep.id is null then raise exception '0532 REFUSED: % — kept line % does not exist.', r.who, r.keep_id; end if;
    select * into v_abs from public.contract_lines where id = r.abs_id;
    if v_abs.id is null then continue; end if;   -- already merged

    -- The pair must be one post: same contract, role and site.
    if v_abs.contract_id <> v_keep.contract_id or v_abs.category <> v_keep.category
       or v_abs.site_id is distinct from v_keep.site_id then
      raise exception '0532 REFUSED: % — the two lines are not the same post.', r.who;
    end if;
    select status into v_status from public.contracts where id = v_keep.contract_id;
    if v_status is distinct from 'active' then
      raise exception '0532 REFUSED: % — contract is %, expected active.', r.who, v_status;
    end if;
    -- Same price, or (Emaar only) an absorbed rate of 0, the entry error.
    if not (v_abs.unit_rate = v_keep.unit_rate or (r.who = 'Emaar DHA ISB' and v_abs.unit_rate = 0)) then
      raise exception '0532 REFUSED: % — rates differ (% vs %).', r.who, v_keep.unit_rate, v_abs.unit_rate;
    end if;
    if v_abs.billing_rate is not null and v_abs.billing_rate is distinct from v_keep.billing_rate then
      raise exception '0532 REFUSED: % — the absorbed line carries its own billing rate.', r.who;
    end if;

    update public.contract_lines
       set committed_count = v_keep.committed_count + v_abs.committed_count, shift_code = null
     where id = v_keep.id;

    update public.employees                set contract_line_id = v_keep.id where contract_line_id = v_abs.id;
    update public.deployments              set contract_line_id = v_keep.id where contract_line_id = v_abs.id;
    update public.attendance_confirmations set contract_line_id = v_keep.id where contract_line_id = v_abs.id;
    update public.vacancies                set contract_line_id = v_keep.id where contract_line_id = v_abs.id;
    update public.contract_addendums       set contract_line_id = v_keep.id where contract_line_id = v_abs.id;

    delete from public.contract_lines where id = v_abs.id;
    v_done := v_done + 1;
  end loop;
  raise notice '0532: % pair(s) merged.', v_done;
end $mig$;

-- Sweet Palace: 2 → 1 from 2026-10-20.
insert into public.contract_addendums
  (company_id, contract_id, contract_line_id, category, change_type, count_delta, effective_from, source, notes)
select cl.company_id, cl.contract_id, cl.id, cl.category, 'REDUCE_HEADCOUNT', 1, date '2026-10-20', 'OTHER',
       'Additional guard left; last working day 2026-10-19 (0532)'
  from public.contract_lines cl
 where cl.id = 'e6dd176c-f2bb-4018-8815-5a9b4e04eded'
   and not exists (select 1 from public.contract_addendums a
                    where a.contract_line_id = cl.id and a.change_type = 'REDUCE_HEADCOUNT'
                      and a.effective_from = date '2026-10-20');

-- Asserts — on the things that can break.
do $$
declare v_n int; v_who text;
begin
  -- 1. No post's committed total moved.
  select count(*), string_agg(b.contract_id::text || '/' || b.category::text, ', ') into v_n, v_who
    from m0532_before b
    left join (select contract_id, category, site_id, sum(committed_count)::int total
                 from public.contract_lines group by 1, 2, 3) a
      on a.contract_id = b.contract_id and a.category = b.category and a.site_id is not distinct from b.site_id
   where a.total is distinct from b.total;
  if v_n <> 0 then raise exception '0532 REFUSED: % post total(s) changed: %', v_n, v_who; end if;

  -- 2. No absorbed line remains.
  select count(*) into v_n from public.contract_lines where id in (
    '089ad682-73c8-47cd-88e7-af5494efff9a', '57d908c4-ff6a-4229-b5fe-10a38c33c239', 'ee1cc964-b551-447f-8876-68d3c9b495fb',
    'a6d8cc48-acd0-4c88-9c7e-ce589dcd2f5b', '43082c0f-22e1-4540-9613-733b97ba0d30', 'ff5691b6-7166-4c2f-97f9-2d0e4f89ae60',
    '5114637d-b4b6-42a1-a40f-997026892ff9', '115647d4-2c2f-48ea-9b7b-3909f2ff50cb', '6036cc1b-531e-4376-88d5-a51e0082b56d',
    'bd255df5-6bd9-4707-b646-3857759a5bb0', '1b0f6594-a4ac-473a-a45a-58cf5299a9dc', '8a2aef62-7031-4083-ba32-6f3d87cc6c2a',
    '8be5fe4a-3e91-4e99-a79c-191ade763e16', '49b0ef20-51d3-4af6-b107-1326e8b5b0a1', '2ce06a0c-890f-4f46-a21c-b5fc7b7d3a41');
  if v_n <> 0 then raise exception '0532 REFUSED: % absorbed line(s) remain.', v_n; end if;

  -- 3. Every active contract now has one line per post, except the two pairs
  --    that stay two by decision.
  select count(*), string_agg(g.contract_id::text || '/' || g.category::text, ', ') into v_n, v_who
    from (select cl.contract_id, cl.category, cl.site_id from public.contract_lines cl
            join public.contracts k on k.id = cl.contract_id and k.status = 'active'
           group by 1, 2, 3 having count(*) > 1) g
   where not (g.contract_id = '8c425905-995a-4fde-97c6-14bc7c615b77' and g.category = 'WEAPON' and g.site_id is null)
     and not (g.contract_id = 'cfbc2798-cdf7-4e15-a429-ae37436b8779' and g.category = 'GUARD'
              and g.site_id = '24024ef5-cfe0-4c74-9bd9-17a0ce03e45b');
  if v_n <> 0 then raise exception '0532 REFUSED: % post(s) still split: %', v_n, v_who; end if;

  -- 4. Emaar's post is 66 at 62,263.
  select count(*) into v_n from public.contract_lines
   where id = '3bb3ba27-ab4d-4d5f-948a-bb5241947158' and committed_count = 66 and unit_rate = 62263 and shift_code is null;
  if v_n <> 1 then raise exception '0532 REFUSED: Emaar DHA ISB guard line is not 66 @ 62,263.'; end if;

  -- 5. Sweet Palace carries exactly one reduction from 2026-10-20.
  select count(*) into v_n from public.contract_addendums
   where contract_line_id = 'e6dd176c-f2bb-4018-8815-5a9b4e04eded' and change_type = 'REDUCE_HEADCOUNT'
     and count_delta = 1 and effective_from = date '2026-10-20';
  if v_n <> 1 then raise exception '0532 REFUSED: expected 1 Sweet Palace reduction, found %.', v_n; end if;
end $$;
