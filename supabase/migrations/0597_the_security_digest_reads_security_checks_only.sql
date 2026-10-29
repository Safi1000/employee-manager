-- 0597 — the security digest reads security checks only
--
-- Shayan, 29 Oct 2026: "yes". Two faults in 0596's red_checks, one cause:
--
--   * It called ledger_checks(), all 49 checks. That takes 8.9 s on GGS and
--     PostgREST cancels a request at 8 s, so "Email me this now" failed with
--     "security_digest: canceling statement due to statement timeout".
--   * Fourteen were red on the first run, nearly all accounting (AR control,
--     cash control, payroll accrual …) with their own screens and owners. In a
--     security email they bury the one line that matters.
--
-- red_checks now evaluates the six security checks itself, each exactly as
-- ledger_checks() does — a count of the same function's rows, with the same
-- filter — so the digest and the nightly run cannot disagree about a figure:
--
--   no_security_gap                        security_gaps()
--   every_demanded_permission_is_grantable permission_key_gaps()
--   no_definer_function_crosses_a_branch   branch_guard_gaps() shape 'writes'
--   no_invoker_writes_an_owner_only_table  invoker_owner_only_writes()
--   tenant_guard_covers_every_parameter    tenant_guard_gaps()
--   migration_ledger_matches_repo          migration_ledger_drift()
--
-- checks_evaluated (the canary) is not among them: it means something only
-- over the whole suite, which still runs nightly.
--
-- Surgery against the live definition, the anchor asserted exactly once; a
-- second run finds it already replaced and changes nothing.
--
-- Asserted, on what can break: the digest answers in under 4 s, and each of
-- the six agrees with ledger_checks()' own row for it — red in one exactly
-- when red in the other, with the same count.

do $surgery$
declare
  v_def text := pg_get_functiondef('public.security_digest(uuid, integer)'::regprocedure);
  v_old constant text := $old$      'red_checks', coalesce((
        select jsonb_agg(jsonb_build_object('check', c.check_name, 'actual', c.actual, 'expected', c.expected))
          from public.ledger_checks(p_company_id) c where not c.passed), '[]'::jsonb),$old$;
  v_new constant text := $new$      'red_checks', coalesce((  -- 0597: the six security checks, as ledger_checks() counts them
        select jsonb_agg(jsonb_build_object('check', s.check_name, 'actual', s.n, 'expected', 0))
          from (select 'no_security_gap'::text check_name, (select count(*) from public.security_gaps()) n
                union all select 'every_demanded_permission_is_grantable', (select count(*) from public.permission_key_gaps())
                union all select 'no_definer_function_crosses_a_branch', (select count(*) from public.branch_guard_gaps() b where b.shape = 'writes')
                union all select 'no_invoker_writes_an_owner_only_table', (select count(*) from public.invoker_owner_only_writes())
                union all select 'tenant_guard_covers_every_parameter', (select count(*) from public.tenant_guard_gaps())
                union all select 'migration_ledger_matches_repo', (select count(*) from public.migration_ledger_drift())) s
         where s.n > 0), '[]'::jsonb),$new$;
  v_n int;
begin
  if position('-- 0597: the six security checks' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_n <> 1 then raise exception '0597 REFUSED: the anchor appears % times in security_digest, not once.', v_n; end if;
  execute replace(v_def, v_old, v_new);
end $surgery$;

do $test$
declare v_d jsonb; v_t timestamptz; v_ms numeric; v_bad text; v_seen int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);
  v_t := clock_timestamp();
  v_d := public.security_digest('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 7);
  v_ms := extract(epoch from clock_timestamp() - v_t) * 1000;
  if v_ms > 4000 then raise exception '0597 REFUSED: the digest took % ms; the API allows 8000.', round(v_ms); end if;

  select count(*),
         string_agg(l.check_name || ' ledger=' || l.actual || ' digest=' || coalesce(r->>'actual', '0'), '; ')
           filter (where l.actual is distinct from coalesce((r->>'actual')::numeric, 0))
    into v_seen, v_bad
    from public.ledger_checks('7f7899a0-edd2-4491-a40d-f81b54c68d1e') l
    left join jsonb_array_elements(v_d->'red_checks') r on r->>'check' = l.check_name
   where l.check_name in ('no_security_gap', 'every_demanded_permission_is_grantable', 'no_definer_function_crosses_a_branch',
                          'no_invoker_writes_an_owner_only_table', 'tenant_guard_covers_every_parameter', 'migration_ledger_matches_repo');
  perform set_config('request.jwt.claims', '{}', true);
  if v_seen <> 6 then raise exception '0597 REFUSED: ledger_checks has % of the six check names, not 6.', v_seen; end if;
  if v_bad is not null then raise exception '0597 REFUSED: the digest and ledger_checks disagree: %.', v_bad; end if;
  if jsonb_array_length(v_d->'red_checks') > 6 then raise exception '0597 REFUSED: red_checks lists more than the six.'; end if;
end $test$;
