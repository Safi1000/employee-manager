-- 0359 — regional_pl_range takes the company it is asked about.
--
-- FOUND BY ITEM 9's CHECK, ON ITS FIRST RUN. cash_pl_agrees_with_partnership
-- went red immediately: cash P&L 22,500, partnership base 0.00. The difference
-- was not an accounting one.
--
-- ===========================================================================
-- THE DEFECT
-- ===========================================================================
--
-- regional_pl_range(p_start, p_end) scopes itself with:
--
--     with cid as (select public.current_company_id() as company_id)
--
-- SESSION SCOPE ONLY. It takes no company parameter and does not use
-- resolve_company_scope, which every comparable reader does. Consequences,
-- both measured on production:
--
--   1. UNDER pg_cron IT RETURNS NOTHING. current_company_id() is NULL with no
--      JWT, so every CTE filters to nothing and the function returns zero rows.
--      run_scheduled_ledger_checks runs ledger_checks exactly that way — so
--      item 9's check would have reported the WHOLE cash P&L as a mismatch,
--      every night, for ever. A check that fires on its own blindness is worse
--      than no check: it trains people to ignore a red.
--
--   2. partnership_allocation ACCEPTS p_company_id AND THEN IGNORES IT for the
--      P&L half. It resolves partners from p_company_id but calls
--      regional_pl_range(p_start, p_end) with no company at all. The two halves
--      of the function that decides what a partner is paid are scoped
--      differently, and they agree only because a normal browser session has
--      exactly one company. This is the more serious of the two and it is not
--      something item 9 was looking for.
--
-- ===========================================================================
-- HOW THIS IS APPLIED, AND WHY NOT THE OBVIOUS WAY
-- ===========================================================================
--
-- regional_pl_range has been written by 0178 and 0179. Two authors, so per
-- CLAUDE.md there is no canonical file and it must be amended BY SURGERY
-- against the live definition — not restated. The first draft of this migration
-- restated the body from a partial read of pg_get_functiondef, which is exactly
-- the mistake 0286 and 0288 made with ledger_checks: a restatement from a copy
-- succeeds, silently drops whatever the copy lacked, and takes its own alarm
-- with it.
--
-- pg_get_functiondef returns the SIGNATURE as well as the body, so both edits
-- are surgical: the parameter list and the one scoping line. Everything between
-- them is carried across untouched and unread.
--
-- The two-argument form is then DROPPED. Two overloads differing only by a
-- defaulted argument is an ambiguity waiting to be resolved the wrong way, and
-- leaving the old one would let a caller keep the session-scoped behaviour by
-- accident. Existing two-argument calls bind to the new default, which is the
-- old behaviour exactly.

do $$
declare
  v_def   text;
  v_new   text;
  v_hits  int;
  a_sig   text := 'CREATE OR REPLACE FUNCTION public.regional_pl_range(p_start date, p_end date)';
  a_scope text := 'select public.current_company_id() as company_id';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'regional_pl_range'
     and pg_get_function_identity_arguments(p.oid) = 'p_start date, p_end date';
  if v_def is null then
    raise exception '0359 REFUSED: the two-argument regional_pl_range does not exist — it may already have been fixed.';
  end if;

  v_hits := (length(v_def) - length(replace(v_def, a_sig, ''))) / length(a_sig);
  if v_hits <> 1 then raise exception '0359 REFUSED: signature anchor appears %, expected 1', v_hits; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_scope, ''))) / length(a_scope);
  if v_hits <> 1 then
    raise exception
      '0359 REFUSED: the current_company_id() scoping line appears % time(s), expected exactly 1. More than one means there is a second scope this migration has not accounted for.', v_hits;
  end if;

  v_new := replace(v_def, a_sig,
    'CREATE OR REPLACE FUNCTION public.regional_pl_range(p_start date, p_end date, p_company_id uuid default null)');
  v_new := replace(v_new, a_scope,
    'select public.resolve_company_scope(p_company_id) as company_id /* 0359: was current_company_id(), which is NULL under pg_cron. Block comment, not a dash comment — a trailing -- here swallows the CTE closing paren. */');

  execute v_new;

  -- Only now that the three-argument form exists.
  drop function if exists public.regional_pl_range(date, date);

  raise notice '0359: regional_pl_range amended by surgery (signature + one scope line).';
end $$;

comment on function public.regional_pl_range(date, date, uuid) is
  '0179/0359: per-region P&L on both bases for a date range. 0359 added the company parameter — it was current_company_id() only, which is NULL under pg_cron and returned zero rows for every scheduled reader, and which partnership_allocation was silently relying on while accepting a company id of its own.';

revoke execute on function public.regional_pl_range(date, date, uuid) from public, anon;
grant execute on function public.regional_pl_range(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- partnership_allocation passes the company it was given.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text; v_new text; v_hits int;
  a_call text := 'from public.regional_pl_range(p_start, p_end) r';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'partnership_allocation';
  if v_def is null then raise exception '0359 REFUSED: partnership_allocation does not exist'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_call, ''))) / length(a_call);
  if v_hits <> 1 then
    raise exception '0359 REFUSED: the regional_pl_range call appears % time(s) in partnership_allocation, expected 1.', v_hits;
  end if;

  v_new := replace(v_def, a_call,
    'from public.regional_pl_range(p_start, p_end, (select company_id from cid)) r  -- 0359');
  execute v_new;
  raise notice '0359: partnership_allocation now scopes its P&L to the company it was asked about.';
end $$;

-- Item 5's blocker reads it too, and had the same blindness under cron.
do $$
declare
  v_def text; v_new text; v_hits int;
  a_call text := 'from public.regional_pl_range(v_start, v_end) r';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'partnership_run_blocker';
  if v_def is null then raise exception '0359 REFUSED: partnership_run_blocker does not exist'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_call, ''))) / length(a_call);
  if v_hits <> 1 then
    raise exception '0359 REFUSED: the blocker''s regional_pl_range call appears %, expected 1.', v_hits;
  end if;

  v_new := replace(v_def, a_call, 'from public.regional_pl_range(v_start, v_end, p_company_id) r  -- 0359');
  execute v_new;
  raise notice '0359: partnership_run_blocker scoped to its company parameter.';
end $$;

-- ---------------------------------------------------------------------------
-- Prove the blindness is gone: this session has no tenant claim, exactly like
-- pg_cron, and the function must now answer for a company it is handed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid := (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
  v_n  int;
begin
  if v_co is null then raise notice '0359: GGS absent; probe skipped.'; return; end if;

  select count(*) into v_n from public.regional_pl_range(
    date_trunc('month', current_date)::date,
    (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
    v_co);

  if v_n = 0 then
    raise exception
      '0359 FAILED: regional_pl_range still returns no rows for GGS when handed its company id. The scope fix did not take, and every scheduled reader is still blind.';
  end if;
  raise notice '0359: regional_pl_range returns % region(s) with no session claim.', v_n;
end $$;
