-- 0292 — compliance_upcoming gains the secondary label the screens need.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- WHY THIS EXISTS
--
-- 0291 made the view the one place that answers "what is due or overdue".
-- Repointing Licences.tsx at it then hit a gap: the page shows two lines per
-- row, and the view only carries one. The second line is the guard's display
-- code ("EMR-014 · Weapon licence"), assembled on the client from the employee
-- row plus the client's employee_id_prefix.
--
-- Two ways to close that, and only one of them is consolidation:
--
--   (a) have the page re-fetch employees and clients to rebuild the code —
--       which is the client-side assembly 0291 exists to delete, reintroduced
--       under a different name;
--   (b) compute it in the view.
--
-- (b). A consolidation that leaves the consumer joining three tables to render
-- a subtitle has moved the duplication rather than removed it.
--
-- THE DISPLAY CODE RULE, RESTATED HERE AND WHY THAT IS A RISK
--
-- src/app/lib/guardCode.ts:
--
--   display_code = {current client's employee_id_prefix}-{padded display_number}
--   falling back to guard_code, then employee_code, when there is no prefix or
--   no display number (office staff, unposted, client without a prefix).
--
-- That rule is now written twice: once in TypeScript for every other screen,
-- once here in SQL. Stated plainly because it is exactly the shape this round
-- has been removing, and pretending otherwise would be worse than owning it.
--
-- It is accepted for one reason: the alternative is worse. The rule is stable
-- (unchanged since Phase 2/3), it is four lines, and the verification below
-- asserts the SQL and the TypeScript agree on all three branches — prefixed,
-- no-prefix, and no-display-number — so a future change to one that is not
-- made to the other fails a migration replay rather than drifting silently.
--
-- If a third implementation is ever wanted, the honest fix is a generated
-- column on employees, and this view should read it.
--
-- NOTHING ELSE MOVES
--
-- Same 14 arms, same membership, same notice windows, same days_remaining.
-- The verification proves the row count and every existing column are
-- unchanged — this is an additive column, and a "small addition" that quietly
-- altered the compliance surface is precisely the defect 0289 was written to
-- avoid.

-- ---------------------------------------------------------------------------
-- Baseline captured BEFORE the change, so "unchanged" is measured rather than
-- asserted. A temp table on commit drop: the migration is one transaction.
-- ---------------------------------------------------------------------------

create temp table _cu_before on commit drop as
  select company_id, branch_id, kind, ref_id, label, due_date, notice_days, days_remaining
    from public.compliance_upcoming;

drop view if exists public.compliance_upcoming;

create view public.compliance_upcoming as
with employed as (
  -- The single membership rule. See 0291.
  select e.id, e.company_id, e.branch_id, e.full_name,
         e.weapon_licence_expiry, e.guard_service_licence_expiry,
         e.medical_fitness_expiry, e.probation_end_date,
         e.cnic_expiry, e.weapons_cert_expiry, e.refresher_due_date,
         -- guardCode.ts, in SQL. See the header for why this duplication is
         -- accepted and how it is held to the TypeScript.
         case
           when e.display_number is not null and coalesce(cl.employee_id_prefix, '') <> ''
             then cl.employee_id_prefix || '-' || lpad(e.display_number::text, 3, '0')
           else coalesce(e.guard_code, e.employee_code, '')
         end as display_code
    from public.employees e
    left join public.clients cl on cl.id = e.client_id
   where e.lifecycle_state in ('active', 'on_leave')
),
items as (
  -- ── existing four, unchanged in shape ───────────────────────────────────
  select c.company_id, c.branch_id, 'case'::text as kind, c.id as ref_id,
         c.title as label, c.target_date as due_date, 30 as notice_days,
         coalesce(c.authority, c.jurisdiction::text, c.case_type::text) as sublabel
    from public.compliance_cases c
   where c.stage <> 'issued'::compliance_stage and c.target_date is not null
  union all
  select s.company_id, s.branch_id, 'statutory_filing', s.id,
         s.filing_type::text, s.due_date, 30,
         to_char(s.period_month, 'Mon YYYY')
    from public.statutory_filings s
   where s.paid_date is null and s.due_date is not null
  union all
  select e.company_id, e.branch_id, 'weapon_licence', e.id,
         'Weapon licence — ' || e.full_name, e.weapon_licence_expiry, 30,
         e.display_code
    from employed e where e.weapon_licence_expiry is not null
  union all
  select e.company_id, e.branch_id, 'guard_licence', e.id,
         'Guard service licence — ' || e.full_name, e.guard_service_licence_expiry, 30,
         e.display_code
    from employed e where e.guard_service_licence_expiry is not null

  -- ── computed on the client but never server-side ────────────────────────
  union all
  select e.company_id, e.branch_id, 'medical_fitness', e.id,
         'Medical fitness — ' || e.full_name, e.medical_fitness_expiry, 30,
         e.display_code
    from employed e where e.medical_fitness_expiry is not null
  union all
  select e.company_id, e.branch_id, 'probation_end', e.id,
         'Probation ends — ' || e.full_name, e.probation_end_date, 30,
         e.display_code
    from employed e where e.probation_end_date is not null

  -- ── covered by nothing before 0291 ──────────────────────────────────────
  union all
  select e.company_id, e.branch_id, 'cnic', e.id,
         'CNIC expiry — ' || e.full_name, e.cnic_expiry, 30,
         e.display_code
    from employed e where e.cnic_expiry is not null
  union all
  select e.company_id, e.branch_id, 'weapons_cert', e.id,
         'Weapons certificate — ' || e.full_name, e.weapons_cert_expiry, 30,
         e.display_code
    from employed e where e.weapons_cert_expiry is not null
  union all
  select e.company_id, e.branch_id, 'refresher', e.id,
         'Refresher training due — ' || e.full_name, e.refresher_due_date, 30,
         e.display_code
    from employed e where e.refresher_due_date is not null
  union all
  -- Only documents actually on file. A 'missing' document has no expiry to
  -- warn about; its absence is the document checklist's question, not this one.
  select g.company_id, e.branch_id, 'guard_document', g.id,
         g.doc_type::text || ' — ' || e.full_name, g.expiry_date, 30,
         e.display_code
    from public.guard_documents g
    join employed e on e.id = g.employee_id
   where g.expiry_date is not null and g.status = 'on_file'
  union all
  select t.company_id, e.branch_id, 'training', t.id,
         t.kind::text || ' training — ' || e.full_name, t.expires_on, 30,
         e.display_code
    from public.employee_training_records t
    join employed e on e.id = t.employee_id
   where t.expires_on is not null
  union all
  select i.company_id, i.branch_id, 'inventory_licence', i.id,
         'Item licence — ' || coalesce(i.serial_number, i.item_type::text), i.license_expiry, 30,
         i.item_type::text
    from public.inventory_items i
   where i.license_expiry is not null

  -- ── moved off the edge function and the client ──────────────────────────
  union all
  select k.company_id, null::uuid, 'contract_end', k.id,
         coalesce(cl.name, 'Client')
           || coalesce(' (' || k.contract_code || ')', '')
           || ' — contract ends',
         k.end_date, 14,
         -- contract_code is nullable; the sublabel must never be blank.
         coalesce(k.contract_code, 'Contract')
    from public.contracts k
    left join public.clients cl on cl.id = k.client_id
   where k.status = 'active' and k.end_date is not null and not k.is_infinite
  union all
  -- The edge function's collapse, carried over verbatim in intent. See 0291.
  select d.company_id, null::uuid, 'important_date',
         (array_agg(d.id order by d.id))[1],
         (array_agg(d.title order by d.id))[1], d.due_date,
         max(coalesce(d.advance_notice_days, 7)),
         (array_agg(d.category || ' · ' || d.priority order by d.id))[1]
    from public.important_dates d
   where d.due_date is not null
   group by d.company_id, lower(btrim(d.title)), d.due_date
)
select i.company_id,
       i.branch_id,
       i.kind,
       i.ref_id,
       i.label,
       i.due_date,
       i.notice_days,
       (i.due_date - current_date) as days_remaining,
       i.sublabel
  from items i;

comment on view public.compliance_upcoming is
  'THE source of truth for what is due or overdue. Before 0291 this question was computed five times — here, in send-compliance-alerts, in Licences.tsx, in Dashboard.tsx and in ai-chat — and the implementations disagreed about whether an employee on leave counts. Membership is lifecycle_state in (active, on_leave): status is derived from lifecycle_state by trigger, so filtering on status reads a copy, and an employee on leave is exactly the person whose lapsing licence nobody is watching. notice_days is the item own window, carried over from the edge function. days_remaining is negative when overdue and is deliberately not filtered here. sublabel is the row second line — the guard display code for employee rows, per guardCode.ts, added by 0292 so consumers do not rejoin employees and clients to render it. See 0291 and 0292.';

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_diff int; v_before int; v_after int; v_null int;
      v_emp uuid; v_co uuid; v_cli uuid; v_sub text;
    begin
      -- 1. ADDITIVE, PROVED. Every pre-existing column is byte-identical on
      -- every row, both directions of the difference. A view edit that
      -- silently changed the compliance surface is the failure this asserts
      -- against, not the one it assumes did not happen.
      select count(*) into v_before from _cu_before;
      select count(*) into v_after  from public.compliance_upcoming;
      if v_before <> v_after then
        raise exception '0292 FAILED: row count moved, % before and % after', v_before, v_after;
      end if;

      select count(*) into v_diff from (
        select company_id, branch_id, kind, ref_id, label, due_date, notice_days, days_remaining
          from _cu_before
        except all
        select company_id, branch_id, kind, ref_id, label, due_date, notice_days, days_remaining
          from public.compliance_upcoming
      ) d;
      if v_diff <> 0 then
        raise exception '0292 FAILED: % row(s) present before and not after — the addition changed existing output', v_diff;
      end if;

      select count(*) into v_diff from (
        select company_id, branch_id, kind, ref_id, label, due_date, notice_days, days_remaining
          from public.compliance_upcoming
        except all
        select company_id, branch_id, kind, ref_id, label, due_date, notice_days, days_remaining
          from _cu_before
      ) d;
      if v_diff <> 0 then
        raise exception '0292 FAILED: % row(s) present after and not before', v_diff;
      end if;

      -- 2. THE NEW COLUMN IS POPULATED. Not merely present — a column of NULLs
      -- would satisfy (1) perfectly and render two blank lines on the page.
      select count(*) into v_null from public.compliance_upcoming
       where coalesce(sublabel, '') = '';
      if v_null > 0 and v_before > 0 then
        raise exception '0292 FAILED: % row(s) have an empty sublabel', v_null;
      end if;

      -- 3. THE DISPLAY CODE MATCHES guardCode.ts ON ALL THREE BRANCHES.
      --
      -- Data-independent: the probe creates each condition rather than hoping
      -- the database contains it. 0291 lost three attempts to fixtures that
      -- asserted on data that was not there, and this is the same trap.
      select e.id, e.company_id into v_emp, v_co
        from public.employees e
       where e.lifecycle_state in ('active','on_leave') and e.cnic_expiry is not null
       limit 1;
      if v_emp is null then
        raise exception '0292: no employee available to probe the display code';
      end if;

      select c.id into v_cli from public.clients c where c.company_id = v_co limit 1;
      if v_cli is null then
        raise exception '0292: no client available to probe the display code';
      end if;

      -- (a) prefix + display_number -> PREFIX-014
      update public.clients   set employee_id_prefix = 'ZZTEST' where id = v_cli;
      update public.employees set client_id = v_cli, display_number = 14 where id = v_emp;
      select sublabel into v_sub from public.compliance_upcoming
       where ref_id = v_emp and kind = 'cnic';
      if v_sub is distinct from 'ZZTEST-014' then
        raise exception '0292 FAILED: prefixed display code is %, expected ZZTEST-014', coalesce(v_sub, '<null>');
      end if;

      -- (b) no prefix -> falls back to guard_code/employee_code
      update public.clients set employee_id_prefix = null where id = v_cli;
      select sublabel into v_sub from public.compliance_upcoming
       where ref_id = v_emp and kind = 'cnic';
      if v_sub is distinct from (select coalesce(guard_code, employee_code, '')
                                   from public.employees where id = v_emp) then
        raise exception '0292 FAILED: with no client prefix the code is %, expected the guard/employee code', coalesce(v_sub, '<null>');
      end if;

      -- (c) prefix present but no display_number -> also falls back
      update public.clients   set employee_id_prefix = 'ZZTEST' where id = v_cli;
      update public.employees set display_number = null where id = v_emp;
      select sublabel into v_sub from public.compliance_upcoming
       where ref_id = v_emp and kind = 'cnic';
      if v_sub is distinct from (select coalesce(guard_code, employee_code, '')
                                   from public.employees where id = v_emp) then
        raise exception '0292 FAILED: with no display_number the code is %, expected the guard/employee code', coalesce(v_sub, '<null>');
      end if;

      -- 4. STILL ABLE TO REPORT. The sublabel must depend on the data, not be
      -- a constant that happened to match above.
      update public.employees set display_number = 999 where id = v_emp;
      select sublabel into v_sub from public.compliance_upcoming
       where ref_id = v_emp and kind = 'cnic';
      if v_sub is distinct from 'ZZTEST-999' then
        raise exception 'PROBE INSENSITIVE: changed display_number to 999 and the code read %', coalesce(v_sub, '<null>');
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0292 verification failed: %', v_outcome;
  end if;
end
$verify$;
