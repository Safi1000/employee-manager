-- 0306 — vetting_dashboard already was the coverage report. Make it able to
-- measure the upload, and make the report read it.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- THE RECONCILIATION THAT CAME FIRST
--
-- GUARD_DATA_COVERAGE_PRODUCTION_2026-09-01.md was assembled by hand without
-- noticing this view existed. Before repointing anything the two were diffed
-- on production, read-only, on GUARDS AND GUIDES (PVT) LTD:
--
--   population       view 347   report 347   (lifecycle_state in active/on_leave
--                                             = status 'Active' = 347; the
--                                             lifecycle-versus-status split
--                                             does not divide this population)
--   rows not dropped view sums to 347 across 5 branch groups, 27 of the
--                    employees have a null branch_id and the LEFT JOIN keeps
--                    them
--   police_pending   view 346   report 346
--   police_adverse   view   0   report   0
--   nadra_pending    view 345   report 345
--   not weapons cert view 347   report 347
--   weapons expired  view   0   report   0
--
-- Every figure the two both compute agrees. THE REPORT IS WRONG ON TWO ROWS
-- THE VIEW DOES NOT COMPUTE.
--
-- It records "Police verification — verified: 0" and "NADRA Verisys —
-- verified: 0". The vetting_status enum is (pending, cleared, adverse). There
-- is no 'verified'. That zero was structural, not measured — a count of a
-- value the column cannot hold. The true figures are 1 police-cleared and 2
-- NADRA-cleared.
--
-- Three people, out of 347. It does not change the shape of the backlog. It
-- does change the sentence "the pipeline has never produced a completed
-- check", which was false, and it is the second time in this project that a
-- question was asked in vocabulary the data does not use and answered zero.
-- The report is corrected in the same commit.
--
-- WHY THE VIEW COULD NOT HAVE CAUGHT IT
--
-- Because it counts only pending and adverse. total minus those two conflates
-- 'cleared' with 'no result recorded' — precisely the distinction the upload
-- exists to change, and the number Shayan needs to watch while it runs.
--
-- So the view gains the cleared counters and the four recorded/missing
-- counters the report tabulates. Purely additive: every existing column keeps
-- its name, position and value, proved below by set difference in both
-- directions against a baseline taken before the change.
--
-- AND THE VIEW BECOMES THE SOURCE. The report is regenerated from it, so the
-- number Shayan watches during the upload and the number the schema computes
-- are one number. cnic_expiry_coverage going green in ledger_checks() remains
-- the completion signal; this view is how the progress towards it is read.

create temporary table zz_0306_baseline on commit drop as
  select * from public.vetting_dashboard;

create or replace view public.vetting_dashboard
  with (security_invoker = true) as
  select e.company_id,
         e.branch_id,
         b.name as region_name,
         count(*) as total,
         count(*) filter (where e.police_verification_status = 'pending') as police_pending,
         count(*) filter (where e.police_verification_status = 'adverse') as police_adverse,
         count(*) filter (where e.nadra_verisys_status = 'pending')       as nadra_pending,
         count(*) filter (where e.nadra_verisys_status = 'adverse')       as nadra_adverse,
         count(*) filter (where not e.weapons_certified)                  as not_weapons_certified,
         count(*) filter (where e.weapons_certified
                            and e.weapons_cert_expiry < current_date)     as weapons_cert_expired,

         -- 0306. THE COLUMNS THE UPLOAD MOVES.
         --
         -- Without these, total - pending - adverse reads as "cleared" and is
         -- actually "cleared or never recorded". The report said 0 cleared
         -- when the true figures were 1 and 2, because it asked for a value
         -- the enum does not contain; these two make the question answerable
         -- in the vocabulary the column actually uses.
         count(*) filter (where e.police_verification_status = 'cleared')  as police_cleared,
         count(*) filter (where e.nadra_verisys_status = 'cleared')        as nadra_cleared,
         count(*) filter (where e.police_verification_status is null)      as police_not_recorded,
         count(*) filter (where e.nadra_verisys_status is null)            as nadra_not_recorded,

         -- 0306. The identity-document backlog, same population, same row.
         count(*) filter (where coalesce(e.cnic_number, '') <> '')         as cnic_number_recorded,
         count(*) filter (where e.cnic_expiry is not null)                 as cnic_expiry_recorded,
         count(*) filter (where coalesce(e.weapon_licence_number, '') <> '') as weapon_licence_on_file,
         count(*) filter (where e.blacklisted)                             as blacklisted
    from public.employees e
    left join public.branches b on b.id = e.branch_id
   where e.lifecycle_state in ('active', 'on_leave')
   group by e.company_id, e.branch_id, b.name;

