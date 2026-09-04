-- 0366 — assert_branch_writable(), and post_manual_journal stops accepting a
--        region it was handed without checking whose it is.
--
-- ===========================================================================
-- THE DEFECT
-- ===========================================================================
--
-- post_manual_journal takes p_branch_id, stamps it onto the journal entry, and
-- validates only that the branch belongs to the same COMPANY:
--
--   perform public.assert_same_company(
--     (select company_id from public.branches where id = p_branch_id));
--
-- The company is not the boundary being crossed. A user tied to ISB/RWP can
-- hand it Lahore's branch id and the entry lands in Lahore's P&L, in
-- regional_pl_range, and in every regional report drawn from it. Nothing
-- refuses, because the branch does belong to the company.
--
-- It writes no branch_scope table — the entry goes to journal_entries and
-- journal_lines through post_journal, and neither carries branch_scope — so no
-- policy was ever going to catch this. The branch is a PARAMETER here, and a
-- parameter has to be asserted; there is nothing for it to be inherited from.
--
-- ===========================================================================
-- ONE HELPER, MIRRORING THE POLICY IT CANNOT BE
-- ===========================================================================
--
-- assert_branch_writable() states the same predicate the twelve branch_scope
-- policies state:
--
--   (not is_branched_user()) or is_super_super_admin() or branch = current_branch_id()
--
-- and that is a second statement of a rule, which this project normally
-- refuses. It is justified here and only here: a SECURITY DEFINER body is NOT
-- subject to the caller's policies, so the policy is off for the whole call
-- and cannot be the thing that enforces it. The alternative is not "reuse the
-- policy" — the alternative is no check at all.
--
-- One helper, not a check per RPC, so there is one definition to correct if the
-- rule ever changes. NULL passes: an unregioned journal entry is legitimate and
-- always has been.
--
-- The right long-term answer for functions whose branch is a property of a ROW
-- rather than a parameter is SECURITY INVOKER, which brings branch_scope back
-- and needs no helper. That is record_invoice_payment's shape, not this one.
--
-- ===========================================================================
-- THE TENANT CHECK IS FIRST, AND IT IS HERE BECAUSE THE DETECTOR SAID SO
-- ===========================================================================
--
-- The first attempt at this migration was refused by its own required tail:
--
--   0366 REFUSED: tenant_guard_gaps() reports 1 gap: assert_branch_writable.p_branch_id
--
-- A definer function taking a uuid with no assert_same_company covering it. It
-- leaked nothing — a foreign branch would simply fail the equality below — but
-- the rule from 0363 is that an exemption is for something that CANNOT be
-- spelled visibly, and this could.
--
-- Spelling it made the function better rather than merely quieter. A branch
-- belonging to another COMPANY is now refused loudly instead of falling through
-- to "not mine", and the tenant check runs BEFORE the unbranched early return,
-- so it applies to every caller rather than only to branched ones.

create or replace function public.assert_branch_writable(p_branch_id uuid)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- An unregioned row is legitimate. Head-office journal entries carry no
  -- branch, and refusing NULL here would break them.
  if p_branch_id is null then return; end if;

  -- tenant guard [resolved, 0287]: owning company looked up from p_branch_id
  -- via public.branches. FIRST, and before the early returns below, so a branch
  -- from another company is refused for every caller and not just branched ones.
  perform public.assert_same_company(
    (select b.company_id from public.branches b where b.id = p_branch_id));

  -- Nobody to constrain: an unbranched user is scoped by the company alone,
  -- which is exactly what the branch_scope policies say.
  if not public.is_branched_user() then return; end if;
  if public.is_super_super_admin() then return; end if;

  if p_branch_id = public.current_branch_id() then return; end if;

  raise exception
    'You are assigned to one region and this action names another. Nothing has been recorded.'
    using errcode = '42501',
          hint = 'The branch handed in does not match the caller''s own branch.';
end;
$fn$;

