-- NNNN — <one line saying what changes, in the present tense>
--
-- Copy this file, do not edit it in place. It lives in scripts/ rather than
-- supabase/migrations/ on purpose: check-migrations.mjs globs every .sql in the
-- migrations directory and would report a template there as "in repo, not
-- recorded" for ever.
--
-- ===========================================================================
-- THE HEADER IS PART OF THE MIGRATION
-- ===========================================================================
--
-- Say what was wrong, how it was found, what was measured before, and what a
-- reader six months from now would otherwise have to rediscover. Every hard
-- lesson in this project cost a day and is written down exactly once.
--
-- ===========================================================================
-- SURGERY, NOT RESTATEMENT
-- ===========================================================================
--
-- A function edited by more than one migration has NO canonical file. Amend it
-- against pg_get_functiondef with an anchor whose occurrence count is asserted
-- FIRST, and refuse when the count is not what you expected rather than
-- widening the anchor until it matches.
--
--   do $$
--   declare v_def text; v_new text; v_hits int;
--     a text := '<the exact text you are replacing>';
--   begin
--     select pg_get_functiondef(p.oid) into v_def
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = '<fn>';
--     if v_def is null then raise exception 'NNNN REFUSED: <fn> does not exist.'; end if;
--     v_hits := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
--     if v_hits <> 1 then
--       raise exception 'NNNN REFUSED: anchor appears %, expected 1.', v_hits;
--     end if;
--     execute replace(v_def, a, '<the replacement>');
--   end $$;
--
-- AND FIX EVERY CALL SITE, NOT THE ONE YOU CAME FOR. 0359 corrected one
-- session-scoped reader in partnership_allocation and left two more; 0360 found
-- them only because an unrelated probe failed. Fixing one call site in a
-- function proves nothing about the function.


-- <the change itself>


-- ===========================================================================
-- REQUIRED TAIL — both blocks. A migration is refused before it is applied if
-- the tenant-guard assertion is missing (scripts/migration-ledger.mjs guard).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE CANARY, IF THIS MIGRATION ADDS OR REMOVES A CHECK.
--
-- Delete this block if it does neither. Do NOT write the new count as a literal
-- you believe to be right: read the row count before, apply the arm, read it
-- after, and assert the difference. ledger_checks' own expected_check_count is
-- moved by surgery on its anchor, exactly like any other function edit.
-- ---------------------------------------------------------------------------
-- do $$
-- declare
--   v_def text; v_new text; v_hits int; v_before int; v_after int; v_co uuid;
--   a_cnry text := '(select <N>::numeric n) e (n);   -- expected_check_count';
-- begin
--   select pg_get_functiondef(p.oid) into v_def
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'ledger_checks';
--   v_hits := (length(v_def) - length(replace(v_def, a_cnry, ''))) / length(a_cnry);
--   if v_hits <> 1 then raise exception 'NNNN REFUSED: canary anchor appears %, expected 1', v_hits; end if;
--
--   select id into v_co from public.companies order by created_at limit 1;
--   select count(*) into v_before from public.ledger_checks(v_co);
--
--   v_new := replace(v_def, '<the arm anchor>', '<the new arm>' || '<the arm anchor>');
--   v_new := replace(v_new, a_cnry, '(select <N+1>::numeric n) e (n);   -- expected_check_count');
--   execute v_new;
--
--   select count(*) into v_after from public.ledger_checks(v_co);
--   if v_after <> v_before + 1 then
--     raise exception 'NNNN FAILED: ledger_checks returned % rows, expected %.', v_after, v_before + 1;
--   end if;
-- end $$;

-- ---------------------------------------------------------------------------
-- 2. THE TENANT GUARD ASSERTION. NOT OPTIONAL.
--
-- Four guard regressions so far — 0348 fixed two, 0352 one, 0363 the fourth —
-- every one of them a guard that was written correctly and then never checked
-- against the detector that has to be able to READ it. Being right is not the
-- same as being verifiable, and tenant_guard_covered() matches on the parameter
-- name appearing inside the guard call.
--
-- So: assert on tenant_guard_gaps() rather than on your reading of your own
-- source. If this fails, resolve the company INSIDE the guard call and put the
-- guard ahead of every read — do not add an exemption. Exemptions exist for
-- polymorphic ids whose table is a text argument and which therefore cannot be
-- spelled visibly at all.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      'NNNN REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see.',
      v_n, v_who;
  end if;
end $$;
