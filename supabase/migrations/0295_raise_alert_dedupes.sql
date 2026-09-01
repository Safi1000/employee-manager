-- 0295 — raise_alert stops producing a new row for a condition that is still
-- the same condition.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- THE PROBLEM, WHICH DOES NOT EXIST YET AND WILL THE DAY ANYTHING IS WIRED
--
-- The alerts table has never held a row, on dev or on production, because
-- nothing has ever called raise_alert. That is about to change: 0296 wires
-- check_deploy_guard and check_disbursement, and a scheduled ledger_checks()
-- follows with the ledger deployment.
--
-- The moment a check runs on a schedule, an unchanged condition produces one
-- alert per run. A guard who fails vetting and stays on an armed post generates
-- one row a day forever. Within a fortnight the feed is a scroll of the same
-- sentence and the reader stops reading — which is the exact failure this whole
-- stream has been about, arriving from the opposite direction. A control nobody
-- reads is the same as a control nobody calls.
--
-- Fixing it before the first alert exists is deliberate. Deduplicating a table
-- that already has ten thousand rows in it is a data migration and an argument;
-- doing it now is an index.
--
-- THE KEY, AND THE PART OF IT THAT NEEDS POSTGRES 15
--
--   (company_id, category, ref_table, ref_id)  among  state = 'open'
--
-- ref_table and ref_id are nullable and legitimately so — check_disbursement
-- raises an alert about an amount, not about a row. Under default UNIQUE
-- semantics every NULL is distinct from every other NULL, so those alerts
-- would not deduplicate at all, which is precisely backwards: the ones with no
-- ref are the most repetitive, because there is no specific row for them to be
-- about.
--
-- NULLS NOT DISTINCT (PG15+, and this database is 17.6) makes two NULLs match.
-- Stated because it is load-bearing and invisible: without it this migration
-- would appear to work, and would silently fail to deduplicate the case it was
-- most needed for.
--
-- WHAT AN UPDATE DOES AND DOES NOT TOUCH
--
--   created_at    NOT touched. First seen. It is the answer to "how long has
--                 this been true", which is the question that makes an alert
--                 actionable, and it is destroyed by an upsert that refreshes
--                 it.
--   last_seen_at  Moved to now(). Most recent confirmation.
--   seen_count    Incremented. "This has now fired 47 times" is a different
--                 statement from "this fired", and cheaper than reading dates.
--   message       Overwritten. The condition is the same; the wording may have
--                 sharpened (an amount grew, a blocker list lengthened). The
--                 newest description of a live condition is the useful one.
--   tier          Overwritten. A warning that has become blocking must not stay
--                 filed as a warning because it was seen earlier.
--
-- RESOLVED ALERTS DO NOT SUPPRESS NEW ONES
--
-- The index is partial on state = 'open'. An alert that was acknowledged,
-- overridden or resolved does not match, so if the condition recurs a NEW row
-- is created rather than the closed one being quietly reopened. That is the
-- behaviour you want: somebody decided that one was dealt with, and the
-- recurrence is new information with its own first-seen date.
--
-- THE TENANT GUARDS ARE UNCHANGED
--
-- Both guard calls are carried over verbatim, in the same order, before any
-- write. p_ref_id remains POLYMORPHIC-exempt in tenant_guard_gaps() — it is
-- paired with p_ref_table and cannot be resolved to a company without a
-- per-table resolver. The verification asserts the gap count is still zero, so
-- a careless edit to this function fails here rather than on production.

alter table public.alerts
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists seen_count   integer     not null default 1;

comment on column public.alerts.created_at is
  'FIRST seen. Never moved by a repeat (0295) — it is the answer to "how long has this been true".';
comment on column public.alerts.last_seen_at is
  'Most recent time raise_alert was called for this same open condition (0295).';
comment on column public.alerts.seen_count is
  'How many times this open condition has been raised, including the first (0295).';

-- The dedupe key. NULLS NOT DISTINCT is the load-bearing clause: without it the
-- ref-less alerts, which are the most repetitive, would never collide.
create unique index if not exists alerts_open_dedupe_key
  on public.alerts (company_id, category, ref_table, ref_id)
  nulls not distinct
  where state = 'open';

