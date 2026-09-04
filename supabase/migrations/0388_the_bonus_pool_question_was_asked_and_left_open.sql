-- 0388 — bonus_pools carries DEFERRED, not DECIDED.
--
-- 0387 reverted the branch guard on generate_bonus_pool and flagged the reason
-- it was worth a second look: of the four company-wide tables, this is the only
-- one where a row determines a PAYMENT. bonus_pool_allocations.share_amount is
-- what an employee is actually paid.
--
-- Shayan has left it as it stands for now. THAT IS NOT THE SAME AS DECIDING IT,
-- and the difference matters to the next reader:
--
--   DECIDED — asked, answered, do not reopen without a reason.
--   DEFERRED — asked, deliberately left open, still owed an answer.
--
-- A flag that is not marked slides into the first of those by default, because
-- nothing on the object distinguishes "settled" from "not yet returned to".
-- Six months from now the comment reads as a decision nobody made.
--
-- Only the sentence changes. The behaviour is 0387's and stays 0387's: the
-- guard is off, performance.approve is the gate, and a holder of it can
-- generate any region's pool including head office.
--
-- Note for anyone grepping: the phrase COMPANY-WIDE BY DESIGN is deliberately
-- dropped from this one comment and kept on the other three. "By design" is a
-- claim about a settled intent, and that is the exact claim not being made
-- here. The scoping is the same; the confidence is not.

comment on table public.bonus_pools is
  '0387/0388: company scoping only, and deliberately NO branch policy — the same company-wide decision as alerts and approval_requests (Shayan, 2026-09-04). The gate is perm_write_* on performance.approve and nothing narrower.
   *** DEFERRED, NOT DECIDED. *** This one table was flagged and left open rather than settled. The other three company-wide tables are VISIBILITY — who may see or file a record about another region. This one determines a PAYMENT: a pool sets bonus_pool_allocations.share_amount, which is the figure an employee is actually paid, and generate_bonus_pool() rebuilds those allocations wholesale. So company-wide here means a holder of performance.approve can generate ANY region''s pool, head office included, and change what people are paid there.
   That follows from the decision exactly as stated and is the behaviour today. It is recorded as an OPEN question, not a closed one: see docs/PERMISSION_GAPS.md 10b. Re-adding assert_branch_writable(v_scope_branch) to generate_bonus_pool() is the change if the answer comes back the other way.';

do $$
declare v_c text;
begin
  select obj_description(c.oid, 'pg_class') into v_c
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'bonus_pools';

  if v_c is null or v_c not like '%DEFERRED, NOT DECIDED%' then
    raise exception '0388 FAILED: bonus_pools does not carry the deferred marker.';
  end if;

  -- The other three stay DECIDED. If this migration had widened the wording to
  -- all four, the one open question would have been buried in three closed
  -- ones, which is the failure it exists to prevent.
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('alerts', 'approval_requests', 'bonus_pool_allocations')
         and obj_description(c.oid, 'pg_class') like '%DEFERRED%') <> 0 then
    raise exception '0388 FAILED: a table other than bonus_pools was marked deferred.';
  end if;

  -- And the behaviour is unchanged: the guard stays off.
  if public.executable_source(pg_get_functiondef(
       (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'generate_bonus_pool'))) ~ 'assert_branch_writable' then
    raise exception '0388 FAILED: generate_bonus_pool guards again. This migration changes a sentence, not the behaviour.';
  end if;
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
    raise exception '0388 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
