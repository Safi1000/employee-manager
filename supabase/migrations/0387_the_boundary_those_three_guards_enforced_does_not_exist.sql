-- 0387 — the four company-wide tables are recorded as company-wide, and the
--         three guards that assumed otherwise come back out.
--
-- ===========================================================================
-- THE DECISION
-- ===========================================================================
--
-- Asked, and answered by Shayan: alerts, approval_requests, bonus_pools and
-- bonus_pool_allocations are COMPANY-WIDE BY DESIGN. They carry company
-- scoping and no branch policy because that is the intent, not because
-- somebody forgot.
--
-- 0378 read the same fact and drew the opposite conclusion. It called the
-- absence of a branch policy a hole, guarded the three RPCs that write those
-- tables, and wrote in its own header that the guard closed "the convenient
-- path — not the boundary". It was right that a function guard on top of an
-- unguarded table makes the detector go green and leaves the hole. It was
-- wrong that there was a hole.
--
-- So the guards enforce a boundary that does not exist, and they come out.
-- Leaving them because they are already built is how a wrong assumption
-- becomes the system's behaviour.
--
-- ===========================================================================
-- WHAT EACH REVERT GIVES BACK
-- ===========================================================================
--
-- raise_alert — THE ONE THAT COST SOMETHING. 0378's guard meant a branched
-- user could no longer run sweep_ammo_discrepancy_alerts() at all: the sweep
-- raises one alert per branch across the company and hit the guard on the
-- first foreign branch, rolling the whole thing back. 0378's header named that
-- as a deliberate refusal-over-partial-result trade. The trade was justified by
-- a boundary Shayan has now said does not exist, so the capability comes back.
--
-- request_approval — a regional user filing a request that names another
-- region is the approval queue working as designed. No behaviour was lost while
-- the guard was in place, because nothing in the database calls it.
--
-- generate_bonus_pool — reverted too, AND FLAGGED. Of the four tables this is
-- the only one where a row determines a PAYMENT: bonus_pool_allocations carries
-- share_amount per employee. So "company-wide" here means somebody with
-- performance.approve can generate any region's pool, head office included.
-- That follows from the decision as stated, and performance.approve remains the
-- gate — but it is a materially different sentence from "anyone can file an
-- alert about another region", and it is the one to say out loud rather than
-- bury in a revert. One word from Shayan puts this guard back on its own.

do $$
declare
  r        record;
  v_def    text;
  v_hits   int;
  v_done   int := 0;
  a_stamp  text :=
    '  -- 0378: branch guard [claimed]. p_branch_id names the region this row lands' || chr(10) ||
    '  -- in and was accepted as given. assert_branch_in_company() above it checks' || chr(10) ||
    '  -- the COMPANY, which is the tenant boundary and not the branch one.' || chr(10) ||
    '  perform public.assert_branch_writable(p_branch_id);' || chr(10);
begin
  for r in select unnest(array['raise_alert', 'request_approval']) as fn
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;
    if v_def is null then raise exception '0387 REFUSED: %() does not exist.', r.fn; end if;

    v_hits := (length(v_def) - length(replace(v_def, a_stamp, ''))) / length(a_stamp);
    if v_hits <> 1 then
      raise exception
        '0387 REFUSED: 0378''s inserted block appears % time(s) in %(), expected 1. Removing a block that is not exactly the one 0378 wrote would be guessing at what else has changed.',
        v_hits, r.fn;
    end if;

    execute replace(v_def, a_stamp, '');
    v_done := v_done + 1;
  end loop;
  if v_done <> 2 then raise exception '0387 FAILED: reverted %, expected 2.', v_done; end if;
end $$;