comment on view public.vetting_dashboard is
  'Guard vetting and identity-document coverage per company and region, over employees whose lifecycle_state is active or on_leave. THIS IS THE SOURCE FOR docs/GUARD_DATA_COVERAGE_PRODUCTION_*.md — regenerate the report from here rather than by hand (0306). A count of cleared is not the complement of pending: read police_not_recorded alongside it.';

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co   uuid;
      v_bad  int;
      v_a    bigint; v_b bigint;
    begin
      -- 1. PURELY ADDITIVE. Every pre-change row must still be present with
      -- the same values, and no row may have appeared or vanished. Compared
      -- in BOTH directions: `except all` one way alone would pass if the new
      -- view returned a superset.
      select count(*) into v_bad from (
        select company_id, branch_id, region_name, total, police_pending,
               police_adverse, nadra_pending, nadra_adverse,
               not_weapons_certified, weapons_cert_expired
          from zz_0306_baseline
        except all
        select company_id, branch_id, region_name, total, police_pending,
               police_adverse, nadra_pending, nadra_adverse,
               not_weapons_certified, weapons_cert_expired
          from public.vetting_dashboard) d;
      if v_bad <> 0 then
        raise exception '0306 FAILED: % baseline row(s) are missing or changed', v_bad;
      end if;

      select count(*) into v_bad from (
        select company_id, branch_id, region_name, total, police_pending,
               police_adverse, nadra_pending, nadra_adverse,
               not_weapons_certified, weapons_cert_expired
          from public.vetting_dashboard
        except all
        select company_id, branch_id, region_name, total, police_pending,
               police_adverse, nadra_pending, nadra_adverse,
               not_weapons_certified, weapons_cert_expired
          from zz_0306_baseline) d;
      if v_bad <> 0 then
        raise exception '0306 FAILED: % row(s) appeared that were not in the baseline', v_bad;
      end if;

      -- 2. NO EMPLOYEE IS DROPPED BY THE GROUPING. 27 of the 347 on prod have
      -- a null branch_id; an inner join to branches would have silently lost
      -- them and every column would still have looked plausible.
      for v_co in select id from public.companies loop
        select coalesce(sum(total), 0) into v_a
          from public.vetting_dashboard where company_id = v_co;
        select count(*) into v_b from public.employees
         where company_id = v_co and lifecycle_state in ('active', 'on_leave');
        if v_a <> v_b then
          raise exception '0306 FAILED: the view totals % for a company with % in-scope employees', v_a, v_b;
        end if;
      end loop;

      -- 3. THE NEW COUNTERS RECONCILE AGAINST THE COLUMN THEY MEASURE. This
      -- is the hand-versus-view diff, made permanent: cleared + pending +
      -- adverse + not_recorded must exhaust the population, on every company.
      -- The report's error was exactly a term missing from this sum.
      select count(*) into v_bad from (
        select company_id
          from public.vetting_dashboard
         group by company_id
        having sum(police_cleared + police_pending + police_adverse + police_not_recorded)
                 <> sum(total)
            or sum(nadra_cleared + nadra_pending + nadra_adverse + nadra_not_recorded)
                 <> sum(total)) d;
      if v_bad <> 0 then
        raise exception '0306 FAILED: the vetting statuses do not exhaust the population on % compan(ies) — a status is unaccounted for', v_bad;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0306 verification failed: %', v_outcome;
  end if;
end
$verify$;
