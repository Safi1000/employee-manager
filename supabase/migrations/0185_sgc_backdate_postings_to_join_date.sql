-- 0185: SGC — start the five August joiners' postings on their join date.
--
-- Iftikhar Hussain, Muhammad Muzzamil, Muhammad Rameez, Sarfraz Ahmed and
-- Sikandar Hayat all carry join_date 2026-08-01 but their postings were opened
-- 2026-08-10. Assignments & Pay counts them from employees.client_id (16) while
-- the attendance board counts postings (11) — the nine-day gap was the whole
-- discrepancy. The join date is the correct one, so the postings move back to
-- meet it and the board reads 16 from 1 August.
--
-- Safe to run: each of the five holds exactly ONE posting, so moving start_date
-- cannot overlap a sibling segment, and none of them has an attendance record
-- anywhere in 2026-08-01..2026-08-09, so no marked day changes meaning.
--
-- ALREADY APPLIED to production on 2026-08-12. Kept as the record of the change.
-- Verified after: SGC reads 16 on the board and 16 in Assignments & Pay, with no
-- new double-postings and no inverted segments.

insert into public.deployments_overlap_backup_0183
select d.*, now(), 'pre-backdate copy - 0185 (start_date was ' || d.start_date || ')'
  from public.deployments d
 where d.id in (
   'e263b2ae-8910-458d-a434-7daeec775c17',
   '30f2f2c6-a756-438d-a301-f1743b584e6b',
   '81f8cf55-844e-4e73-8966-2746a2b6e9fc',
   '8a880588-4ffa-46a6-b1bb-a3106b5b1615',
   '716e6d88-f7aa-4866-9d33-0742ba3bad89');

update public.deployments d
   set start_date = e.join_date,
       updated_at = now()
  from public.employees e
 where e.id = d.guard_id
   and d.id in (
     'e263b2ae-8910-458d-a434-7daeec775c17',
     '30f2f2c6-a756-438d-a301-f1743b584e6b',
     '81f8cf55-844e-4e73-8966-2746a2b6e9fc',
     '8a880588-4ffa-46a6-b1bb-a3106b5b1615',
     '716e6d88-f7aa-4866-9d33-0742ba3bad89')
   and e.join_date is not null
   and e.join_date < d.start_date;
