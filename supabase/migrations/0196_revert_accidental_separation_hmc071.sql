-- 0196: Erase an accidental separation for guard HMC-071.
--
-- The separation was keyed in by mistake. This does not "rehire" him —
-- rehire_guard() (0128) would bump rehire_count, open a NEW posting from the
-- rehire date and leave a visible gap in his service where he was never in fact
-- gone. Instead the original posting is REOPENED in place, so the employment
-- segment runs unbroken through the date he was wrongly separated, and every
-- trace of the separation is removed:
--
--   1. employees   — lifecycle_state restored; separation_reason,
--                    last_working_day, termination_date, exit_date, exit_reason
--                    cleared outright; client_id + display_number forced back
--   2. deployments — the closed posting reopened with its ORIGINAL reason (not a
--                    new row); any posting 0184 deleted for starting after the
--                    last working day restored from deployments_overlap_backup_0183
--   3. vacancies   — the row raised by trg_raise_vacancy_on_posting_close cancelled
--   4. employee_lifecycle_events — the separation event DELETED, so the guard's
--                    service-history timeline (employee_service_history, 0122)
--                    shows no separation and no reinstatement
--   5. guard_documents — the discharge sheet withdrawn
--
-- rehire_count is deliberately NOT incremented: there was no rehire.
--
-- Prior values come from the audit trail (0041/0167 log a per-field
-- before/after diff for employees and deployments), so this restores what was
-- actually there rather than guessing.
--
-- ORDER MATTERS. The deployments writes fire trg_deployments_sync_client
-- (sync_employee_active_client, 0123/0153), which rewrites employees.client_id
-- and NULLS display_number whenever the resolved client differs. So the
-- employees row is written LAST, after the postings have settled, and client_id
-- + display_number are restored explicitly rather than left to the trigger.
--
-- Safe to run twice: aborts if the guard is not currently separated.

do $$
declare
  v_emp      uuid;
  v_company  uuid;
  v_name     text;
  v_n        int;
  v_audit    public.audit_log%rowtype;
  v_from     public.employee_lifecycle_state;
  v_state    public.employee_lifecycle_state;
  v_lwd      date;
  v_client   uuid;
  v_display  int;
  v_dep      uuid;
  v_restored int := 0;
  v_vac      int := 0;
  v_evt      int := 0;