comment on function public.assert_branch_writable(uuid) is
  '0366: refuses a branch id that is not the caller''s own, and one that is not the caller''s company''s at all. Mirrors the branch_scope policy predicate deliberately — a SECURITY DEFINER body is not subject to policies, so the policy cannot be what enforces this and the alternative is no check at all. NULL passes: an unregioned row is legitimate. For functions whose branch is a property of a row rather than a parameter, SECURITY INVOKER is the better answer and needs no helper.';

revoke execute on function public.assert_branch_writable(uuid) from public, anon;
grant execute on function public.assert_branch_writable(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Surgery. post_manual_journal has been written by more than one migration, so
-- it is amended against pg_get_functiondef with the anchor count asserted.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def  text;
  v_hits int;
  a_chk  text := '    if p_branch_id is not null then perform public.assert_same_company((select company_id from public.branches where id = p_branch_id)); end if;';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_manual_journal';
  if v_def is null then raise exception '0366 REFUSED: post_manual_journal does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_chk, ''))) / length(a_chk);
  if v_hits <> 1 then
    raise exception
      '0366 REFUSED: the branch company-check anchor appears % time(s), expected exactly 1.', v_hits;
  end if;

  execute replace(v_def, a_chk,
    a_chk || chr(10) ||
    '    -- 0366: the company was never the boundary here. A branched caller can' || chr(10) ||
    '    -- hand in another region''s branch and it belongs to the company too.' || chr(10) ||
    '    perform public.assert_branch_writable(p_branch_id);');

  raise notice '0366: post_manual_journal now asserts the branch it was handed.';
end $$;

-- ---------------------------------------------------------------------------
-- PROVE IT AGAINST THE DETECTOR, not against my reading of the source.
--
-- 0363's lesson: a guard can be correct and still invisible to the thing whose
-- job is to find missing guards. branch_guard_gaps() must now agree.
-- ---------------------------------------------------------------------------
do $$
declare v_n int;
begin
  select count(*) into v_n from public.branch_guard_gaps()
   where function_name = 'post_manual_journal';
  if v_n <> 0 then
    raise exception
      '0366 FAILED: branch_guard_gaps() still reports post_manual_journal. The guard is present but the detector cannot see it, which is the 0363 defect again.';
  end if;
  raise notice '0366: branch_guard_gaps() no longer reports post_manual_journal.';
end $$;

-- ---------------------------------------------------------------------------
-- And prove the refusal actually refuses, by borrowing a branched user's claim.
-- GGS has two branched profiles; both are hr and hold no finance permission,
-- which is exactly the caller this guard exists for.
--
-- The own-branch and NULL cases are asserted too. Without them a guard that
-- refused EVERYTHING would pass the refusal test and break every caller.
-- ---------------------------------------------------------------------------
do $probe$
declare
  v_uid    uuid;
  v_mine   uuid;
  v_other  uuid;
  v_raised text := '(nothing raised)';
begin
  select p.id, p.branch_id into v_uid, v_mine
    from public.profiles p
   where p.branch_id is not null
   order by p.created_at limit 1;

  if v_uid is null then raise notice '0366: no branched profile; refusal probe skipped.'; return; end if;

  select b.id into v_other from public.branches b
   where b.id <> v_mine
     and b.company_id = (select company_id from public.branches where id = v_mine)
   limit 1;
  if v_other is null then raise notice '0366: only one branch; refusal probe skipped.'; return; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);

  begin
    perform public.assert_branch_writable(v_other);
  exception when others then
    v_raised := sqlerrm;
  end;

  perform public.assert_branch_writable(v_mine);
  perform public.assert_branch_writable(null::uuid);

  perform set_config('request.jwt.claims', '', true);

  if v_raised not like '%names another%' then
    raise exception
      '0366 FAILED: a branched user was allowed to name another region. Got: %', v_raised;
  end if;
  raise notice '0366: another region refused, own region and NULL allowed.';
end;
$probe$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception '0366 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
