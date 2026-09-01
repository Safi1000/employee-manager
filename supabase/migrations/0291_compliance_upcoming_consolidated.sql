-- 0291 — ONE server-side source of truth for "what is due or overdue".
--
-- DEV ONLY.
--
-- WHAT WAS THERE: FIVE IMPLEMENTATIONS, NOT THREE
--
-- The first audit found three. Grepping for anything that computes a day
-- difference against an expiry column found two more:
--
--   compliance_upcoming (this view)  cases, statutory filings, weapon licence,
--                                    guard service licence.  READ BY NOTHING.
--   send-compliance-alerts (edge)    important_dates, contract end.
--   Licences.tsx (client)            weapon, guard service, medical fitness,
--                                    probation end, contract end, important_dates.
--   Dashboard.tsx (client)           weapon, guard service, medical fitness,
--                                    probation end — a 30-day count.
--   ai-chat get_expiring_licences    weapon, guard service, medical fitness,
--                                    probation end, contract end, compliance dates.
--
-- Weapon licence is computed five times. Contract end three times. The
-- enumeration by reading found three of five, which is the argument for the
-- grep and for extending uninvoked_controls() to views.
--
-- THE FILTER, AND WHY IT IS NEITHER OF THE TWO IN USE
--
-- The two live filters disagree about exactly one lifecycle state:
--
--   compliance_upcoming   lifecycle_state = 'active'      EXCLUDES on_leave
--   the four client paths status <> 'Inactive'            INCLUDES on_leave
--
-- `status` is not an independent column: trigger sync_status_from_lifecycle
-- derives it from lifecycle_state (active -> 'Active', on_leave -> 'On Leave',
-- everything else -> 'Inactive'). So any filter on status is reading a copy,
-- and lifecycle_state is authoritative.
--
-- But the view's membership is wrong. An employee on leave is still employed,
-- returns, and is precisely the person nobody is watching day to day — a
-- licence lapsing while they are away is the case most worth catching, because
-- they come back and are deployed against it.
--
-- So: the view's COLUMN, the client paths' MEMBERSHIP.
--
--   lifecycle_state in ('active', 'on_leave')
--
-- Zero employees differ today on either database, because nobody has ever been
-- put on leave. The divergence is latent, not live, and this fixes it while it
-- is still theoretical. The first employee put on leave starts appearing here
-- where they previously would not — the change adds rows rather than hiding
-- them, which is the safe direction for a compliance surface.
--
-- NOTICE WINDOWS ARE CARRIED OVER, NOT REINVENTED
--
-- The edge function's per-item window logic is the one part of the five that is
-- already right, so it moves here unchanged:
--
--   important_date   coalesce(advance_notice_days, 7)   — the item's own window
--   contract_end     14                                 — widest of the edge
--                                                         function's [14,7,3,1]
--   everything else  30                                 — Dashboard's window and
--                                                         ai-chat's default, and
--                                                         Licences' first band
--
-- The [14,7,3,1] ladder stays in the edge function. It decides WHEN TO
-- RE-ANNOUNCE, which is delivery, not computation.
--
-- days_remaining is exposed so no consumer computes it again. Negative means
-- overdue, and it is deliberately not filtered out here: Dashboard's count
-- currently uses `d >= today && d <= in30`, which silently drops a licence that
-- expired yesterday. Consumers that want only the future can say so; the source
-- will not decide it for them.

drop view if exists public.compliance_upcoming;

