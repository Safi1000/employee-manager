-- 0334 — journal_lines_regional has a reader, and the map says so.
--
-- THE FALSE POSITIVE. every_control_is_invoked has been reporting
-- journal_lines_regional as a view nothing reads. It is read:
--
--   src/app/pages/super-admin/JournalView.tsx:193   .from("journal_lines_regional").select("posting_period")
--   src/app/pages/super-admin/JournalView.tsx:275   .from("journal_lines_regional").select("*")
--
-- That is the ledger drill-down — the screen 0319 pointed at this view
-- precisely so the journal would be read rather than recomputed. It is the last
-- view in the database that should read as dead, and the check has been calling
-- it dead on the one company left on production.
--
-- A check that is wrong about the thing it is most visible on is worse than a
-- check that is silent: the reader learns to discount it. Same failure mode
-- 0307's header names for migration-aliases.txt.
--
-- WHY IT WENT WRONG, AND IT IS NOT A BUG IN uninvoked_controls(). The function
-- cannot see src/. 0294 designed the view arm around a hand-written map whose
-- entries NAME the reading file, so each one is a claim a person can check with
-- a single grep. That is the right design given the constraint. What it cannot
-- do is notice a NEW consumer.
--
-- And this one went stale immediately: the map's own header records that it was
-- established by grep on 2026-09-01, and JournalView.tsx was pointed at the
-- view after that. **The map was out of date within a day of being written, and
-- nothing reported it.** So this file does two things — adds the entry, and
-- makes the header say out loud that the map is hand-maintained and goes stale
-- on every new consumer, which is the fact a future reader needs before they
-- trust a green result from the view arm.
--
-- SURGERY. uninvoked_controls() has four authors — 0288 wrote it, 0288b taught
-- it that comments are not code, 0294 gave it the view arm, 0307 added
-- vetting_dashboard to this same map — so no single file holds its true text.
-- Two anchors, each asserted to appear exactly once.
--
-- 0307 IS THE PRECEDENT and this follows it, with one correction: 0307 asserted
-- the resulting count against the literal 11. Dev and production do not hold
-- the same number, and a literal would refuse on one of them for a reason
-- having nothing to do with correctness. This reads the count before the edit
-- and requires exactly one row fewer (0304/0310/0327).

-- ---------------------------------------------------------------------------
-- 0. What the check answers BEFORE the edit, as a reading.
-- ---------------------------------------------------------------------------
create temp table _0334_before on commit drop as
  select count(*) as total,
         count(*) filter (where kind = 'view') as views
    from public.uninvoked_controls();

-- ---------------------------------------------------------------------------
-- 1. The map gains an entry, and its header gains a warning.
-- ---------------------------------------------------------------------------
do $map$
declare
  v_src  text;
  v_hits int;
  v_row_anchor constant text :=
    E'      (''kpi_dashboard'',                    ''src/app/pages/super-admin/Performance.tsx''),\n';
  v_row_new constant text :=
    E'      (''journal_lines_regional'',           ''src/app/pages/super-admin/JournalView.tsx (0319, 0334)''),\n'
    || E'      (''kpi_dashboard'',                    ''src/app/pages/super-admin/Performance.tsx''),\n';
  v_hdr_anchor constant text :=
    E'  -- THE MAP. Each entry names the file that reads the view, established by\n'
    || E'  -- grep over src/ and supabase/functions/ on 2026-09-01. This check cannot\n'
    || E'  -- see src/, so these cannot be verified here — only that the view still\n'
    || E'  -- exists, which the migration''s verification asserts.\n';
  v_hdr_new constant text :=
    E'  -- THE MAP. Each entry names the file that reads the view, established by\n'
    || E'  -- grep over src/ and supabase/functions/ on 2026-09-01. This check cannot\n'
    || E'  -- see src/, so these cannot be verified here — only that the view still\n'
    || E'  -- exists, which the migration''s verification asserts.\n'
    || E'  --\n'
    || E'  -- 0334. THIS MAP IS MAINTAINED BY HAND AND GOES STALE ON EVERY NEW\n'
    || E'  -- CONSUMER. It records what src/ read on the day someone grepped it, and\n'
    || E'  -- nothing re-greps. journal_lines_regional proved the point: the map was\n'
    || E'  -- written on 2026-09-01, JournalView.tsx was pointed at that view after,\n'
    || E'  -- and the check spent the next day calling the ledger drill-down dead.\n'
    || E'  -- A view MISSING from this map is reported; a view that stops being read\n'
    || E'  -- but stays in it is NOT. The arm therefore fails towards false alarms\n'
    || E'  -- and away from false silence, which is the safe direction — but read a\n'
    || E'  -- green view arm as "nothing new since the last grep", not as "nothing\n'
    || E'  -- is unread".\n';
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'uninvoked_controls';

  if v_src is null then
    raise exception '0334 FAILED: public.uninvoked_controls does not exist';
  end if;

  if position('journal_lines_regional' in v_src) > 0 then
    raise notice '0334: journal_lines_regional is already in the map, leaving it alone';
    return;
  end if;

  v_hits := (length(v_src) - length(replace(v_src, v_row_anchor, ''))) / length(v_row_anchor);
  if v_hits <> 1 then
    raise exception
      '0334 FAILED: the kpi_dashboard map row appears % times, expected exactly 1 — the map is not where it was, do not guess', v_hits;
  end if;
  v_src := replace(v_src, v_row_anchor, v_row_new);

  v_hits := (length(v_src) - length(replace(v_src, v_hdr_anchor, ''))) / length(v_hdr_anchor);
  if v_hits <> 1 then
    raise exception
      '0334 FAILED: the map header appears % times, expected exactly 1 — refusing to widen the pattern', v_hits;
  end if;
  v_src := replace(v_src, v_hdr_anchor, v_hdr_new);

  execute v_src;
