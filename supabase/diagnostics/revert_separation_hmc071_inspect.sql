-- Inspect what the accidental separation of HMC-071 actually wrote, BEFORE
-- reverting it with migration 0196. Read-only: run each block on its own in the
-- Supabase SQL editor (the editor only returns the last statement's result).
--
-- HMC-071 is a CLIENT DISPLAY code: clients.employee_id_prefix = 'HMC' and
-- employees.display_number = 71. The permanent guard_code has a company prefix
-- and 5 digits, so it is matched here as a fallback only.

-- 1. Resolve the guard. Expect exactly ONE row. If you get zero or more than
--    one, stop and fix the identifier before running 0196.
select e.id, e.full_name, e.guard_code, e.employee_code, e.display_number,
       c.employee_id_prefix, c.name as client_name,
       e.lifecycle_state, e.separation_reason, e.last_working_day,
       e.termination_date, e.exit_date, e.exit_reason, e.eligible_for_rehire,
       e.rehire_count, e.blacklisted, e.updated_at
  from public.employees e
  left join public.clients c on c.id = e.client_id
 where (upper(c.employee_id_prefix) = 'HMC' and e.display_number = 71)
    or upper(e.guard_code)    = 'HMC-071'
    or upper(e.employee_code) = 'HMC-071';

-- 2. The separation write on employees, straight from the audit trail.
--    changes->'<field>'->>'before' is what 0196 restores.
select a.id, a.changed_at, a.changed_by, a.changes
  from public.audit_log a
 where a.table_name = 'employees'
   and a.record_id = (select e.id from public.employees e
                        left join public.clients c on c.id = e.client_id
                       where (upper(c.employee_id_prefix) = 'HMC' and e.display_number = 71)
                          or upper(e.guard_code) = 'HMC-071')
   and a.action = 'update'
   and a.changes ? 'lifecycle_state'
 order by a.changed_at desc
 limit 5;

-- 3. Postings. The separation closed the open one (end_date = last working day,
--    reason = 'separation'), and may have DELETED any posting that had not
--    started by then (0184) into deployments_overlap_backup_0183.
select d.id, d.client_id, d.site_id, d.contract_line_id,
       d.start_date, d.end_date, d.reason, d.created_at, d.updated_at
  from public.deployments d
 where d.guard_id = (select e.id from public.employees e
                       left join public.clients c on c.id = e.client_id
                      where (upper(c.employee_id_prefix) = 'HMC' and e.display_number = 71)
                         or upper(e.guard_code) = 'HMC-071')
 order by d.start_date desc;

select b.* from public.deployments_overlap_backup_0183 b
 where b.guard_id = (select e.id from public.employees e
                       left join public.clients c on c.id = e.client_id
                      where (upper(c.employee_id_prefix) = 'HMC' and e.display_number = 71)
                         or upper(e.guard_code) = 'HMC-071')
 order by b.backed_up_at desc;

-- 4. The vacancy the posting-close trigger raised, if any.
select v.* from public.vacancies v
 where v.vacated_by_guard_id = (select e.id from public.employees e
                                  left join public.clients c on c.id = e.client_id
                                 where (upper(c.employee_id_prefix) = 'HMC' and e.display_number = 71)
                                    or upper(e.guard_code) = 'HMC-071')
 order by v.opened_at desc;

-- 5. Lifecycle events + the discharge sheet filed on separation.
select l.* from public.employee_lifecycle_events l
 where l.employee_id = (select e.id from public.employees e
                          left join public.clients c on c.id = e.client_id
                         where (upper(c.employee_id_prefix) = 'HMC' and e.display_number = 71)
                            or upper(e.guard_code) = 'HMC-071')
 order by l.changed_at desc limit 10;

select g.* from public.guard_documents g
 where g.employee_id = (select e.id from public.employees e
                          left join public.clients c on c.id = e.client_id
                         where (upper(c.employee_id_prefix) = 'HMC' and e.display_number = 71)
                            or upper(e.guard_code) = 'HMC-071')
   and g.doc_type = 'discharge_sheet';