do $$
declare
  v_def   text;
  v_hits  int;
  a_bonus text :=
    '  -- 0378: branch guard [resolved]. Guards v_scope_branch and NOT p_branch_id.' || chr(10) ||
    '  -- The head-office arm writes head_office_region() while p_branch_id is NULL,' || chr(10) ||
    '  -- and a guard on the parameter would return early on that NULL and let a' || chr(10) ||
    '  -- regional approver generate the head-office pool. What is asserted is the' || chr(10) ||
    '  -- branch this function actually writes into.' || chr(10) ||
    '  perform public.assert_branch_writable(v_scope_branch);' || chr(10) || chr(10);
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'generate_bonus_pool';
  if v_def is null then raise exception '0387 REFUSED: generate_bonus_pool() does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_bonus, ''))) / length(a_bonus);
  if v_hits <> 1 then
    raise exception '0387 REFUSED: 0378''s block appears % time(s) in generate_bonus_pool(), expected 1.', v_hits;
  end if;

  execute replace(v_def, a_bonus, '');
end $$;

-- ---------------------------------------------------------------------------
-- THE RECORD, where the next person meets it: on the tables themselves.
--
-- A table with no branch policy looks identical whether that is a decision or
-- an omission. These four now say which, so the next reader — or the next
-- detector — does not have to infer it from silence, as 0378 did.
-- ---------------------------------------------------------------------------
comment on table public.alerts is
  '0387: COMPANY-WIDE BY DESIGN. Company scoping only, and deliberately NO branch policy — decided by Shayan, 2026-09-04. The alert feed is a company-wide operational record: a regional user raising or reading an alert that names another region is the feature, not an escalation. Do not add branch_scope here. sweep_ammo_discrepancy_alerts() depends on it, raising one alert per branch across the company in a single call.';

comment on table public.approval_requests is
  '0387: COMPANY-WIDE BY DESIGN. Company scoping only, and deliberately NO branch policy — decided by Shayan, 2026-09-04. The approval queue is company-wide: a request naming another region is the queue working as intended. Do not add branch_scope here.';

comment on table public.bonus_pools is
  '0387: COMPANY-WIDE BY DESIGN. Company scoping only, and deliberately NO branch policy — decided by Shayan, 2026-09-04; the gate is perm_write_* on performance.approve and nothing narrower. NOTE, because it is the sharpest case of that decision: a holder of performance.approve can generate ANY region''s pool including head office, and a pool determines what people are paid (see bonus_pool_allocations.share_amount). That is the decision as stated, not an oversight.';

comment on table public.bonus_pool_allocations is
  '0387: COMPANY-WIDE BY DESIGN. Company scoping only, and deliberately NO branch policy — decided by Shayan, 2026-09-04. Rows here carry share_amount, the figure an employee is actually paid from a bonus pool, and are rebuilt wholesale by generate_bonus_pool(). Do not add branch_scope here.';

-- ---------------------------------------------------------------------------
-- THE DETECTOR SAYS WHICH SHAPES ARE DECIDED.
--
-- Otherwise branch_guard_gaps() reads 12 forever and somebody eventually
-- "finishes" it — putting back exactly the guards this migration removes.
-- ---------------------------------------------------------------------------
comment on function public.branch_guard_gaps() is
  '0367/0369/0377/0387: SECURITY DEFINER functions that cross the branch boundary, in three shapes. `writes` — writes a table carrying branch_scope; THIS IS THE MECHANICAL ONE and the only shape ledger_checks asserts, because a branch-scoped table is branch-scoped by definition. `stamps` — accepts a uuid naming a branch; ADVISORY, and requires a per-function judgement about the table being written: the three current members (generate_bonus_pool, raise_alert, request_approval) write alerts, approval_requests and bonus_pools, which are COMPANY-WIDE BY DESIGN (Shayan, 2026-09-04), so they are DECIDED and not open. 0378 guarded them, 0387 removed those guards. `reads` — a stable reader taking a branch; ALSO DECIDED, same decision: eight return a scalar aggregate about another region and two of those feed regional_scorecard and cash_entitlements, whose purpose is regions side by side; the ninth, employee_in_branch, is the branch_scope predicate''s own helper and must NEVER be guarded, because it is called with current_branch_id() and a guard would make it refuse the question it exists to answer. A NEW stamp or read is a new judgement — do not assume it inherits this one. THE SET-PROCESSOR RULE, before closing a `writes` row by converting it to SECURITY INVOKER: converting a SET operation to invoker turns an unauthorised act into a SILENTLY SMALLER RESULT, not a refusal (see 0377, 0379).';

