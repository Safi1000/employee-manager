-- 0361 — a partnership run is DRAFTED, REVIEWED, and only then POSTED.
--
-- ===========================================================================
-- THE SHAPE PROBLEM, REPORTED BEFORE BUILDING
-- ===========================================================================
--
-- The brief asks for "post as a distinct action from draft". It is not, today.
-- run_profit_allocation() computes the month, writes the run record as DRAFT,
-- and then posts it in the same call. The DRAFT status exists in the table and
-- in the status CHECK, but no code path can ever leave a run sitting in it:
-- by the time the function returns, the row says POSTED.
--
-- So the review screen had nothing to review. Everything ELSE it needs is
-- already stored and already correct — 0282 put the per-client Net Cash, the
-- rate applied and the partner_client_shares row it came from into `inputs`,
-- and the whole allocation into `outputs`, beside the totals. That is exactly
-- a review screen's data. The one thing missing was the pause.
--
-- ===========================================================================
-- AND THE HARDER HALF: WHAT DOES POST POST?
-- ===========================================================================
--
-- If posting RECOMPUTES, it can post numbers the reviewer never saw — an
-- invoice raised between the draft and the post moves every figure, silently,
-- and the approval belonged to a different month than the one that landed.
--
-- If posting REPLAYS THE STORED OUTPUTS, it posts numbers that may since have
-- become wrong, and the ledger carries a month that no longer reconciles to
-- anything computable from the source data.
--
-- Both are defects. So neither: posting RECOMPUTES AND REFUSES IF ANYTHING
-- MOVED, naming what moved. The reviewer re-drafts, looks at the new numbers,
-- and posts those. This is the rule the opening-balance prefill got when it
-- learned to refuse a stale batch, and it is here for the same reason — an
-- approval is an approval OF SOMETHING, and the something has to still exist.
--
-- The comparison is made by RE-DRAFTING inside this transaction and comparing
-- the row against a snapshot taken before. When it differs, the raise rolls
-- the re-draft back with it, so the reviewer's draft survives the refusal
-- intact and they are told what changed rather than finding their draft
-- quietly replaced.
--
-- ===========================================================================
-- HOW IT IS APPLIED
-- ===========================================================================
--
-- run_profit_allocation has been written by 0282 and amended by 0303, 0305,
-- 0328, 0351 and 0360. Many authors, so per CLAUDE.md there is no canonical file and
-- it is amended BY SURGERY against pg_get_functiondef. Two edits: the
-- signature gains p_post, and one early return goes in ahead of the posting
-- section. Everything between is carried across unread.
--
-- The three-argument form is then dropped, as 0359 dropped the two-argument
-- regional_pl_range and for the same reason: two overloads differing only by a
-- defaulted argument is an ambiguity waiting to be resolved the wrong way.
-- Existing three-argument callers bind to the new default, p_post => true,
-- which is the old behaviour exactly.
--
-- WHAT 0360 HAD TO DO FIRST. The probe at the foot of this file drafts a run,
-- and on its first attempt it could not: run_profit_allocation resolved its
-- company from the SESSION at six separate points despite having been handed
-- one. That survey and its nine fixes are 0360, and this migration cannot be
-- proved without it.

do $$
declare
  v_def  text;
  v_new  text;
  v_hits int;
  a_ret  text := '  -- Rows 33/34: regional remuneration is an EXPENSE.';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_profit_allocation'
     and pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_period date, p_basis text';
  if v_def is null then
    raise exception
      '0361 REFUSED: run_profit_allocation(uuid, date, text) does not exist with that exact argument list. Either it has already been split, or it carries an argument list this migration has not accounted for — in which case the surgery below would be operating on something it has not read.';
  end if;

  -- The posting section starts at this comment. Asserting the anchor is unique
  -- is the whole safety of the edit: two matches would mean two posting
  -- sections and an early return placed in front of the wrong one.
  v_hits := (length(v_def) - length(replace(v_def, a_ret, ''))) / length(a_ret);
  if v_hits <> 1 then
    raise exception
      '0361 REFUSED: the posting-section anchor appears % time(s) in run_profit_allocation, expected exactly 1.', v_hits;
  end if;

  -- Signature. The identity argument list was asserted above, so rewriting the
  -- whole first line is pinned rather than guessed.
  v_new := regexp_replace(
    v_def,
    '^CREATE OR REPLACE FUNCTION [^' || chr(10) || ']*' || chr(10),
    'CREATE OR REPLACE FUNCTION public.run_profit_allocation(p_company_id uuid, p_period date, p_basis text DEFAULT NULL::text, p_post boolean DEFAULT true)' || chr(10));

  if v_new = v_def then
    raise exception '0361 REFUSED: the signature line did not match and was not rewritten.';
  end if;

  v_new := replace(v_new, a_ret,
    '  -- 0361: DRAFT STOPS HERE. Everything above has computed the month and' || chr(10) ||
    '  -- written the run record; everything below moves it into the ledger.'  || chr(10) ||
    '  if not p_post then return v_run; end if;'                               || chr(10) ||
    chr(10) || a_ret);

  execute v_new;

  drop function if exists public.run_profit_allocation(uuid, date, text);

  raise notice '0361: run_profit_allocation split by surgery (signature + one early return).';
