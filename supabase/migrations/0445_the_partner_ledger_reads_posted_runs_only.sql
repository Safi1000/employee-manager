-- 0445 — the partner ledger reads posted runs only.
--
-- partner_ledger computed every month from the partner's start to TODAY by
-- calling partnership_allocation() and inserting the result as a remuneration
-- row. That was a second implementation of the allocation, and it is why an
-- unfinished September showed Nauman Ahmed −658,507 that nobody earned: no run
-- had been drafted, let alone posted — profit_allocation_runs was empty.
--
-- It was also a latent DOUBLE COUNT. run_profit_allocation posts each partner's
-- share to his capital account (source_table 'profit_allocation'), and this
-- function's GL arm carried every capital-account line except
-- partner_account_entries. The first posted month would have appeared twice:
-- once recomputed, once as the posted line.
--
-- NOW:
--   * remuneration IS the posted line on the capital account, credit − debit,
--     labelled with the RUN'S month ("SEPTEMBER 2026"; "— REVERSED" on a
--     reversal). Nothing is computed here.
--   * the GL arm excludes 'profit_allocation', so a posted month counts once.
--   * a month with no POSTED run gets a row "SEPTEMBER 2026 — NOT ALLOCATED"
--     with zero remuneration, so an unallocated month is visible rather than
--     silently absent or silently computed.
--   * the label names the MONTH. It used to name the window's first day
--     ("BAL TILL 01ST OF SEP 2026") while the row was dated the window's last —
--     unchanged since 0207, which is where the June rows came from.
--   * the basis lookup goes: nothing here needs a basis any more, and keeping it
--     made the ledger raise for a company with no basis configured.
--
-- THE SIGN is unchanged and is now the only convention (DECIDED): balance =
-- opening + remuneration − cash paid, and POSITIVE MEANS THE COMPANY OWES THE
-- PARTNER. It is the capital account's own sign — credit-normal equity, a
-- posted share and an OPENING entry credit it, a drawing debits it. The form
-- that said "positive = the partner owes the company" was wrong and is
-- corrected in the same commit. Opening balances typed under that wording are
-- NOT touched here: whether they were entered meaning the wording is a question
-- for Shayan.
--
-- SURGERY against the live body: partner_ledger has been edited by 0207–0218,
-- 0354 and others, so no file holds its text. Each anchor asserted once.

do $$
declare v_md5 text;
begin
  select md5(pg_get_functiondef('public.partner_ledger(uuid,date,date)'::regprocedure)) into v_md5;
  if v_md5 <> '4d1e8ecdb5f167ff63c94ebfb4a8992a' then
    raise exception '0445 REFUSED: partner_ledger is not the body these anchors were counted against (md5 %). Recount them against the live definition.', v_md5;
  end if;
end $$;

create or replace function pg_temp.surg(p_fn text, p_old text, p_new text, p_expect int)
returns void language plpgsql as $fn$
declare v_def text; v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  if v_def is null then raise exception '0445 REFUSED: % does not exist.', p_fn; end if;
  v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  if v_hits <> p_expect then
    raise exception '0445 REFUSED: in %, the anchor appears % time(s), expected %. Anchor began: %',
      p_fn, v_hits, p_expect, left(p_old, 70);
  end if;
  execute replace(v_def, p_old, p_new);
end $fn$;

-- The basis lookup, and the comment that justified it. Nothing needs a basis now.
select pg_temp.surg('partner_ledger',
$a$  -- 0354. The basis is the COMPANY'S, never a literal. partner_ledger asked
  -- partnership_allocation for 'revenue' unconditionally, and
  -- partner_basis_for_report refuses any basis that disagrees with
  -- finance_settings.partner_remuneration_basis. GGS is configured 'cash', so
  -- this function raised for every GGS partner — unnoticed only because GGS had
  -- no partners yet.
  v_basis := public.partner_basis_for_report(null, v_company);
$a$,
$b$  -- 0445: no basis. The ledger reads what was POSTED; the basis was decided
  -- when the run was drafted and is stored on profit_allocation_runs.
$b$, 1);

