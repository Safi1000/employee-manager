-- 0592 — the regional scorecard is read by whoever may open it
--
-- Shayan, 29 Oct 2026: "yes" — to the security sweep's first four fixes. The
-- Supabase security advisor's one ERROR: public.regional_scorecard is a
-- SECURITY DEFINER view (it runs as its owner, so it reads past every table
-- rule 0586/0588 put in place) and `authenticated` may select it. It already
-- holds a login to its own company (current_company_id()), but within GGS any
-- login could read each region's profit this year and last, receivables
-- outstanding and inter-region balance — the figures 0585/0588 gated
-- everywhere else.
--
-- It stays a definer view, and DECIDED so: as an invoker view it would read
-- invoices under 0588's rule and hand a banks.view-only reader a smaller
-- receivables figure that looks right. Instead the rows themselves now require
-- the Regional Scorecard screen's own keys (routes.tsx: reports.view,
-- banks.view), plus accountant.view, which reads the same figures elsewhere.
-- Same columns, same rows for those holders; none for anyone else.
--
-- Asserted: the HR login (none of those keys) reads no row; Shayan reads every
-- row the view held before this migration.

do $v$
declare
  v_before bigint;
  v_def text := pg_get_viewdef('public.regional_scorecard'::regclass);
  a constant text := '  WHERE (company_id = ( SELECT current_company_id() AS current_company_id));';
  v_n int;
begin
  if position('has_perm' in v_def) > 0 then return; end if;   -- replay
  v_n := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
  if v_n <> 1 then raise exception '0592 REFUSED: the company filter appears % times in regional_scorecard.', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);
  select count(*) into v_before from public.regional_scorecard;

  execute 'create or replace view public.regional_scorecard as ' ||
    replace(rtrim(v_def, E'; \n'), rtrim(a, ';'),
      '  WHERE company_id = ( SELECT current_company_id() AS current_company_id)'
      || ' AND (( SELECT has_perm(''reports.view''::text) AS has_perm) OR ( SELECT has_perm(''banks.view''::text) AS has_perm)'
      || ' OR ( SELECT has_perm(''accountant.view''::text) AS has_perm))');

  if (select count(*) from public.regional_scorecard) <> v_before then
    raise exception '0592 REFUSED: Shayan reads % rows, not the % the view held.', (select count(*) from public.regional_scorecard), v_before;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c27a9602-6776-401a-a2c1-d755124b931b', 'role', 'authenticated')::text, true);
  if (select count(*) from public.regional_scorecard) <> 0 then
    raise exception '0592 REFUSED: the HR login still reads % rows.', (select count(*) from public.regional_scorecard);
  end if;
  perform set_config('request.jwt.claims', '{}', true);
end $v$;

comment on view public.regional_scorecard is
  'DECIDED 0592: a definer view (as invoker it would read invoices under 0588 and show banks.view readers a smaller receivables figure); '
  'its rows require reports.view, banks.view or accountant.view — the Regional Scorecard screen''s keys.';
