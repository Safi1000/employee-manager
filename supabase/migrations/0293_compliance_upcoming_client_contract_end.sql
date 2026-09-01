-- 0293 — the fifteenth arm: a client contract end with nothing active behind it.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- THE SIXTH IMPLEMENTATION
--
-- 0291 found five implementations of "what is expiring". Repointing the
-- Dashboard turned up a sixth, and this one was not redundant: its compliance
-- alerts panel reads clients.contract_end, a DIFFERENT COLUMN from the
-- contracts.end_date the view reads.
--
-- Measured on production before deciding:
--
--   clients with contract_end                        6
--   active contracts with end_date                  10
--   the two disagreeing where both exist             0
--   clients with contract_end, no active contract    2
--
-- So contracts.end_date is authoritative — it is the row that represents an
-- actual contract — and the client field never contradicts it. Repointing the
-- panel on that basis alone would have been correct about the authority and
-- wrong about the outcome: the two clients with no active contract would have
-- silently stopped appearing anywhere.
--
-- WHAT THE TWO ACTUALLY ARE, WHICH IS NOT WHAT THE COUNT SUGGESTED
--
-- "No active contract row" turned out not to mean "no contract". Both have
-- contract rows; they are excluded by status, not by absence:
--
--   Palm Grove Resorts   (CLI-0005)  CON-0005 expired 2026-07-31
--                                    — and FOUR GUARDS ARE STILL DEPLOYED THERE
--   Nova Textiles Mills  (CLI-0008)  CON-0007 terminated, CON-0008 still draft
--
-- Both are on SANDBOX TESTING ORG, not the live company, so nothing here is a
-- live customer exposure today. The shape is the point: a client whose
-- contract has lapsed while the client record still carries the end date, and
-- in one case guards on site under it. Nothing in the system surfaced either.
--
-- THE ARM IS AN ANOMALY, NOT AN EXPIRY
--
-- Labelled distinctly on purpose. A row that reads like a contract expiry
-- would invite someone to renew a contract that does not exist. It says what
-- it is: an end date with no active contract row behind it.
--
-- It cannot double-count. The not-exists is the exact complement of the
-- contract_end arm's filter, so a client with an active contract produces a
-- contract_end row and never a client_contract_end row. Asserted below over
-- all data, not against the two rows that happen to exist today.
--
-- ADD ROWS, DO NOT HIDE THEM — the same direction as 0291's membership fix.

-- ---------------------------------------------------------------------------
-- Baseline before the change. The new arm must ADD rows and alter none.
-- ---------------------------------------------------------------------------