-- Remuneration: the posted line, not a recomputation. Plus the unallocated months.
select pg_temp.surg('partner_ledger',
$a$  remun as (
    select (m + interval '1 month - 1 day')::date as x_date,
           'BAL TILL ' || upper(to_char(m, 'DDth "OF" MON YYYY')) as x_part, 0::numeric as x_cash,
           coalesce((select a.amount from public.partnership_allocation(
               m, (m + interval '1 month - 1 day')::date, v_basis) a
              where a.partner_id = p_partner_id limit 1), 0) as x_remun,
           'ALLOCATION'::text as x_src, null::uuid as x_eid
      from months
  ),
$a$,
$b$  -- 0445: REMUNERATION IS WHAT WAS POSTED. The run's journal line on the
  -- capital account, credit − debit (a share credits it), labelled with the
  -- run's month. A reversal arrives as its own line and nets it out.
  remun as (
    select je.entry_date as x_date,
           upper(to_char(r.period_month, 'FMMonth YYYY'))
             || case when je.is_reversal then ' — REVERSED' else '' end as x_part,
           0::numeric as x_cash,
           (coalesce(jl.credit, 0) - coalesce(jl.debit, 0)) as x_remun,
           'ALLOCATION'::text as x_src, null::uuid as x_eid
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.profit_allocation_runs r on r.id = je.source_id
     where v_coa is not null and jl.account_id = v_coa
       and je.source_table = 'profit_allocation'
       and je.entry_date between v_from and v_to
  ),
  -- A month with no POSTED run: shown, with nothing in it. Never computed.
  unalloc as (
    select (m + interval '1 month - 1 day')::date as x_date,
           upper(to_char(m, 'FMMonth YYYY')) || ' — NOT ALLOCATED' as x_part,
           0::numeric as x_cash, 0::numeric as x_remun,
           'UNALLOCATED'::text as x_src, null::uuid as x_eid
      from months
     where not exists (
       select 1 from public.profit_allocation_runs r
        where r.company_id = v_company and r.period_month = months.m and r.status = 'POSTED')
  ),
$b$, 1);

-- The GL arm stops carrying the posted run, or a posted month counts twice.
select pg_temp.surg('partner_ledger',
$a$       and coalesce(je.source_table, '') <> 'partner_account_entries'
$a$,
$b$       and coalesce(je.source_table, '') <> 'partner_account_entries'
       and coalesce(je.source_table, '') <> 'profit_allocation'   -- 0445: read by remun, once
$b$, 1);

select pg_temp.surg('partner_ledger',
$a$    select x_date, x_part, x_cash, x_remun, x_src, x_eid from remun where x_remun <> 0
$a$,
$b$    select x_date, x_part, x_cash, x_remun, x_src, x_eid from remun
    union all select x_date, x_part, x_cash, x_remun, x_src, x_eid from unalloc
$b$, 1);

comment on function public.partner_ledger(uuid, date, date) is
  '0445: a partner''s running position. Remuneration is ONLY what a POSTED profit_allocation run put on the capital account; a month with no posted run shows as NOT ALLOCATED and is never computed. Balance = opening + remuneration − cash paid; POSITIVE = THE COMPANY OWES THE PARTNER (DECIDED).';

-- ---------------------------------------------------------------------------
-- NOTHING IS COMPUTED ANY MORE — asserted on the text, so a later edit that
-- reintroduces the call is refused rather than trusted.
-- ---------------------------------------------------------------------------
do $$
declare v_src text;
begin
  select prosrc into v_src from pg_proc where oid = 'public.partner_ledger(uuid,date,date)'::regprocedure;
  if v_src ~ 'partnership_allocation\s*\(' then
    raise exception '0445 FAILED: partner_ledger still calls partnership_allocation.';
  end if;
  if v_src ~ 'BAL TILL' then
    raise exception '0445 FAILED: partner_ledger still builds the BAL TILL label.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE PROBE, rolled back.
