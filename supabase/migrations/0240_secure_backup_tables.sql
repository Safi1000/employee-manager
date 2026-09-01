-- 0240 — Close public access to two backup tables.
--
-- SECURITY FIX. Applied to dev and, by named approval, to production.
--
-- WHAT WAS OPEN
--
-- `deployments_overlap_backup_0183` and `org_copy_map_0186` had RLS switched
-- OFF entirely and granted SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER
-- and TRUNCATE to `anon` and `authenticated`.
--
-- The anon key ships in the browser bundle. It is public by design. So both
-- tables were readable — and truncatable — by anyone who has ever loaded the
-- application, with no account required.
--
--   deployments_overlap_backup_0183   43 rows, carries company_id,
--                                     GUARDS AND GUIDES (PVT) LTD deployment data
--   org_copy_map_0186                 4,679 rows, old_id -> new_id mapping
--
-- These are the only two tables in `public` with RLS disabled. Every other
-- table has it enabled. `employee_branch_realign_backup_20260618` carries the
-- same grants but was secured by 0111 with an `ssa_only` policy; these two
-- never got the same treatment, and nothing recorded that they had not.
--
-- WHY REVOKING IS SAFE
--
-- Four functions reference these tables. Checked before revoking, not after:
--
--   change_client           SECURITY DEFINER, owner postgres
--   change_guard_shift      SECURITY DEFINER, owner postgres
--   record_separation       SECURITY DEFINER, owner postgres
--   sync_attendance_0188    NOT definer — but it is a one-off data-migration
--                           RPC that raises unless session_replication_role is
--                           'replica', which only a superuser can set. It is
--                           not on any application path.
--
-- The three definer functions run as `postgres`, which owns both tables, so
-- they are unaffected by grants to `anon` and — with no FORCE ROW LEVEL
-- SECURITY anywhere in this schema — unaffected by RLS as well.
--
-- No view, no foreign key and no frontend code references either table.
--
-- WHY NO POLICY IS ADDED
--
-- RLS enabled with zero policies denies everything to every non-owner role.
-- That is the correct end state for a backup table with no application
-- purpose: the definer functions above reach it as owner, and nothing else
-- should reach it at all. 0111 added an `ssa_only` policy to its backup table;
-- that is a weaker position and is not copied here, because with the grants
-- revoked there is no PostgREST path to reach a policy through anyway.
--
-- STILL OPEN, DELIBERATELY
--
-- Whether these tables are needed at all. Dropping beats securing — the same
-- reasoning as 0111's retention date — but the three definer functions above
-- write to `deployments_overlap_backup_0183`, so it is not dead yet, and
-- `org_copy_map_0186` is the audit trail of the guards-n-guides org clone.
-- Retiring them is a separate decision with a date attached, not a side effect
-- of a security fix.

revoke all on public.deployments_overlap_backup_0183 from anon, authenticated;
revoke all on public.org_copy_map_0186              from anon, authenticated;
revoke all on public.deployments_overlap_backup_0183 from public;
revoke all on public.org_copy_map_0186              from public;

alter table public.deployments_overlap_backup_0183 enable row level security;
alter table public.org_copy_map_0186                enable row level security;

-- Assert the close actually closed. A revoke that silently did nothing is the
-- worst outcome here, because it reads as a fix in the migration log.
do $verify$
declare
  v_grants text;
  v_open   text;
begin
  select string_agg(distinct table_name || '/' || grantee || '/' || privilege_type, ', ')
    into v_grants
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('deployments_overlap_backup_0183', 'org_copy_map_0186')
     and grantee in ('anon', 'authenticated', 'PUBLIC');

  if v_grants is not null then
    raise exception '0240 did not close the grants — still present: %', v_grants
      using errcode = '42501';
  end if;

  select string_agg(c.relname, ', ')
    into v_open
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('deployments_overlap_backup_0183', 'org_copy_map_0186')
     and not c.relrowsecurity;

  if v_open is not null then
    raise exception '0240 did not enable RLS on: %', v_open using errcode = '42501';
  end if;
end
$verify$;
