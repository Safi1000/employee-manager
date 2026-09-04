-- 0374 — audit_log accepts an insert from the company member whose action is
--        being audited.
--
-- ===========================================================================
-- THE DEFECT
-- ===========================================================================
--
-- audit_log has RLS on and exactly two policies: `company_members_read` and
-- `ssa_all`. There is no INSERT policy. Every audit row on this database has
-- been written by a SECURITY DEFINER function or a trigger, because those are
-- the only writers a policy-less table has.
--
-- That held only as long as everything that audits was definer. The moment a
-- function is converted to SECURITY INVOKER — which is what 0375/0376 are for,
-- and what 0366 and 0371 already did — its audit write is refused, and the
-- whole action rolls back with it.
--
-- ===========================================================================
-- COMPANY MEMBERS, NO PERMISSION KEY
-- ===========================================================================
--
-- AN AUDIT ROW IS WRITTEN BECAUSE AN ACTION HAPPENED. The actor should not need
-- a separate permission to be audited, and requiring one would mean the audit
-- fails exactly when somebody does something they were only just allowed to do
-- — the case the log exists for. Same reasoning as 0371's receipt carve-out: a
-- record of an act is part of the act.
--
-- INSERT ONLY. company_members_read already governs reading, and it stays the
-- only way in: nothing here grants UPDATE or DELETE, so a member can add to the
-- log and cannot edit or erase it. An append-only audit trail is the property
-- worth protecting, and this preserves it exactly.
--
-- The company predicate is still enforced — a member can only write a row for
-- their own company, the same as every other table.

do $$
declare v_ins int; v_read int;
begin
  select count(*) into v_ins from pg_policies
   where schemaname='public' and tablename='audit_log' and cmd in ('INSERT','ALL')
     and policyname <> 'ssa_all';
  if v_ins <> 0 then
    raise exception
      '0374 REFUSED: audit_log already has % non-ssa insert-capable polic(ies). It was recorded as having none.', v_ins;
  end if;
  select count(*) into v_read from pg_policies
   where schemaname='public' and tablename='audit_log' and policyname='company_members_read';
  if v_read <> 1 then
    raise exception '0374 REFUSED: company_members_read is missing from audit_log; this migration assumes it governs reads.';
  end if;
end $$;

create policy company_members_write on public.audit_log for insert
  to authenticated
  with check (company_id = current_company_id());

comment on table public.audit_log is
  '0374: append-only. company_members_read governs reading; company_members_write allows a member to INSERT a row for their own company and nothing else — no UPDATE, no DELETE, so the trail cannot be edited or erased. No permission key: an audit row is written because an action happened, and requiring a key would fail the audit exactly when someone does something they were only just allowed to do.';

-- ---------------------------------------------------------------------------
-- PROVE IT: insert is now possible for a member, and the trail is still
-- append-only. The second half is the one worth asserting — a policy added
-- carelessly as FOR ALL would look identical here and would quietly make the
-- log editable.
-- ---------------------------------------------------------------------------
do $$
declare v_ins int; v_mut int;
begin
  select count(*) into v_ins from pg_policies
   where schemaname='public' and tablename='audit_log'
     and policyname='company_members_write' and cmd='INSERT';
  if v_ins <> 1 then raise exception '0374 FAILED: the insert policy is not present as INSERT.'; end if;

  select count(*) into v_mut from pg_policies
   where schemaname='public' and tablename='audit_log'
     and cmd in ('UPDATE','DELETE','ALL') and policyname <> 'ssa_all';
  if v_mut <> 0 then
    raise exception
      '0374 FAILED: % polic(ies) now permit UPDATE or DELETE on audit_log. The trail must stay append-only.', v_mut;
  end if;
  raise notice '0374: audit_log is insertable by members and still append-only.';
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
    raise exception '0374 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
