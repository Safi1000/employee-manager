-- 0330 — the finance-verification lock honours a maintenance session.
--
-- THIS IS A POLICY CHANGE TO A FINANCIAL CONTROL. Say so plainly, because the
-- next reader deserves to know it was one.
--
-- Before this file, `enforce_finance_verify_lock` on payroll_run_phases was
-- absolute: a row with finance_verified_at set could not be deleted, and the
-- UPDATE that would clear the stamp was refused too. No gate lifted it — not a
-- maintenance session, not a Super Super Admin, nothing. After this file, a
-- maintenance session lifts it.
--
-- WHY, AND THE ARGUMENT IS CONSISTENCY WITH THE STRONGER CONTROL, NOT WITH THE
-- COUNT. Five delete-blocking guards already yield to is_maintenance_session():
--
--   enforce_journal_immutable          the general ledger itself
--   enforce_period_lock                closed accounting periods
--   enforce_period_lock_journal_lines  the lines inside them
--   enforce_attendance_month_lock      OPS-verified attendance months
--   enforce_confirmed_month_end_lock   confirmed shifts after month end
--
-- The first of those protects posted journal entries. A payroll-phase
-- verification lock being strictly harder to lift than the general ledger is an
-- inconsistency, not a stronger control. is_maintenance_session() requires
-- app.ledger_maintenance = 'on' AND a session_user that is superuser or
-- bypassrls — it is role-gated, not a flag anyone can set through the app — and
-- every row it touches still passes through log_audit_change. That is already
-- the accepted standard for removing posted journal entries. Finance
-- verification does not need a higher one.
--
-- WHAT SURFACED IT IS NOT WHAT MOTIVATED IT, and a future reader should be able
-- to tell those apart. The rehearsal for deleting SANDBOX TESTING ORG stopped
-- here: 8 of its 10 payroll_run_phases rows are finance-verified, and the
-- cascade could not remove them. That is how the inconsistency was found. It is
-- not the reason for fixing it — the reason is the paragraph above, and this
-- change would be correct with no company being deleted at all. Deleting
-- SANDBOX is a separate act needing its own authorisation; the cron loops that
-- must skip archived companies are 0331, deliberately a separate file with a
-- separate subject and a separate review.
--
-- RESTATEMENT, NOT SURGERY, AND WHY THAT IS ALLOWED HERE. CLAUDE.md: a function
-- edited by more than one migration has no canonical file. This one has exactly
-- one author — 0194 — whose full text is in the repo, so the rule's second arm
-- applies: it may be restated provided the migration first asserts that the
-- body it is replacing is a digest it recognises, and refuses anything else.
--
-- Two are known, both measured today:
--
--   8d6f64c8a70492fbaf1952aaf12e2bea   production   625 bytes
--   b67e1c042a0e486bb192214dbd157284   dev          725 bytes
--
-- They differ only in line endings and in whether 0194's one comment line
-- survived. The logic is identical on both. Anything else means a third edit
-- nobody recorded, which is precisely the case where restating destroys
-- something, so this file stops instead.

-- ---------------------------------------------------------------------------
-- Precondition.
-- ---------------------------------------------------------------------------
do $precondition$
declare
  v_digest text;
  v_def    text;
begin
  select md5(pg_get_functiondef(p.oid)), pg_get_functiondef(p.oid)
    into v_digest, v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enforce_finance_verify_lock';

  if v_digest is null then
    raise exception
      '0330 FAILED: public.enforce_finance_verify_lock does not exist. This migration replaces a body it recognises; it does not create one from nothing.';
  end if;

  if position('is_maintenance_session' in v_def) > 0 then
    raise notice '0330: the gate is already present — re-stating the same body, digest %', v_digest;
  elsif v_digest not in ('8d6f64c8a70492fbaf1952aaf12e2bea',
                         'b67e1c042a0e486bb192214dbd157284') then
    raise exception
      '0330 FAILED: enforce_finance_verify_lock has digest %, which is neither the known production body (8d6f64c8...) nor the known dev body (b67e1c04...), and does not already carry the gate. Something edited this function that nothing in the repo describes. Restating it now would discard that edit silently. Find out what it was first.',
      v_digest;
  else
    raise notice '0330: replacing enforce_finance_verify_lock, prior digest %', v_digest;
  end if;
end
$precondition$;

