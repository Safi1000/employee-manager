-- 0231 — Put a retention date on the branch-realign backup, on the object itself.
--
-- NOT APPLIED. Written only.
--
-- `employee_branch_realign_backup_20260618` was secured by 0111 (RLS + an
-- ssa_only policy), which closed the exposure — that migration existed ONLY in
-- the database until 2026-08-31, so any environment built from repo state before
-- then had the table anon-readable. Whether such an environment exists is not
-- answerable from the repo.
--
-- Dropping beats RLS-ing, but not yet, and not on an open-ended condition. An
-- undated "drop it when nothing needs it" becomes permanent by default.
--
-- The date is anchored, not arbitrary. The table backs up a branch realignment
-- performed 2026-06-18, days before FY26 close on 30 June, so the realigned
-- attribution is already baked into the FY26 accounts. The last moment anyone
-- would plausibly need to reconstruct PRE-realignment branch attribution is the
-- FY26 return filing, due 31 December 2026 in Pakistan. After that no filing,
-- audit or partner statement reaches back through it.
--
-- The date lives in a comment ON THE TABLE, not only in a doc: a comment travels
-- with the object, a doc gets missed.
--
-- If the FY26 return has not been filed and accepted by then, slip this to
-- 31 March 2027 — but slip it EXPLICITLY by editing this comment, never by
-- letting the date pass unremarked.

do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public'
               and table_name = 'employee_branch_realign_backup_20260618') then
    execute $c$
      comment on table public.employee_branch_realign_backup_20260618 is
        'TEMPORARY. Backup of the 2026-06-18 branch realignment. Secured by migration 0111 (RLS, ssa_only). DROP ON OR AFTER 2026-12-31, once the FY26 return is filed — the realigned attribution is already in the FY26 accounts and nothing after that filing reads pre-realignment attribution. If the return slips, edit this comment with a new explicit date; do not let it pass silently.'
    $c$;
  end if;
end $$;