end
$map$;

-- ---------------------------------------------------------------------------
-- PROOF
--
-- (a) journal_lines_regional is no longer reported;
-- (b) the view it names still EXISTS with the columns JournalView.tsx selects.
--     The map entry is a claim about a file this database cannot read; the half
--     it can check is that the object still has the shape the named file asks
--     for. An entry pointing at a dropped or renamed view would be the failure
--     this mechanism exists to avoid (0307);
-- (c) exactly ONE row left the report — read as before − 1, not as a literal;
-- (d) the view arm still reports the views that genuinely have no reader, so an
--     edit that emptied the arm cannot pass (a) and (c) and go unnoticed. This
--     is the positive control: "it stopped complaining" and "it stopped
--     looking" are the same observation without it.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_total  int;
  v_views  int;
  v_cols   int;
begin
  -- (a)
  if exists (select 1 from public.uninvoked_controls() u
              where u.object_name = 'journal_lines_regional') then
    raise exception '0334 FAILED: journal_lines_regional is still reported uninvoked';
  end if;

  -- (b)
  select count(*) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'journal_lines_regional'
     and column_name in ('company_id', 'posting_period', 'journal_entry_id');
  if v_cols <> 3 then
    raise exception
      '0334 FAILED: journal_lines_regional exposes % of the 3 columns JournalView.tsx selects on (company_id, posting_period, journal_entry_id) — the map would be naming a view that no longer has the shape the file asks for', v_cols;
  end if;

  -- (c)
  select count(*) into v_total from public.uninvoked_controls();
  if v_total <> (select total - 1 from _0334_before) then
    raise exception
      '0334 FAILED: uninvoked_controls reports % rows, was % before — exactly one row should have left, so the map edit moved more than it was meant to',
      v_total, (select total from _0334_before);
  end if;

  -- (d)
  select count(*) into v_views from public.uninvoked_controls() where kind = 'view';
  if v_views <> (select views - 1 from _0334_before) then
    raise exception
      '0334 FAILED: the view arm reports % views, was % — it has stopped looking rather than stopped complaining',
      v_views, (select views from _0334_before);
  end if;
  if v_views = 0 then
    raise exception
      '0334 FAILED: the view arm now reports nothing at all. Every remaining unread view would be invisible, which is the silence this check exists to break';
  end if;

  raise notice
    '0334 OK: journal_lines_regional is off the list and still exposes the 3 columns JournalView.tsx selects; uninvoked_controls went % -> % with the view arm % -> %, still naming % genuinely unread view(s).',
    (select total from _0334_before), v_total, (select views from _0334_before), v_views, v_views;
end
$proof$;