create view public.compliance_upcoming as
with employed as (
  -- The single membership rule. See the header.
  select e.id, e.company_id, e.branch_id, e.full_name,
         e.weapon_licence_expiry, e.guard_service_licence_expiry,
         e.medical_fitness_expiry, e.probation_end_date,
         e.cnic_expiry, e.weapons_cert_expiry, e.refresher_due_date
    from public.employees e
   where e.lifecycle_state in ('active', 'on_leave')
),
items as (
  -- ── existing four, unchanged in shape ───────────────────────────────────
  select c.company_id, c.branch_id, 'case'::text as kind, c.id as ref_id,
         c.title as label, c.target_date as due_date, 30 as notice_days
    from public.compliance_cases c
   where c.stage <> 'issued'::compliance_stage and c.target_date is not null
  union all
  select s.company_id, s.branch_id, 'statutory_filing', s.id,
         s.filing_type::text, s.due_date, 30
    from public.statutory_filings s
   where s.paid_date is null and s.due_date is not null
  union all
  select e.company_id, e.branch_id, 'weapon_licence', e.id,
         'Weapon licence — ' || e.full_name, e.weapon_licence_expiry, 30
    from employed e where e.weapon_licence_expiry is not null
  union all
  select e.company_id, e.branch_id, 'guard_licence', e.id,
         'Guard service licence — ' || e.full_name, e.guard_service_licence_expiry, 30
    from employed e where e.guard_service_licence_expiry is not null

  -- ── computed on the client but never server-side ────────────────────────
  union all
  select e.company_id, e.branch_id, 'medical_fitness', e.id,
         'Medical fitness — ' || e.full_name, e.medical_fitness_expiry, 30
    from employed e where e.medical_fitness_expiry is not null
  union all
  select e.company_id, e.branch_id, 'probation_end', e.id,
         'Probation ends — ' || e.full_name, e.probation_end_date, 30
    from employed e where e.probation_end_date is not null

  -- ── covered by nothing before this migration ────────────────────────────
  union all
  select e.company_id, e.branch_id, 'cnic', e.id,
         'CNIC expiry — ' || e.full_name, e.cnic_expiry, 30
    from employed e where e.cnic_expiry is not null
  union all
  select e.company_id, e.branch_id, 'weapons_cert', e.id,
         'Weapons certificate — ' || e.full_name, e.weapons_cert_expiry, 30
    from employed e where e.weapons_cert_expiry is not null
  union all
  select e.company_id, e.branch_id, 'refresher', e.id,
         'Refresher training due — ' || e.full_name, e.refresher_due_date, 30
    from employed e where e.refresher_due_date is not null
  union all
  -- Only documents actually on file. A 'missing' document has no expiry to
  -- warn about; its absence is the document checklist's question, not this one.
  select g.company_id, e.branch_id, 'guard_document', g.id,
         g.doc_type::text || ' — ' || e.full_name, g.expiry_date, 30
    from public.guard_documents g
    join employed e on e.id = g.employee_id
   where g.expiry_date is not null and g.status = 'on_file'
  union all
  select t.company_id, e.branch_id, 'training', t.id,
         t.kind::text || ' training — ' || e.full_name, t.expires_on, 30
    from public.employee_training_records t
    join employed e on e.id = t.employee_id
   where t.expires_on is not null
  union all
  select i.company_id, i.branch_id, 'inventory_licence', i.id,
         'Item licence — ' || coalesce(i.serial_number, i.item_type::text), i.license_expiry, 30
    from public.inventory_items i
   where i.license_expiry is not null

  -- ── moved off the edge function and the client ──────────────────────────
  union all
  select k.company_id, null::uuid, 'contract_end', k.id,
         coalesce(cl.name, 'Client')
           || coalesce(' (' || k.contract_code || ')', '')
           || ' — contract ends',
         k.end_date, 14
    from public.contracts k
    left join public.clients cl on cl.id = k.client_id
   where k.status = 'active' and k.end_date is not null and not k.is_infinite
  union all
  -- The edge function's collapse, carried over verbatim in intent: the same
  -- item is routinely entered several times with different notice windows
  -- (one review stored four times at 30/15/7/1 days), and every row whose
  -- window is open matched, so the digest listed it once, then twice, then
  -- three times as the date closed in. One entry per title+date, taking the
  -- WIDEST window so it still starts alerting on the earliest of them.
  select d.company_id, null::uuid, 'important_date',
         (array_agg(d.id order by d.id))[1],
         (array_agg(d.title order by d.id))[1], d.due_date,
         max(coalesce(d.advance_notice_days, 7))
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
       (i.due_date - current_date) as days_remaining
  from items i;

comment on view public.compliance_upcoming is
  'THE source of truth for what is due or overdue. Before 0291 this question was computed five times — here, in send-compliance-alerts, in Licences.tsx, in Dashboard.tsx and in ai-chat — and the implementations disagreed about whether an employee on leave counts. Membership is lifecycle_state in (active, on_leave): status is derived from lifecycle_state by trigger, so filtering on status reads a copy, and an employee on leave is exactly the person whose lapsing licence nobody is watching. notice_days is the item own window, carried over from the edge function. days_remaining is negative when overdue and is deliberately not filtered here. See 0291.';

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_kinds int; v_rows int; v_emp uuid; v_co uuid; v_before int; v_after int;
    begin
      -- 1. THE MEMBERSHIP RULE IS ACTUALLY APPLIED.
      --
      -- Data-independent by construction. An earlier version of this block
      -- asserted that the weapon-licence arm returned rows, and failed: zero
      -- employees on dev carry a weapon licence expiry, so the arm was correct
      -- and the fixture was wrong. The probe now creates the condition it
      -- tests, inside the subtransaction this block rolls back.
      select e.id, e.company_id into v_emp, v_co
        from public.employees e where e.lifecycle_state = 'active' limit 1;
      if v_emp is null then
        raise exception '0291 cannot self-test: no active employee exists';
      end if;

      update public.employees
         set weapon_licence_expiry = current_date + 10 where id = v_emp;

      select count(*) into v_before from public.compliance_upcoming
       where ref_id = v_emp and kind = 'weapon_licence';
      if v_before <> 1 then
        raise exception '0291 FAILED: an ACTIVE employee with a licence expiry is not listed';
      end if;

      update public.employees set lifecycle_state = 'on_leave' where id = v_emp;
      select count(*) into v_after from public.compliance_upcoming
       where ref_id = v_emp and kind = 'weapon_licence';
      if v_after <> 1 then
        raise exception '0291 FAILED: an ON LEAVE employee is dropped — the membership rule did not change';
      end if;

      update public.employees set lifecycle_state = 'left' where id = v_emp;
      select count(*) into v_after from public.compliance_upcoming
       where ref_id = v_emp and kind = 'weapon_licence';
      if v_after <> 0 then
        raise exception '0291 FAILED: a separated employee is still listed';
      end if;

      -- 2. Every new arm resolves. A UNION arm lost to an edit, or a column
      -- renamed underneath one, shows up here rather than as silent absence.
      update public.employees
         set lifecycle_state = 'active',
             weapon_licence_expiry        = current_date + 1,
             guard_service_licence_expiry = current_date + 2,
             medical_fitness_expiry       = current_date + 3,
             probation_end_date           = current_date + 4,
             cnic_expiry                  = current_date + 5,
             weapons_cert_expiry          = current_date + 6,
             refresher_due_date           = current_date + 7
       where id = v_emp;
      select count(distinct kind) into v_kinds from public.compliance_upcoming where ref_id = v_emp;
      if v_kinds <> 7 then
        raise exception '0291 FAILED: % of the 7 employee arms returned a row', v_kinds;
      end if;

      -- 3. days_remaining is signed, and overdue is NOT filtered out.
      update public.employees
         set weapon_licence_expiry = current_date - 5 where id = v_emp;
      if not exists (select 1 from public.compliance_upcoming
                      where ref_id = v_emp and kind = 'weapon_licence' and days_remaining = -5) then
        raise exception '0291 FAILED: an expired licence is missing, or days_remaining is not signed';
      end if;

      -- 4. important_dates collapse to one row per title+date, widest window.
      insert into public.important_dates (company_id, title, due_date, category, priority, advance_notice_days)
      values (v_co, 'Probe Review', current_date + 20, 'Client', 'medium', 30),
             (v_co, 'probe review ', current_date + 20, 'Client', 'medium', 7);
      select count(*), max(notice_days) into v_rows, v_after
        from public.compliance_upcoming
       where company_id = v_co and kind = 'important_date' and due_date = current_date + 20;
      if v_rows <> 1 then
        raise exception '0291 FAILED: duplicate important_dates were not collapsed (% rows)', v_rows;
      end if;
      if v_after <> 30 then
        raise exception '0291 FAILED: the collapse did not take the widest notice window (got %)', v_after;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0291 verification failed: %', v_outcome;
  end if;
end
$verify$;