-- ---------------------------------------------------------------------------
-- ledger_checks narrows to `writes`, by surgery.
--
-- Not a carve-out to keep it green: `stamps` stopped being a mechanical
-- property the moment the tables behind it were decided. A future stamper that
-- writes a genuinely branch-scoped table is caught by the `writes` arm anyway —
-- arm A tests the table, not the parameter — so nothing mechanical is lost.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def  text;
  v_hits int;
  v_co   uuid;
  v_n    int;
  a_pred text := 'from public.branch_guard_gaps() b where b.shape in (''writes'', ''stamps'')';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks';
  v_hits := (length(v_def) - length(replace(v_def, a_pred, ''))) / length(a_pred);
  if v_hits <> 1 then
    raise exception '0387 REFUSED: 0386''s arm predicate appears % time(s), expected 1.', v_hits;
  end if;

  execute replace(v_def, a_pred,
    'from public.branch_guard_gaps() b where b.shape = ''writes''');

  -- The count must NOT change: this narrows a predicate inside one arm, it
  -- does not add or remove an arm. If the canary moves, the edit hit something
  -- other than what it was aimed at.
  select id into v_co from public.companies order by created_at limit 1;
  if exists (select 1 from public.ledger_checks(v_co) c
              where c.check_name = 'checks_evaluated' and not c.passed) then
    raise exception '0387 FAILED: the canary disagrees with itself; the arm count changed and it should not have.';
  end if;
  if exists (select 1 from public.ledger_checks(v_co) c
              where c.check_name = 'no_definer_function_crosses_a_branch' and not c.passed) then
    raise exception '0387 FAILED: the branch arm is red after narrowing to writes.';
  end if;

  select count(*) into v_n from public.branch_guard_gaps() where shape = 'writes';
  if v_n <> 0 then raise exception '0387 FAILED: % write row(s) appeared.', v_n; end if;
end $$;

-- ---------------------------------------------------------------------------
-- PROVE THE REVERT.
--
-- Not "the guard is gone" — that is what a botched edit looks like too. The
-- three must be gone from the BODIES, reported again by the detector as
-- `stamps` (a detector that stopped seeing them would hide the next real one),
-- and the four tables must actually carry their comments, because a decision
-- recorded nowhere is a decision the next reader will re-litigate.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_c int;
begin
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('generate_bonus_pool', 'raise_alert', 'request_approval')
     and public.executable_source(pg_get_functiondef(p.oid)) ~ 'assert_branch_writable';
  if v_n <> 0 then
    raise exception '0387 FAILED: % of the three still assert a branch.', v_n;
  end if;

  select count(*) into v_n from public.branch_guard_gaps()
   where shape = 'stamps'
     and function_name in ('generate_bonus_pool', 'raise_alert', 'request_approval');
  if v_n <> 3 then
    raise exception
      '0387 FAILED: the detector reports % of the three as stamps, expected 3. It must keep seeing them — they are DECIDED, not invisible.', v_n;
  end if;

  select count(*) into v_c from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('alerts', 'approval_requests', 'bonus_pools', 'bonus_pool_allocations')
     and obj_description(c.oid, 'pg_class') like '%COMPANY-WIDE BY DESIGN%';
  if v_c <> 4 then
    raise exception '0387 FAILED: % of the four tables record the decision, expected 4.', v_c;
  end if;

  -- And the capability 0378 took away is back: a guard in raise_alert would
  -- abort this sweep for a branched caller on the first foreign branch.
  if public.executable_source(pg_get_functiondef(
       (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'raise_alert'))) ~ 'assert_branch_writable' then
    raise exception '0387 FAILED: raise_alert still guards, so the company-wide ammo sweep is still refused to a branched user.';
  end if;

  raise notice '0387: three guards removed, three still reported as decided stamps, four tables carry the decision.';
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0387 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