begin
  ---------------------------------------------------------------------------
  -- 0. Resolve HMC-071. It is a client display code (clients.employee_id_prefix
  --    'HMC' + employees.display_number 71); guard_code/employee_code are
  --    matched as a fallback in case display_number was already cleared.
  ---------------------------------------------------------------------------
  select count(*) into v_n
    from public.employees e
    left join public.clients c on c.id = e.client_id
   where (upper(c.employee_id_prefix) = 'HMC' and e.display_number = 71)
      or upper(e.guard_code) = 'HMC-071' or upper(e.employee_code) = 'HMC-071';

  if v_n <> 1 then
    raise exception 'HMC-071 resolved to % employees, expected exactly 1. Run supabase/diagnostics/revert_separation_hmc071_inspect.sql and pin the id by hand.', v_n;
  end if;

  select e.id, e.company_id, e.full_name, e.lifecycle_state,
         e.last_working_day, e.client_id, e.display_number
    into v_emp, v_company, v_name, v_state, v_lwd, v_client, v_display
    from public.employees e
    left join public.clients c on c.id = e.client_id
   where (upper(c.employee_id_prefix) = 'HMC' and e.display_number = 71)
      or upper(e.guard_code) = 'HMC-071' or upper(e.employee_code) = 'HMC-071';

  if v_state not in ('fired','left','absconded','terminated') then
    raise exception 'HMC-071 (%) is in state % — not separated. Nothing to revert.', v_name, v_state;
  end if;

  raise notice 'Erasing separation for % (%): state=%, last working day=%', v_name, v_emp, v_state, v_lwd;

  ---------------------------------------------------------------------------
  -- 1. Read the separation write off the audit trail: the pre-separation
  --    lifecycle_state, and the client/display number as they stood BEFORE it
  --    (the separation close may have moved either via the sync trigger).
  ---------------------------------------------------------------------------
  select * into v_audit
    from public.audit_log
   where table_name = 'employees' and record_id = v_emp and action = 'update'
     and changes ? 'lifecycle_state'
     and changes->'lifecycle_state'->>'after' in ('fired','left','absconded','terminated')
   order by changed_at desc
   limit 1;

  if v_audit.id is not null then
    raise notice 'Restore point: audit row % written %.', v_audit.id, v_audit.changed_at;
    v_from := nullif(v_audit.changes->'lifecycle_state'->>'before','')::public.employee_lifecycle_state;
  else
    select from_state into v_from
      from public.employee_lifecycle_events
     where employee_id = v_emp and reason like 'Separation:%'
     order by changed_at desc limit 1;
    raise notice 'No audit row; using lifecycle event from_state=%.', v_from;
  end if;

  -- Anything the sync trigger touched at separation time gets its pre-separation
  -- value back. An open posting is what he should have had all along, so the
  -- client he was posted to then is the correct one now.
  select coalesce(
           (select nullif(a.changes->'client_id'->>'before','')::uuid
              from public.audit_log a
             where a.table_name = 'employees' and a.record_id = v_emp
               and a.action = 'update' and a.changes ? 'client_id'
               and a.changed_at >= coalesce(v_audit.changed_at, now()) - interval '1 minute'
             order by a.changed_at asc limit 1),
           v_client)
    into v_client;

  select coalesce(
           (select nullif(a.changes->'display_number'->>'before','')::int
              from public.audit_log a
             where a.table_name = 'employees' and a.record_id = v_emp
               and a.action = 'update' and a.changes ? 'display_number'
               and a.changed_at >= coalesce(v_audit.changed_at, now()) - interval '1 minute'
             order by a.changed_at asc limit 1),
           v_display)
    into v_display;

  ---------------------------------------------------------------------------
  -- 2a. Undelete any posting 0184 dropped for starting after the last working
  --     day. Done BEFORE the reopen so the one-active-per-guard unique index
  --     catches a genuine conflict rather than silently preferring one.
  ---------------------------------------------------------------------------
  insert into public.deployments
    (id, company_id, guard_id, client_id, contract_line_id, site_id, post_id,
     start_date, end_date, reason, created_at, updated_at)
  select b.id, b.company_id, b.guard_id, b.client_id, b.contract_line_id, b.site_id,
         b.post_id, b.start_date, b.end_date, b.reason, b.created_at, now()
    from public.deployments_overlap_backup_0183 b
   where b.guard_id = v_emp
     and b.backup_note = 'posting began after last working day — record_separation'
     and not exists (select 1 from public.deployments d where d.id = b.id);
  get diagnostics v_restored = row_count;
  if v_restored > 0 then
    raise notice 'Restored % posting(s) deleted by the 0184 guard.', v_restored;
    delete from public.deployments_overlap_backup_0183
     where guard_id = v_emp
       and backup_note = 'posting began after last working day — record_separation';
  end if;

  ---------------------------------------------------------------------------
  -- 2b. Reopen the posting the separation closed — the SAME row, so the segment
  --     is continuous across the date he was wrongly let go. Its reason was
  --     overwritten with 'separation'; the original comes off the audit trail.
  ---------------------------------------------------------------------------
  select d.id into v_dep
    from public.deployments d
   where d.guard_id = v_emp and d.reason = 'separation'
     and d.end_date is not null
     and (v_lwd is null or d.end_date = v_lwd)
   order by d.end_date desc, d.start_date desc
   limit 1;

  if v_dep is not null then
    select * into v_audit
      from public.audit_log
     where table_name = 'deployments' and record_id = v_dep and action = 'update'
       and changes ? 'end_date' and changes->'end_date'->>'before' is null
     order by changed_at desc limit 1;

    update public.deployments d set
      end_date = null,
      reason   = coalesce(
        nullif(v_audit.changes->'reason'->>'before','')::public.deployment_reason,
        'new_hire'),
      updated_at = now()
    where d.id = v_dep;

    raise notice 'Reopened posting % — employment continuous, no gap.', v_dep;
  else
    raise warning 'No closed separation posting found; employees row still cleaned up.';
  end if;

  ---------------------------------------------------------------------------
  -- 3. Cancel the vacancy the close raised, while it is still open. If someone
  --    has already been posted against it that posting is real, the vacancy
  --    stays, and the reopen above collides with the one-active-per-guard index
  --    — the whole block then rolls back, which is the right thing to look at.
  ---------------------------------------------------------------------------
  update public.vacancies
     set status = 'cancelled'
   where vacated_by_guard_id = v_emp
     and status = 'open'
     and opened_reason like 'Posting closed (separation)%';
  get diagnostics v_vac = row_count;
  if v_vac > 0 then raise notice 'Cancelled % vacancy row(s).', v_vac; end if;

  ---------------------------------------------------------------------------
  -- 4. Delete the separation from the service-history timeline. No compensating
  --    "reverted" event is written — the instruction is that the record shows
  --    no separation at all, not a separation followed by an undo.
  ---------------------------------------------------------------------------
  delete from public.employee_lifecycle_events
   where employee_id = v_emp
     and to_state in ('fired','left','absconded','terminated')
     and (reason like 'Separation:%' or reason like 'Exit%');
  get diagnostics v_evt = row_count;
  raise notice 'Deleted % lifecycle event(s).', v_evt;

  ---------------------------------------------------------------------------
  -- 5. Withdraw the discharge sheet filed on separation.
  ---------------------------------------------------------------------------
  delete from public.guard_documents
   where employee_id = v_emp and doc_type = 'discharge_sheet'
     and notes = 'Generated on separation';

  ---------------------------------------------------------------------------
  -- 6. The employees row, written LAST so it survives the sync trigger. Every
  --    separation field goes to NULL — no termination date, no exit date, no
  --    reason — and the client + per-client display number are pinned back.
  ---------------------------------------------------------------------------
  update public.employees set
    lifecycle_state     = coalesce(v_from, 'active'),
    separation_reason   = null,
    last_working_day    = null,
    termination_date    = null,
    exit_date           = null,
    exit_reason         = null,
    eligible_for_rehire = null,
    client_id           = coalesce(v_client, client_id),
    display_number      = coalesce(v_display, display_number),
    updated_at          = now()
  where id = v_emp;

  raise notice 'Done. % is % under client %, display number %, with no separation on record.',
    v_name, coalesce(v_from, 'active'), v_client, v_display;