create temp table _cu_before on commit drop as
  select company_id, branch_id, kind, ref_id, label, due_date, notice_days,
         days_remaining, sublabel
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
  -- 0293. NOT a contract expiry — an anomaly, and labelled so it cannot be
  -- mistaken for one. clients.contract_end is a field on the client record
  -- that survives when no active contract row does. Where both exist they
  -- agree (0 disagreements on production), so contracts.end_date remains
  -- authoritative and this arm deliberately does not fire alongside it.
  --
  -- What is left is the case worth a human: a client carrying an end date
  -- with nothing active behind it. Either the contract was never created, or
  -- one existed and has lapsed and the date is now stale. Both are worth
  -- someone looking at, and until this arm neither appeared anywhere.
  select c.company_id, c.branch_id, 'client_contract_end', c.id,
         c.name || ' — client contract end, no active contract',
         c.contract_end, 14,
         coalesce(c.client_code || ' · ', '') || 'no active contract row'
    from public.clients c
   where c.contract_end is not null
     and not exists (select 1 from public.contracts k
                      where k.client_id = c.id
                        and k.status = 'active'
                        and k.end_date is not null)
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
  'THE source of truth for what is due or overdue. Before 0291 this question was computed five times — here, in send-compliance-alerts, in Licences.tsx, in Dashboard.tsx and in ai-chat — and the implementations disagreed about whether an employee on leave counts. Membership is lifecycle_state in (active, on_leave): status is derived from lifecycle_state by trigger, so filtering on status reads a copy, and an employee on leave is exactly the person whose lapsing licence nobody is watching. notice_days is the item own window, carried over from the edge function. days_remaining is negative when overdue and is deliberately not filtered here. sublabel is the row second line (0292). The client_contract_end kind is an ANOMALY, not an expiry: a client carrying contract_end with no active contract row behind it (0293). See 0291, 0292 and 0293.';

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_diff int; v_before int; v_after int; v_new int; v_null int;
      v_co uuid; v_cli uuid; v_kon uuid;
    begin
      -- 1. NOTHING THAT WAS THERE MOVED. Every pre-existing row survives with
      -- every column identical. An additive arm that quietly changed another
      -- arm's output would satisfy a row count and fail this.
      select count(*) into v_before from _cu_before;
      select count(*) into v_after  from public.compliance_upcoming;

      select count(*) into v_diff from (
        select company_id, branch_id, kind, ref_id, label, due_date, notice_days,
               days_remaining, sublabel from _cu_before
        except all
        select company_id, branch_id, kind, ref_id, label, due_date, notice_days,
               days_remaining, sublabel from public.compliance_upcoming
      ) d;
      if v_diff <> 0 then
        raise exception '0293 FAILED: % pre-existing row(s) changed or vanished', v_diff;
      end if;

      -- 2. THE ONLY NEW ROWS ARE THE NEW KIND.
      select count(*) into v_diff from (
        select company_id, branch_id, kind, ref_id, label, due_date, notice_days,
               days_remaining, sublabel from public.compliance_upcoming
        except all
        select company_id, branch_id, kind, ref_id, label, due_date, notice_days,
               days_remaining, sublabel from _cu_before
      ) d where d.kind <> 'client_contract_end';
      if v_diff <> 0 then
        raise exception '0293 FAILED: % new row(s) that are not client_contract_end', v_diff;
      end if;

      select count(*) into v_new from public.compliance_upcoming
       where kind = 'client_contract_end';
      if v_after <> v_before + v_new then
        raise exception '0293 FAILED: % before, % after, % new — the arithmetic does not close',
          v_before, v_after, v_new;
      end if;

      -- 3. THE SUBLABEL IS STILL POPULATED ON EVERY ROW (0292's guarantee).
      select count(*) into v_null from public.compliance_upcoming
       where coalesce(sublabel, '') = '';
      if v_null > 0 then
        raise exception '0293 FAILED: % row(s) have an empty sublabel', v_null;
      end if;

      -- 4. THE ARM AND THE CONTRACT ARM ARE MUTUALLY EXCLUSIVE, as a property
      -- over all data. If the not-exists ever stops being the exact complement
      -- of the contract arm's filter, a client double-counts and this catches
      -- it without anyone having to notice.
      select count(*) into v_diff
        from public.compliance_upcoming a
        join public.contracts k on k.id = a.ref_id and a.kind = 'contract_end'
        join public.compliance_upcoming b
          on b.kind = 'client_contract_end' and b.ref_id = k.client_id;
      if v_diff <> 0 then
        raise exception '0293 FAILED: % client(s) appear as BOTH a contract end and a client anomaly', v_diff;
      end if;

      -- 5. THE ARM ACTUALLY FIRES, AND STOPS FIRING. Data-independent: the
      -- probe creates a client with an end date and no contract, then gives it
      -- an active contract and requires the anomaly to disappear and a real
      -- contract_end row to take its place. Asserting on the two rows that
      -- exist on this database today would prove nothing about the rule.
      select id into v_co from public.companies order by created_at limit 1;

      insert into public.clients (company_id, name, client_code, contract_end)
      values (v_co, 'ZZ 0293 PROBE', 'ZZ-0293', current_date + 5)
      returning id into v_cli;

      if not exists (select 1 from public.compliance_upcoming
                      where kind = 'client_contract_end' and ref_id = v_cli) then
        raise exception '0293 FAILED: a client with contract_end and no contract did not produce the anomaly';
      end if;

      -- contract_type is plain text here and status is the enum, not the other
      -- way round. is_infinite is set explicitly: the contract_end arm excludes
      -- infinite contracts, and a NULL there would silently fail the assertion
      -- below for a reason that has nothing to do with this arm.
      insert into public.contracts (company_id, client_id, contract_code, contract_type,
                                    start_date, end_date, status, is_infinite)
      values (v_co, v_cli, 'ZZ-CON-0293', 'guard_deployment',
              current_date - 30, current_date + 5, 'active'::contract_status, false)
      returning id into v_kon;

      if exists (select 1 from public.compliance_upcoming
                  where kind = 'client_contract_end' and ref_id = v_cli) then
        raise exception '0293 FAILED: the anomaly persisted after an active contract was created — the arms overlap';
      end if;
      if not exists (select 1 from public.compliance_upcoming
                      where kind = 'contract_end' and ref_id = v_kon) then
        raise exception '0293 FAILED: the active contract did not appear as a contract_end row';
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0293 verification failed: %', v_outcome;
  end if;
end
$verify$;