-- ---------------------------------------------------------------------------
-- The body. 0194's logic unchanged, with the gate added at the top.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_finance_verify_lock() returns trigger
language plpgsql as $fn$
begin
  -- 0330. A maintenance session lifts this lock, exactly as it lifts
  -- enforce_journal_immutable and enforce_period_lock. The gate is role-gated
  -- (app.ledger_maintenance = 'on' AND a superuser/bypassrls session_user) and
  -- every row it touches is still audited.
  if public.is_maintenance_session() then
    return coalesce(NEW, OLD);
  end if;

  if TG_OP = 'DELETE' then
    if OLD.finance_verified_at is not null then
      raise exception 'This scope is Finance Verified and locked — it cannot be reversed.';
    end if;
    return OLD;
  end if;
  -- UPDATE: a finance-verified row is frozen (phase can't move, stamp can't clear).
  if OLD.finance_verified_at is not null
     and (NEW.finance_verified_at is distinct from OLD.finance_verified_at
          or NEW.phase is distinct from OLD.phase) then
    raise exception 'This scope is Finance Verified and locked — it cannot be reversed.';
  end if;
  return NEW;
end $fn$;

-- ---------------------------------------------------------------------------
-- PROOF
--
-- Two parts, and the migration reports which ran.
--
-- STATIC always runs: the gate is present exactly once, both refusal branches
-- survived the restatement, and the trigger is still attached to
-- payroll_run_phases for UPDATE and DELETE. A restatement that quietly dropped
-- half the lock would pass a "the function exists" test and fail this one.
--
-- BEHAVIOURAL runs wherever there is a row to build a fixture from. It plants a
-- finance-verified row, requires the lock to REFUSE with its own message with
-- no maintenance session, requires the same two operations to SUCCEED with one,
-- requires the lock to refuse again once maintenance is off, and unwinds
-- through a deliberate raise (0321).
--
-- Asserting on the MESSAGE rather than on the fact that something raised is the
-- rule from CLAUDE.md. Three tests once passed against the wrong trigger for
-- want of it, and the rehearsal that led to this file produced a fourth: a
-- probe aimed at 0329's archive trigger was answered by an attendance lock, and
-- read as a pass until the message was checked.
--
-- On an empty database the behavioural part is skipped with a loud notice
-- rather than refused, so a numeric-order replay still works. The static part
-- runs either way, so the file is never silent about having run.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_def     text;
  v_hits    int;
  v_phase   text;
  v_company uuid;
  v_id      uuid;
  v_del_no  text := '(not run)';
  v_upd_no  text := '(not run)';
  v_del_yes text := '(not run)';
  v_upd_yes text := '(not run)';
  v_again   text := '(not run)';
  v_outcome text;
  v_mode    text;
