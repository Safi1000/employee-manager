-- 0392 — sync_overpayment_carry_forward() stops claiming the payslip was not
--         saved, because at both of its call sites it already was.
--
-- ===========================================================================
-- A REFUSAL THAT SAYS THE WRONG THING IS ITS OWN DEFECT
-- ===========================================================================
--
-- 0391's two write refusals ended "The payslip has not been saved." Checking
-- the callers rather than assuming them shows that is false at BOTH:
--
--   handleSaveRow  — savePayslip() runs FIRST, then the carry-forward.
--   the disburse path — the money has already MOVED, and the payslip row with
--   it, before the carry-forward is attempted.
--
-- So an operator without payroll.edit would have been told nothing was
-- recorded, at the exact moment a payslip was saved and in one case cash had
-- left the building. That is worse than the silence 0391 replaced: silence
-- leaves you looking, a confident false statement stops you looking.
--
-- The accurate sentence names what happened, what did not, and the consequence
-- that arrives next month if nobody acts. Nothing else changes — same function,
-- same gate, same row-count asserts.
--
-- (Written as its own migration rather than as an edit to 0391 because 0391 has
-- already been applied and recorded. The recorded SQL must equal the file.)

do $$
declare v_src text;
begin
  select public.executable_source(pg_get_functiondef(p.oid)) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'sync_overpayment_carry_forward';
  if v_src is null then
    raise exception '0392 REFUSED: sync_overpayment_carry_forward() does not exist.';
  end if;
  if v_src !~ 'The payslip has not been saved' then
    raise exception
      '0392 REFUSED: the wording this migration corrects is not present. Something has already edited the body.';
  end if;
end $$;

do $$
declare
  v_def text;
  v_new text;
  v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'sync_overpayment_carry_forward';

  -- Two occurrences, one for the update arm and one for the insert arm, and
  -- both are replaced. Counted first: replacing "whatever is there" is how a
  -- body that has changed underneath gets edited blind.
  v_hits := (length(v_def)
             - length(replace(v_def, 'The payslip has not been saved.', ''))) / length('The payslip has not been saved.');
  if v_hits <> 2 then
    raise exception '0392 REFUSED: the phrase appears % time(s), expected 2.', v_hits;
  end if;

  v_new := replace(v_def,
    'The payslip has not been saved.',
    'The payslip IS saved — but the overpayment is NOT carried forward, so it will not be deducted next month. Ask someone with payroll.edit to re-save this payslip.');
  execute v_new;
end $$;

do $$
declare v_src text;
begin
  select public.executable_source(pg_get_functiondef(p.oid)) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'sync_overpayment_carry_forward';

  if v_src ~ 'The payslip has not been saved' then
    raise exception '0392 FAILED: the false sentence survives.';
  end if;
  if v_src !~ 'will not be deducted next month' then
    raise exception '0392 FAILED: the corrected sentence is not present.';
  end if;

  -- The DELETE arm is deliberately NOT changed: it says "Nothing has been
  -- recorded", which is true — an overpayment that fell to zero and could not
  -- have its row removed leaves the row exactly as it was.
  if v_src !~ 'could not be removed' then
    raise exception '0392 FAILED: the delete arm''s message went missing.';
  end if;

  -- And the function still does what it did. A wording migration that broke
  -- the gate or an assert would pass every check above.
  if v_src !~ 'get diagnostics' or v_src !~ 'assert_same_company' then
    raise exception '0392 FAILED: the row-count assert or the tenant guard did not survive the edit.';
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
    raise exception '0392 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