end $$;

-- ---------------------------------------------------------------------------
-- OPTIONAL — audit_log.
--
-- Everything above clears the separation from the guard's record and from every
-- screen that shows his history. It does NOT touch public.audit_log, which still
-- holds the raw field-level diff of the mistaken write (and is surfaced by the
-- Audit Log page). Left in place on purpose for two reasons: it is the trail
-- that made this restore possible in the first place, and it is the one record
-- that can show the separation was an operator error rather than a real event.
--
-- Uncomment to purge it as well. Irreversible, and it must run AFTER the block
-- above — the restore reads these rows.
-- ---------------------------------------------------------------------------
-- do $$
-- declare v_emp uuid;
-- begin
--   select e.id into v_emp from public.employees e
--     left join public.clients c on c.id = e.client_id
--    where (upper(c.employee_id_prefix) = 'HMC' and e.display_number = 71)
--       or upper(e.guard_code) = 'HMC-071' or upper(e.employee_code) = 'HMC-071';
--
--   delete from public.audit_log
--    where table_name = 'employees' and record_id = v_emp
--      and (changes ? 'lifecycle_state' or changes ? 'separation_reason'
--           or changes ? 'termination_date' or changes ? 'last_working_day');
--
--   delete from public.audit_log
--    where table_name = 'deployments'
--      and record_id in (select id from public.deployments where guard_id = v_emp)
--      and changes ? 'end_date';
-- end $$;
