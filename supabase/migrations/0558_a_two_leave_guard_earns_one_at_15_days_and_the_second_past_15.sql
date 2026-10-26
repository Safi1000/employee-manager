-- 0558 — a two-leave guard earns one leave at 15 days present, the second past 15
--
-- DECIDED 2026-10-26 (Shayan): on a 2-leave quota, "1 leave for first 15 days
-- and 2nd after 15 days present days elapse" — read back to him as
--     15 days present → 1 leave     16 or more → 2     fewer than 15 → 0
-- and chosen. "4 days leaves should stay as is."
--
-- Under 0438 a quota of 2 earned 1 at 9 days present and 2 at 25. From
-- 1 October 2026 it earns 0 below 15, 1 at exactly 15, 2 from 16.
--
-- EFFECTIVE 1 OCTOBER 2026, and ONLY from there. September stays on 0438's
-- tiers: its payroll is run, and its closing balance is October's opening.
-- The gate is inside leave_earned_on(), so no caller can apply the rule to an
-- earlier month.
--
-- WHAT COUNTS AS "A 2-LEAVE GUARD": a quota of exactly 2 — the contract's
-- figure, or a named override of 2. Every other quota (4, none, an override
-- of 1/3/6, and the non-whole average a mid-month transfer between a 2- and a
-- 4-leave contract produces) keeps 0438's tiers unchanged. DEFERRED: a guard
-- moved mid-month between 2- and 4-leave contracts averages to a quota of 3
-- and earns on the tiers; if that should follow the 2-leave rule for his days
-- on the 2-leave contract, the change is in leave_earned_on.
--
-- leave_periods_all has two authors (0438, 0540), so its one earning line is
-- changed by surgery against the live definition, anchor asserted once.
-- leave_earned and leave_tier are untouched; leave_earned_on is new.

create or replace function public.leave_earned_on(p_quota numeric, p_present int, p_period_start date)
returns int language sql immutable set search_path to 'public' as $fn$
  select case
    when p_period_start >= date '2026-10-01' and p_quota = 2
      then case when p_present >= 16 then 2 when p_present = 15 then 1 else 0 end
    else public.leave_earned(p_quota, public.leave_tier(p_present))
  end
$fn$;
comment on function public.leave_earned_on(numeric, int, date) is
  '0558 DECIDED 2026-10-26: leaves earned in a period. A quota of exactly 2, from October 2026: 0 below 15 days present, '
  '1 at 15, 2 from 16. Everything else, and every period before October 2026: 0438''s floor(Q × tier / 4).';

-- The matrix, or the migration refuses.
do $$
declare
  m numeric[][] := array[
    -- quota, present, period, expected (period: 0 = Sept 2026, 1 = Oct 2026)
    [2, 8, 1, 0], [2, 14, 1, 0], [2, 15, 1, 1], [2, 16, 1, 2], [2, 26, 1, 2], [2, 0, 1, 0],
    [2, 9, 0, 1], [2, 15, 0, 1], [2, 16, 0, 1], [2, 24, 0, 1], [2, 25, 0, 2],
    [4, 8, 1, 0], [4, 9, 1, 2], [4, 17, 1, 3], [4, 25, 1, 4],
    [0, 30, 1, 0], [3, 25, 1, 3], [6, 16, 1, 3]];
  i int; v int;
begin
  for i in 1..array_length(m, 1) loop
    v := public.leave_earned_on(m[i][1], m[i][2]::int, case when m[i][3] = 1 then date '2026-10-01' else date '2026-09-01' end);
    if v <> m[i][4] then
      raise exception '0558 REFUSED: leave_earned_on(Q=%, present=%, %) = %, expected %.',
        m[i][1], m[i][2], case when m[i][3] = 1 then 'Oct' else 'Sep' end, v, m[i][4];
    end if;
  end loop;
end $$;

do $surgery$
declare
  v_def text := pg_get_functiondef('public.leave_periods_all(uuid, date)'::regprocedure);
  v_anchor constant text := 'v_earn := public.leave_earned(v_q, v_t);';
  v_n int;
begin
  if position('leave_earned_on' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0558 REFUSED: the earning line appears % times in leave_periods_all.', v_n; end if;
  execute replace(v_def, v_anchor,
    'v_earn := public.leave_earned_on(v_q, r.present_days, v_ms);  -- 0558: a 2-leave quota from October 2026');
end $surgery$;

do $$
begin
  if position('leave_earned_on(v_q, r.present_days, v_ms)' in pg_get_functiondef('public.leave_periods_all(uuid, date)'::regprocedure)) = 0 then
    raise exception '0558 REFUSED: leave_periods_all does not call leave_earned_on.';
  end if;
end $$;
