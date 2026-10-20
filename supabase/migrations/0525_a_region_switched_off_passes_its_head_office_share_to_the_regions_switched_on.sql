-- 0525 — A region switched off passes its head-office share to the regions
-- switched on. Head office does not bear it.
--
-- DECIDED 2026-10-20, superseding 0515's option (a): "If a region is chosen as
-- No, move the cost to the other regions according to their rules. It is not
-- the duty of head office to bear the costs."
--
-- WHAT CHANGES
--   ho_apportionment's DENOMINATOR. 0515 divided the pool by EVERY region's
--   revenue and paid only the regions switched on, so a held region's share
--   stayed at head office as the unallocated line. From here the pool is
--   divided by the revenue of the regions switched on, so the whole pool lands
--   on them, each by its own revenue (A10's driver, unchanged).
--
--   Nothing else is edited. Every reader goes through ho_apportionment —
--   client_statement_loaded, partnership_allocation, run_ho_cost_allocation,
--   and ho_switch_impact through the override in ho_apportioned_effective — so
--   the rule changes everywhere at once and the price screen prices it.
--
-- WHAT IS STILL UNALLOCATED
--   Only a month in which NO region is switched on (there is nowhere to send
--   the pool), or one in which the regions switched on have no invoiced revenue
--   (no driver to divide by — partnership_run_blocker already names that case).
--
-- THE CONSEQUENCE, MEASURED BEFORE WRITING (GGS, September 2026). With the
-- settings as they stand — ISB/RWP on, Lahore and Kashmir off — ISB/RWP
-- carries the whole pool: cash 558,970.00 (was 382,775.24), accrual 418,530.00.
-- That is the outcome 0515 rejected as option (b); this instruction replaces
-- that decision. 0515's header and ho_apportionment's 0515 note are now
-- historical; the corrections live here, not in 0515.
--
-- METHOD. ho_apportionment has been written by 0514 and 0515, so no file holds
-- its true text: it is amended by surgery against pg_get_functiondef, each
-- anchor asserted to appear exactly once. ho_apportionment_driver's body note
-- ("a held region still counts in the denominator") becomes false and is
-- amended the same way. Replays as a no-op once applied.

do $$
declare
  v_fn  regprocedure := 'public.ho_apportionment(uuid,date,date,text)'::regprocedure;
  v_def text := pg_get_functiondef('public.ho_apportionment(uuid,date,date,text)'::regprocedure);
  v_note_old text := $a$  -- 0515, option (a). For each month: the pool, times this client's weight over
  -- EVERY region's weight, paid only by clients in a region switched on. A held
  -- region's share is not redistributed — it stays at head office, unallocated.$a$;
  v_note_new text := $a$  -- 0525 (superseding 0515's option (a)). For each month: the pool, times this
  -- client's weight over the weight of the regions SWITCHED ON, paid only by
  -- clients in those regions. A region switched off passes its share to them;
  -- head office keeps the pool only when no region with revenue is switched on.$a$;
  v_tot_old text := $a$    select coalesce(sum(d.weight), 0) into v_tot from public.ho_driver(p_company_id, v_m, v_me) d;$a$;
  v_tot_new text := $a$    select coalesce(sum(d.weight), 0) into v_tot from public.ho_driver(p_company_id, v_m, v_me) d
     where public.ho_apportioned_effective(p_company_id, v_m, d.branch_id);$a$;
  n int;
begin
  if position('-- 0525 (superseding' in v_def) > 0 then
    raise notice '0525: ho_apportionment already amended; skipped.';
  else
    n := (length(v_def) - length(replace(v_def, v_note_old, ''))) / length(v_note_old);
    if n <> 1 then raise exception '0525: ho_apportionment 0515 note found % times, expected 1. Refusing.', n; end if;
    n := (length(v_def) - length(replace(v_def, v_tot_old, ''))) / length(v_tot_old);
    if n <> 1 then raise exception '0525: ho_apportionment denominator found % times, expected 1. Refusing.', n; end if;
    v_def := replace(replace(v_def, v_note_old, v_note_new), v_tot_old, v_tot_new);
    execute v_def;
  end if;
end $$;

comment on function public.ho_apportionment(uuid, date, date, text) is
  '0514/0515/0525. pool x (client weight / weight of the regions switched on), for clients in regions switched on. DECIDED 2026-10-20 (0525, superseding 0515 option (a)): a region switched off passes its share to the regions switched on; head office keeps the pool only when no region with revenue is switched on. Every reader of head-office apportionment reads this.';

do $$
declare
  v_def text := pg_get_functiondef('public.ho_apportionment_driver(uuid,uuid,date)'::regprocedure);
  v_old text := $a$  -- 0515: the region's weight (sum of its clients' ho_driver weights). This is
  -- the WEIGHT, whatever the region's setting: under option (a) a held region
  -- still counts in the denominator. Whether it TAKES its share is
  -- ho_apportioned(co, month, region).$a$;
  v_new text := $a$  -- 0515/0525: the region's weight (sum of its clients' ho_driver weights),
  -- whatever the region's setting. Since 0525 only the regions switched on
  -- form ho_apportionment's denominator; whether a region is on is
  -- ho_apportioned(co, month, region).$a$;
  n int;
begin
  if position('0515/0525: the region''s weight' in v_def) > 0 then
    raise notice '0525: ho_apportionment_driver note already amended; skipped.';
    return;
  end if;
  n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if n <> 1 then raise exception '0525: ho_apportionment_driver note found % times, expected 1. Refusing.', n; end if;
  execute replace(v_def, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- Verification: the failure guarded against is "a region switched on, with
-- revenue, and part of the pool still left at head office". For every company
-- and every month from August 2026 to now in which some switched-on region has
-- revenue, the apportioned total must equal the pool on both bases.
-- ---------------------------------------------------------------------------
do $$
declare r record; v_pool numeric; v_sum numeric; v_on numeric; v_basis text; v_checked int := 0;
begin
  for r in
    select c.id as co, m::date as m, (m + interval '1 month - 1 day')::date as me
      from public.companies c
     cross join generate_series('2026-08-01'::date, date_trunc('month', now())::date, interval '1 month') m
  loop
    select coalesce(sum(d.weight), 0) into v_on from public.ho_driver(r.co, r.m, r.me) d
     where public.ho_apportioned(r.co, r.m, d.branch_id);
    continue when v_on <= 0;
    foreach v_basis in array array['accrual', 'cash'] loop
      v_pool := coalesce(public.ho_pool(r.co, r.m, r.me, v_basis), 0);
      select coalesce(sum(a.ho_share), 0) into v_sum from public.ho_apportionment(r.co, r.m, r.me, v_basis) a;
      if abs(v_pool - v_sum) > 0.01 then
        raise exception '0525: company % month % (%): pool % but % apportioned — a switched-off share is still at head office.',
          r.co, r.m, v_basis, v_pool, v_sum;
      end if;
      v_checked := v_checked + 1;
    end loop;
  end loop;
  if v_checked = 0 then
    raise exception '0525: verification checked nothing — no month has a switched-on region with revenue, so it proves nothing.';
  end if;
  raise notice '0525: % company-month-basis cases fully apportioned.', v_checked;
end $$;

-- Tenant guards: the two bodies re-executed above keep their guards verbatim;
-- the detector must still be able to read them.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
