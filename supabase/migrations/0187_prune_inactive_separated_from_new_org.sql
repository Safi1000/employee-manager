-- 0187: drop the dead separated records from the "guards n guides" clone.
--
-- Scope, as agreed: an employee in the NEW org only, who is
--     • separated (fired / terminated / left / absconded), AND
--     • has no attendance row at all (the clone only carries August, so this
--       means "did nothing in August"), AND
--     • has no deployment row at all.
--
-- That last condition is what keeps this safe. 173 separated employees have no
-- August attendance, but 157 of them DO carry posting history — deleting those
-- would destroy 162 deployment records documenting where real people actually
-- stood, which is precisely the history the clone exists to preserve. Requiring
-- "no deployment either" narrows it to 16 people who appear nowhere in the
-- operational record: their employee row is the only thing they have.
--
-- Cascades: employees→employee_salary_history is ON DELETE CASCADE, so 8 salary
-- rows go with them. Nothing else is attached — verified that no remaining
-- employee lists any of the 16 as referred_by_employee_id (NO ACTION, would
-- have blocked) or reporting_to_employee_id (SET NULL, would have silently
-- blanked a manager).
--
-- SCOPED TO THE NEW COMPANY BY ID. The source org keeps every one of these
-- records; nothing here can reach it.
--
-- Triggers are left ON deliberately, unlike the clone in 0186 — the audit rows
-- this writes are a wanted record of the deletion, and no trigger blocks it.
--
-- APPLIED to production 2026-08-13.

do $$
declare
  v_new uuid;
  v_emp int;
  v_sal int;
begin
  select id into v_new from public.companies where name = 'guards n guides';
  if v_new is null then
    raise exception 'Company "guards n guides" not found - refusing to delete anything.';
  end if;

  create temp table prune_0187 on commit drop as
  select s.id
    from public.employees s
   where s.company_id = v_new
     and s.lifecycle_state in ('terminated','fired','left','absconded')
     and not exists (select 1 from public.attendance_records a where a.employee_id = s.id)
     and not exists (select 1 from public.deployments d where d.guard_id = s.id);

  select count(*) into v_emp from prune_0187;

  -- Refuse to run if the set is not the size that was reviewed. A clone that
  -- has since been edited, or a mistargeted company, would otherwise delete a
  -- different set of people than the one that was signed off.
  if v_emp <> 16 then
    raise exception 'Expected 16 employees to prune, found % - aborting.', v_emp;
  end if;

  select count(*) into v_sal
    from public.employee_salary_history
   where employee_id in (select id from prune_0187);

  delete from public.employees where id in (select id from prune_0187);

  raise notice 'Pruned % employees and % cascaded salary rows from %', v_emp, v_sal, v_new;
end $$;