--   1. Every REAL partner: no run is posted, so remuneration sums to zero and no
--      ALLOCATION row exists. (Before 0445 Nauman's summed to −658,507.)
--   2. A probe partner starting August with a POSTED August run of 1,000 on his
--      capital account: exactly ONE remuneration row, "AUGUST 2026", 1,000; no
--      GL:PROFIT_ALLOCATION duplicate; September shows NOT ALLOCATED; closing
--      balance = opening 100 + 1,000.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid; v_uid uuid; v_p uuid; v_acct uuid; v_run uuid; v_n int; v_s numeric; v_txt text; r record;
begin
  select id into v_co from public.companies where active and archived_at is null order by created_at limit 1;
  select p.id into v_uid from public.profiles p where p.company_id = v_co
   and p.role in ('super_admin','super_super_admin') order by p.role limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  -- 1. real partners
  for r in select p.id, p.name from public.partners p where p.company_id = v_co loop
    select count(*) filter (where l.source = 'ALLOCATION'), coalesce(sum(l.remuneration), 0)
      into v_n, v_s from public.partner_ledger(r.id, null, null) l;
    if exists (select 1 from public.profit_allocation_runs x where x.company_id = v_co and x.status = 'POSTED') then
      null;  -- a run has been posted since this was written; part 2 still tests the mechanism
    elsif v_n <> 0 or v_s <> 0 then
      raise exception '0445 PROBE FAILED: % shows % allocation row(s) summing % with no posted run.', r.name, v_n, v_s;
    end if;
  end loop;

  -- 2. a posted run, read once
  insert into public.partners (company_id, name, scope, profit_share_percent, opening_balance, start_month, allocation_method, is_active)
  values (v_co, '0445 Probe Partner', 'COMPANY', 0, 100, '2026-08-01', 'FIXED_PCT', true)
  returning id, coa_account_id into v_p, v_acct;
  if v_acct is null then select coa_account_id into v_acct from public.partners where id = v_p; end if;
  if v_acct is null then raise exception '0445 PROBE FAILED: the probe partner has no capital account.'; end if;

  insert into public.profit_allocation_runs (company_id, period_month, status, basis, total_profit, regional_total, equity_total)
  values (v_co, '2026-08-01', 'POSTED', 'cash', 1000, 0, 1000) returning id into v_run;
  perform public.post_journal(v_co, '2026-08-31', '0445 probe allocation', 'profit_allocation', v_run, false,
    jsonb_build_array(
      jsonb_build_object('key', 'retained_earnings', 'debit', 1000, 'credit', 0),
      jsonb_build_object('account_id', v_acct, 'debit', 0, 'credit', 1000, 'partner_id', v_p)),
    null);

  select count(*), coalesce(sum(l.remuneration), 0), string_agg(l.particulars, ' | ')
    into v_n, v_s, v_txt from public.partner_ledger(v_p, null, null) l where l.source = 'ALLOCATION';
  if v_n <> 1 or v_s <> 1000 or v_txt <> 'AUGUST 2026' then
    raise exception '0445 PROBE FAILED: posted August read as % row(s), %, "%" — expected 1 row, 1000, "AUGUST 2026".', v_n, v_s, v_txt;
  end if;
  if exists (select 1 from public.partner_ledger(v_p, null, null) l where l.source like 'GL:PROFIT_ALLOCATION%') then
    raise exception '0445 PROBE FAILED: the posted run also appears through the GL arm — a double count.';
  end if;
  if not exists (select 1 from public.partner_ledger(v_p, null, null) l
                  where l.source = 'UNALLOCATED' and l.particulars = 'SEPTEMBER 2026 — NOT ALLOCATED' and l.remuneration = 0) then
    raise exception '0445 PROBE FAILED: September, with no posted run, is not shown as NOT ALLOCATED.';
  end if;
  if exists (select 1 from public.partner_ledger(v_p, null, null) l where l.source = 'UNALLOCATED' and l.particulars like 'AUGUST 2026%') then
    raise exception '0445 PROBE FAILED: August has a posted run and is still shown as NOT ALLOCATED.';
  end if;
  select l.balance into v_s from public.partner_ledger(v_p, null, null) l order by l.entry_date desc, l.source limit 1;
  if v_s <> 1100 then
    raise exception '0445 PROBE FAILED: closing balance %, expected 1100 (opening 100 + posted 1000).', v_s;
  end if;

  raise exception 'ROLLBACK_PROBE';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    perform set_config('request.jwt.claim.sub', null, true);
    if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
    raise notice '0445 probe passed: no posted run, no remuneration; a posted run read once; unposted month shown as NOT ALLOCATED.';
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0445 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