create or replace function public.raise_alert(
  p_company_id uuid,
  p_tier alert_tier,
  p_category text,
  p_message text,
  p_ref_table text default null::text,
  p_ref_id uuid default null::uuid,
  p_branch_id uuid default null::uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  -- tenant guard [resolved, second map]: p_branch_id via the branch rule (0252)
  perform public.assert_branch_in_company(p_branch_id);

  -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given (0242)
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  insert into public.alerts (company_id, branch_id, tier, category, message, ref_table, ref_id, created_by)
  values (p_company_id, coalesce(p_branch_id, public.head_office_region(p_company_id)),
          p_tier, p_category, p_message, p_ref_table, p_ref_id, auth.uid())
  -- 0295. Same open condition, same row. See the header for what moves and
  -- what deliberately does not.
  on conflict (company_id, category, ref_table, ref_id) where state = 'open'
  do update set message      = excluded.message,
                tier         = excluded.tier,
                last_seen_at = now(),
                seen_count   = public.alerts.seen_count + 1
  returning id into v_id;

  return v_id;
end;
$function$;

comment on function public.raise_alert(uuid, alert_tier, text, text, text, uuid, uuid) is
  'Raise an alert, or refresh the open one that is already saying the same thing. Deduplicated on (company_id, category, ref_table, ref_id) among state=open, NULLS NOT DISTINCT so ref-less alerts collide too. created_at stays as first-seen; last_seen_at and seen_count move. A resolved alert does not suppress a recurrence. See 0295.';

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_a uuid; v_b uuid; v_emp uuid; v_emp2 uuid;
      v_cnt int; v_created timestamptz; v_seen timestamptz;
      v_msg text; v_tier text; v_n int;
    begin
      select id into v_co from public.companies order by created_at limit 1;

      -- 1. THE SAME CONDITION TWICE IS ONE ROW, and the second call returns the
      -- SAME id — callers that store the returned id must not get a new one.
      select id into v_emp from public.employees where company_id = v_co limit 1;

      v_a := public.raise_alert(v_co, 'warning', 'zz_0295_probe', 'first wording',
                                'employees', v_emp, null);
      v_b := public.raise_alert(v_co, 'blocking', 'zz_0295_probe', 'second wording',
                                'employees', v_emp, null);
      if v_a is distinct from v_b then
        raise exception '0295 FAILED: the same condition produced two ids, % and %', v_a, v_b;
      end if;

      select count(*) into v_cnt from public.alerts where category = 'zz_0295_probe';
      if v_cnt <> 1 then
        raise exception '0295 FAILED: the same condition produced % rows', v_cnt;
      end if;

      -- 2. WHAT MOVED AND WHAT DID NOT.
      select seen_count, message, tier::text, created_at, last_seen_at
        into v_n, v_msg, v_tier, v_created, v_seen
        from public.alerts where id = v_a;

      if v_n <> 2 then
        raise exception '0295 FAILED: seen_count is %, expected 2', v_n;
      end if;
      if v_msg <> 'second wording' then
        raise exception '0295 FAILED: message is %, expected the newer wording', v_msg;
      end if;
      if v_tier <> 'blocking' then
        raise exception '0295 FAILED: tier is %, expected the escalated blocking', v_tier;
      end if;
      if v_seen < v_created then
        raise exception '0295 FAILED: last_seen_at % is before created_at %', v_seen, v_created;
      end if;

      -- 3. A DIFFERENT ref_id IS A DIFFERENT ALERT. The dedupe must not
      -- collapse two guards into one row — which would be worse than the
      -- duplication it exists to prevent.
      select id into v_emp2 from public.employees
       where company_id = v_co and id <> v_emp limit 1;
      if v_emp2 is null then
        raise exception '0295: need a second employee to prove the key discriminates';
      end if;

      perform public.raise_alert(v_co, 'warning', 'zz_0295_probe', 'other guard',
                                 'employees', v_emp2, null);
      select count(*) into v_cnt from public.alerts where category = 'zz_0295_probe';
      if v_cnt <> 2 then
        raise exception '0295 FAILED: a different ref_id produced % rows, expected 2', v_cnt;
      end if;

      -- 4. NULLS NOT DISTINCT IS ACTUALLY IN FORCE. This is the clause that
      -- would fail silently: without it these two calls make two rows and the
      -- ref-less alerts — the most repetitive kind — never deduplicate at all.
      perform public.raise_alert(v_co, 'warning', 'zz_0295_noref', 'no ref at all',
                                 null, null, null);
      perform public.raise_alert(v_co, 'warning', 'zz_0295_noref', 'still no ref',
                                 null, null, null);
      select count(*) into v_cnt from public.alerts where category = 'zz_0295_noref';
      if v_cnt <> 1 then
        raise exception '0295 FAILED: two ref-less alerts produced % rows — NULLS NOT DISTINCT is not in force', v_cnt;
      end if;

      -- 5. A RESOLVED ALERT DOES NOT SWALLOW A RECURRENCE. The partial index
      -- covers open rows only, so closing one and hitting the condition again
      -- must create a second row with its own first-seen date.
      update public.alerts set state = 'resolved' where id = v_a;
      perform public.raise_alert(v_co, 'warning', 'zz_0295_probe', 'it came back',
                                 'employees', v_emp, null);
      select count(*) into v_cnt from public.alerts
       where category = 'zz_0295_probe' and ref_id = v_emp;
      if v_cnt <> 2 then
        raise exception '0295 FAILED: a recurrence after resolution produced % row(s), expected 2', v_cnt;
      end if;
      if not exists (select 1 from public.alerts
                      where category = 'zz_0295_probe' and ref_id = v_emp
                        and state = 'resolved') then
        raise exception '0295 FAILED: the resolved alert was reopened rather than left closed';
      end if;

      -- 6. THE TENANT GUARDS SURVIVED THE REWRITE. This function was retyped
      -- in full; the guards are the part that must not have been lost in it.
      select count(*) into v_cnt from public.tenant_guard_gaps();
      if v_cnt <> 0 then
        raise exception '0295 FAILED: tenant_guard_gaps() reports % gap(s) after rewriting raise_alert', v_cnt;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0295 verification failed: %', v_outcome;
  end if;
end
$verify$;