begin
  ---------------------------------------------------------------------------
  -- STATIC
  ---------------------------------------------------------------------------
  v_def := pg_get_functiondef('public.enforce_finance_verify_lock()'::regprocedure);

  v_hits := (length(v_def) - length(replace(v_def, 'is_maintenance_session', '')))
            / length('is_maintenance_session');
  if v_hits <> 1 then
    raise exception
      '0330 FAILED: the maintenance gate appears % times in enforce_finance_verify_lock, expected exactly 1', v_hits;
  end if;

  v_hits := (length(v_def) - length(replace(v_def, 'Finance Verified and locked', '')))
            / length('Finance Verified and locked');
  if v_hits <> 2 then
    raise exception
      '0330 FAILED: the refusal message appears % times, expected 2 (DELETE and UPDATE) — the restatement lost a branch of the lock', v_hits;
  end if;

  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.payroll_run_phases'::regclass
       and not t.tgisinternal
       and t.tgfoid = 'public.enforce_finance_verify_lock()'::regprocedure
       and (t.tgtype & 8) > 0 and (t.tgtype & 16) > 0)
  then
    raise exception
      '0330 FAILED: no trigger on payroll_run_phases runs enforce_finance_verify_lock for both UPDATE and DELETE';
  end if;

  ---------------------------------------------------------------------------
  -- BEHAVIOURAL
  ---------------------------------------------------------------------------
  -- The fixture is built against a company that is NOT archived, and with a
  -- null client. Every payroll_run_phases row on both databases belongs to
  -- SANDBOX TESTING ORG, which is archived on production — inserting a fixture
  -- there would be refused by 0329's trigger and this proof would report a
  -- failure of the wrong thing. `phase` and `category` are copied off an
  -- existing row so payroll_run_phases_phase_check is satisfied by
  -- construction rather than by a guessed literal, and the scope is given as a
  -- category rather than a client because prp_scope_ck requires exactly one of
  -- the two — a null client and a null category violates it.
  select p.phase into v_phase
    from public.payroll_run_phases p order by p.moved_at limit 1;
  select c.id into v_company
    from public.companies c where c.archived_at is null order by c.name limit 1;

  if v_phase is null or v_company is null then
    v_mode := format('STATIC ONLY — %s',
      case when v_phase is null then 'payroll_run_phases is empty, no phase value to copy'
           else 'every company is archived, nowhere to plant a fixture' end);
  else
    v_mode := 'STATIC AND BEHAVIOURAL';
    begin
      -- Plant a finance-verified fixture. Stamping a row that is not yet
      -- verified is permitted by the lock in both the old body and the new.
      insert into public.payroll_run_phases
        (company_id, client_id, period_month, phase, moved_at, category, finance_verified_at)
      values
        (v_company, null, date '1900-01-01', v_phase, now(), '0330 proof fixture', now())
      returning id into v_id;

      -- (a) NO maintenance session: both operations must refuse, by MESSAGE.
      perform set_config('app.ledger_maintenance', 'off', true);

      begin
        delete from public.payroll_run_phases where id = v_id;
        v_del_no := 'WENT THROUGH';
      exception when others then
        v_del_no := sqlerrm;
      end;
      if v_del_no not like '%Finance Verified and locked%' then
        raise exception
          '0330 FAILED: with no maintenance session the DELETE was not refused by this lock. Got: %', v_del_no;
      end if;

      begin
        update public.payroll_run_phases set finance_verified_at = null where id = v_id;
        v_upd_no := 'WENT THROUGH';
      exception when others then
        v_upd_no := sqlerrm;
      end;
      if v_upd_no not like '%Finance Verified and locked%' then
        raise exception
          '0330 FAILED: with no maintenance session the un-verify UPDATE was not refused by this lock. Got: %', v_upd_no;
      end if;

      -- (b) WITH a maintenance session: both must now succeed. That is the
      --     change. If this session cannot open the gate, say the change is
      --     unproven rather than report a false pass.
      perform set_config('app.ledger_maintenance', 'on', true);
      if not public.is_maintenance_session() then
        raise exception
          '0330 FAILED: is_maintenance_session() is false even with app.ledger_maintenance = on — this session (session_user %) cannot open the gate, so the change is unproven, not proven.',
          session_user;
      end if;

      update public.payroll_run_phases set finance_verified_at = null where id = v_id;
      v_upd_yes := 'succeeded';
      update public.payroll_run_phases set finance_verified_at = now() where id = v_id;
      delete from public.payroll_run_phases where id = v_id;
      if not found then
        raise exception '0330 FAILED: the DELETE under maintenance removed no row';
      end if;
      v_del_yes := 'succeeded';

      -- (c) and the lock is back the moment maintenance is off again. This is a
      --     gate, not a removal.
      insert into public.payroll_run_phases
        (company_id, client_id, period_month, phase, moved_at, category, finance_verified_at)
      values
        (v_company, null, date '1900-01-02', v_phase, now(), '0330 proof fixture', now())
      returning id into v_id;

      perform set_config('app.ledger_maintenance', 'off', true);
      begin
        delete from public.payroll_run_phases where id = v_id;
        v_again := 'WENT THROUGH';
      exception when others then
        v_again := sqlerrm;
      end;
      if v_again not like '%Finance Verified and locked%' then
        raise exception
          '0330 FAILED: with maintenance off again the lock did not refuse. Got: %', v_again;
      end if;

      raise exception 'PROBE_ROLLBACK';
    exception when others then
      v_outcome := sqlerrm;
    end;

    if v_outcome <> 'PROBE_ROLLBACK' then
      raise exception '0330 FAILED (behavioural probe): %', v_outcome;
    end if;

    -- and the probe unwound: no fixture survived it.
    if exists (select 1 from public.payroll_run_phases
                where period_month in (date '1900-01-01', date '1900-01-02')) then
      raise exception '0330 FAILED: the probe did not unwind — a fixture row is still present';
    end if;
  end if;

  raise notice
    '0330 OK (%): the gate appears once, both refusal branches survived, the trigger is attached for UPDATE and DELETE. Refused without maintenance [delete: %] [un-verify: %]; permitted with it [un-verify: %] [delete: %]; refused again with maintenance off [%].',
    v_mode, left(v_del_no, 60), left(v_upd_no, 60), v_upd_yes, v_del_yes, left(v_again, 60);
end
$proof$;

comment on function public.enforce_finance_verify_lock() is
  'Refuses deletion of a finance-verified payroll phase, and refuses the update that would clear the stamp. 0330: yields to a maintenance session, as enforce_journal_immutable and enforce_period_lock already do.';