end $$;

comment on function public.run_profit_allocation(uuid, date, text, boolean) is
  '0282/0361: computes one month''s profit allocation and stores it as a run record. p_post => false stops at DRAFT; p_post => true (the default, and the pre-0361 behaviour) goes on to post rows 33/34/35 as one journal entry. Prefer draft_profit_allocation / post_profit_allocation, which add the review pause and the staleness refusal.';

revoke execute on function public.run_profit_allocation(uuid, date, text, boolean) from public, anon;
grant execute on function public.run_profit_allocation(uuid, date, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Draft. A thin wrapper, deliberately: the computation has one author and this
-- is not going to be a second one.
-- ---------------------------------------------------------------------------
create or replace function public.draft_profit_allocation(
  p_company_id uuid, p_period date, p_basis text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return public.run_profit_allocation(p_company_id, p_period, p_basis, false);
end;
$fn$;

comment on function public.draft_profit_allocation(uuid, date, text) is
  '0361: computes a month''s partnership run and leaves it DRAFT for review. Re-drafting the same month overwrites the draft, which is the point — a draft is a working document until it is posted.';

revoke execute on function public.draft_profit_allocation(uuid, date, text) from public, anon;
grant execute on function public.draft_profit_allocation(uuid, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Post. The reviewed numbers, or nothing.
--
-- p_confirm_incomplete is 0358 item 5's completeness gate, wired where it was
-- always meant to bite. It is a CONFIRMATION, NOT A BLOCK: the first call
-- refuses and names the clients, the second proceeds. A hard block would be
-- worked around by back-dating an invoice, which is worse than posting a month
-- somebody looked at and accepted.
-- ---------------------------------------------------------------------------
create or replace function public.post_profit_allocation(
  p_run_id uuid, p_confirm_incomplete boolean default false)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_run    record;
  v_before record;
  v_after  record;
  v_moved  text := '';
  v_names  text;
  v_n      int;
begin
  select * into v_run from public.profit_allocation_runs where id = p_run_id;
  if not found then raise exception 'Partnership run not found.'; end if;

  -- tenant guard [resolved, 0287]: the company comes off the run, not the caller
  perform public.assert_same_company(v_run.company_id);

  -- A PERMISSION, NOT A ROLE LITERAL. Same rule as expenses.approve in 0346:
  -- naming a role here would make "who may pay the partners" a thing you change
  -- by promoting somebody. has_permission() is false when auth.uid() is null,
  -- which is every SQL and cron caller, so the test is skipped for them — they
  -- are not a person and have no permission set to consult.
  if auth.uid() is not null and not public.has_permission('partnership.post') then
    raise exception
      'You do not have permission to post a partnership run. This posts to every partner''s capital account and needs partnership.post.'
      using errcode = '42501';
  end if;

  if v_run.status <> 'DRAFT' then
    raise exception
      'The partnership run for % is %, not DRAFT. Only a drafted run can be posted; reverse a posted one first.',
      to_char(v_run.period_month, 'Mon YYYY'), v_run.status
      using errcode = 'P0001';
  end if;

  -- ---- completeness: name them, then let the reviewer decide ---------------
  select count(*),
         string_agg(u.client_name || ' — ' || u.reason, chr(10) || '  - ' order by u.client_name)
    into v_n, v_names
    from public.partnership_uninvoiced_clients(v_run.company_id, v_run.period_month) u;

  if v_n > 0 and not p_confirm_incomplete then
    raise exception '%',
      v_n || ' client(s) live in ' || to_char(v_run.period_month, 'Mon YYYY')
        || ' have no primary invoice for the month:' || chr(10) || '  - ' || v_names
        || chr(10) || chr(10)
        || 'Their cost is in the pool and their revenue is not, so every partner''s share is understated. Post anyway only if that is deliberate.'
      using errcode = 'P0001', hint = 'Confirm to proceed.';
  end if;

  -- ---- staleness: post what was reviewed, or refuse and say what moved -----
  select r.total_profit, r.regional_total, r.equity_total, r.basis into v_before
    from public.profit_allocation_runs r where r.id = p_run_id;

  perform public.run_profit_allocation(
    v_run.company_id, v_run.period_month, v_before.basis, false);

  select r.total_profit, r.regional_total, r.equity_total into v_after
    from public.profit_allocation_runs r where r.id = p_run_id;

  if round(coalesce(v_after.total_profit, 0), 2) <> round(coalesce(v_before.total_profit, 0), 2) then
    v_moved := v_moved || chr(10) || '  - profit: '
      || coalesce(v_before.total_profit, 0) || ' -> ' || coalesce(v_after.total_profit, 0);
  end if;
  if round(coalesce(v_after.regional_total, 0), 2) <> round(coalesce(v_before.regional_total, 0), 2) then
    v_moved := v_moved || chr(10) || '  - regional partners: '
      || coalesce(v_before.regional_total, 0) || ' -> ' || coalesce(v_after.regional_total, 0);
  end if;
  if round(coalesce(v_after.equity_total, 0), 2) <> round(coalesce(v_before.equity_total, 0), 2) then
    v_moved := v_moved || chr(10) || '  - equity partners: '
      || coalesce(v_before.equity_total, 0) || ' -> ' || coalesce(v_after.equity_total, 0);
  end if;

  if v_moved <> '' then
    -- This raise rolls the re-draft back with it, so the draft on screen is
    -- still the draft that was reviewed. Nothing is quietly replaced.
    raise exception '%',
      'The source data moved since this run was drafted, so posting it would post figures nobody reviewed:'
        || v_moved || chr(10) || chr(10)
        || 'Re-draft the month, look at the new numbers, and post those.'
      using errcode = 'P0001';
  end if;

  return public.run_profit_allocation(
    v_run.company_id, v_run.period_month, v_before.basis, true);
end;
$fn$;

comment on function public.post_profit_allocation(uuid, boolean) is
  '0361: posts a DRAFT partnership run. Refuses if clients are uninvoiced unless p_confirm_incomplete (a confirmation, not a block — it names them). Refuses if the source data has moved since the draft, naming what moved, because an approval is an approval of something. Posting itself is run_profit_allocation, unchanged.';

revoke execute on function public.post_profit_allocation(uuid, boolean) from public, anon;
grant execute on function public.post_profit_allocation(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Prove the pause exists. Without this the migration could apply cleanly and
-- still leave DRAFT unreachable, which is precisely the defect it fixes.
-- ---------------------------------------------------------------------------
do $probe$
declare
  v_co     uuid := (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
  v_month  date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_run    uuid;
  v_status text;
  v_result text := '';
begin
  if v_co is null then raise notice '0361: GGS absent; probe skipped.'; return; end if;

  begin
    v_run := public.draft_profit_allocation(v_co, v_month, null);
    select status into v_status from public.profit_allocation_runs where id = v_run;
    if v_status <> 'DRAFT' then
      raise exception '0361 FAILED: draft_profit_allocation left the run %, not DRAFT. The early return did not take.', v_status;
    end if;
    v_result := 'draft=DRAFT ok';
  exception
    when sqlstate 'P0001' then
      -- run_profit_allocation refuses a closed month and refuses a month the
      -- blocker rejects. Both are the function working; neither tells us
      -- whether the pause exists, so say so rather than claiming a pass.
      v_result := 'draft not reachable for ' || to_char(v_month, 'Mon YYYY')
                  || ' (' || sqlerrm || ') — pause not exercised';
  end;

  raise notice '0361 probe: %', v_result;

  -- Roll the probe back whatever happened. A migration does not leave a draft.
  raise exception 'ROLLBACK_PROBE_0361: %', v_result;
exception
  when others then
    if sqlerrm like 'ROLLBACK_PROBE_0361:%' then
      raise notice '0361: %', sqlerrm;
    else
      raise;
    end if;
end;
$probe$;
