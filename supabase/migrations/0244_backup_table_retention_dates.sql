-- 0244 — Retention dates on the two tables 0240 secured, on the objects
-- themselves.
--
-- DEV ONLY. The tables were secured on production by named approval (0240);
-- these comments are documentation and go to prod with the next named change.
--
-- Same reasoning as 0231: dropping beats securing, but not on an open-ended
-- condition. An undated "drop it when nothing needs it" becomes permanent by
-- default. The date lives in a comment ON THE TABLE, because a comment travels
-- with the object and a doc gets missed.
--
-- ONE OF THESE TWO IS NOT A BACKUP
--
-- `deployments_overlap_backup_0183` is named like a one-off snapshot and is
-- nothing of the kind. Three SECURITY DEFINER functions — change_client,
-- change_guard_shift and record_separation — still INSERT into it, and the
-- rows prove it: 43 rows spanning 2026-07-24 to 2026-08-25, more than a month
-- after the 0183 migration that created it.
--
-- So it cannot have a drop date, because it is live. What it actually needs is
-- a decision that is not a retention decision at all: either it is an
-- operational overlap log, in which case it should be named and modelled as
-- one and given a real policy rather than a revoke, or the three functions
-- should stop writing to it and the snapshot can then age out. Recording that
-- honestly beats attaching a date that will be silently missed because the
-- table keeps filling up.
--
-- `org_copy_map_0186` IS a backup — 4,679 static old_id -> new_id rows from the
-- guards-n-guides org clone. Its date is anchored the same way 0231's is: the
-- only thing that reads a clone map is a reconstruction of pre-clone identity,
-- and the last event that plausibly needs one is the FY26 return, due
-- 31 December 2026 in Pakistan. Add a margin for the filing to be accepted and
-- any query on it to be answered.

do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'public'
                and table_name = 'deployments_overlap_backup_0183') then
    execute $c$
      comment on table public.deployments_overlap_backup_0183 is
        'NOT A BACKUP DESPITE THE NAME — STILL BEING WRITTEN. change_client, change_guard_shift and record_separation INSERT into this table; rows span 2026-07-24 to 2026-08-25, well after migration 0183. Secured by 0240 (RLS on, all grants to anon/authenticated/PUBLIC revoked; reachable only by its owner, which is how the three definer functions still reach it). NO DROP DATE, because it is live. REVIEW ON OR AFTER 2027-02-28 and decide the real question: either model it as the operational overlap log it is, with a name and an RLS policy to match, or stop the three functions writing to it so it can age out. Do not attach a drop date while it is still filling.'
    $c$;
  end if;

  if exists (select 1 from information_schema.tables
              where table_schema = 'public'
                and table_name = 'org_copy_map_0186') then
    execute $c$
      comment on table public.org_copy_map_0186 is
        'TEMPORARY. Static old_id -> new_id map (4,679 rows) from the guards-n-guides org clone in migration 0186. Secured by 0240 (RLS on, all grants revoked). DROP ON OR AFTER 2027-03-31 — the only thing that reads a clone map is a reconstruction of pre-clone identity, and the last event needing one is the FY26 return due 2026-12-31, plus a quarter for the filing to be accepted and queried. If the return slips, edit this comment with a new explicit date; do not let it pass silently.'
    $c$;
  end if;
end
$$;

-- Both comments must actually be there. A retention date that failed to apply
-- is worse than none: the doc says it exists and the object does not carry it.
do $verify$
declare v_missing text;
begin
  select string_agg(t.table_name, ', ')
    into v_missing
    from information_schema.tables t
   where t.table_schema = 'public'
     and t.table_name in ('deployments_overlap_backup_0183', 'org_copy_map_0186')
     and coalesce(obj_description(('public.' || t.table_name)::regclass, 'pg_class'), '') = '';
  if v_missing is not null then
    raise exception '0244 left % without a retention comment', v_missing;
  end if;
end
$verify$;
