-- 0332 — applied_migration_digests() normalises the recorded SQL the same way
-- check-migrations.mjs normalises the file.
--
-- THE ASYMMETRY. Two halves of one comparison disagree about what counts as a
-- difference:
--
--   applied_migration_digests()   md5(array_to_string(statements, E'\n'))
--                                 no trimming at all
--   check-migrations.mjs          readFileSync(...).replace(/\r/g, "")
--                                                  .replace(/\n+$/, "")
--
-- So a migration whose recorded text carries the file's trailing newline
-- records one byte the checker has already removed from the other side, and the
-- two digests differ for ever after. The file is not wrong, the SQL is not
-- wrong, and nothing is drifting — but the checker says `recorded SQL != file`,
-- which is the failure mode its own header warns about: a checker that cries
-- wolf is a checker nobody reads.
--
-- THIS IS NOT HYPOTHETICAL. Measured today, before this file:
--
--   production   38 of 353 rows with recorded SQL end in a newline, 1 contains \r
--   dev          17 of 95
--
-- Some of those are baselined and never compared. The rest are false
-- mismatches, and every future apply that transmits a file's trailing newline
-- adds another.
--
-- WHICH SIDE CHANGES, AND WHY IT IS THIS ONE. Only one direction is safe:
--
--   Change the CHECKER to stop trimming the file, and every migration whose
--   recorded text lacks the trailing newline — the overwhelming majority, since
--   almost every file ends in one — starts failing. That converts a handful of
--   false mismatches into hundreds.
--
--   Change the FUNCTION to trim, and the comparison becomes trailing-whitespace
--   insensitive on both sides.
--
-- The second is also MONOTONE, which is the property worth stating: trimming
-- the recorded side can only turn a mismatch into a match, never the reverse.
-- A row whose recorded text has no trailing newline and no \r is untouched; a
-- row that has them was already mismatching. And it cannot hide real drift,
-- because trailing whitespace is not a difference in SQL — two files that
-- differ only there describe the same migration.
--
-- Note what this does NOT do: it does not rewrite a single recorded row. The
-- stored `statements` stay exactly as they were applied, which is the whole
-- point of storing them. Only the comparison changes.
--
-- SURGERY. applied_migration_digests() has three authors — 0229 wrote it, 0241
-- revoked anon's execute, 0283 amended it — so CLAUDE.md forbids restating it
-- from any one file. The anchor is the md5 expression itself, asserted to
-- appear exactly once.

do $surgery$
declare
  v_src text;
  v_hits int;
  v_anchor constant text := $a$md5(array_to_string(m.statements, E'\n'))$a$;
  v_new    constant text := $a$md5(regexp_replace(replace(array_to_string(m.statements, E'\n'), E'\r', ''), E'\n+$', ''))$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'applied_migration_digests';

  if v_src is null then
    raise exception
      '0332 FAILED: public.applied_migration_digests does not exist. It is created by 0229; this file only amends it.';
  end if;

  if position('regexp_replace' in v_src) > 0 then
    raise notice '0332: applied_migration_digests already normalises, leaving it alone';
    return;
  end if;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      '0332 FAILED: the md5 expression appears % times in applied_migration_digests, expected exactly 1 — do not widen the anchor until it matches', v_hits;
  end if;

  execute replace(v_src, v_anchor, v_new);
end
$surgery$;

-- ---------------------------------------------------------------------------
-- PROOF
--
-- The interesting assertion is MONOTONICITY, not "the digests changed". A
-- migration that changed digests arbitrarily would also pass a test that only
-- checked they moved. So:
--
--   (a) the function still answers one row per recorded migration, naming every
--       one — the surgery did not narrow the query;
--   (b) every row whose digest changed had trailing newlines or a \r in its
--       recorded text, and every row that had neither is UNCHANGED. That is
--       monotonicity stated as a property rather than as a count;
--   (c) the number that changed is READ and reported, not asserted against a
--       literal — dev and production hold different numbers (17 and 38 when
--       this was written) and a literal would refuse on one of them for a
--       reason having nothing to do with correctness (0304/0310/0327);
--   (d) the new digest equals what the checker computes for text that is
--       already normalised — proved by feeding a known string through both
--       shapes rather than by inspection.
--
-- (b) IS COMPUTED WITHOUT JOINING THE FUNCTION'S OUTPUT BY NAME, and that is
-- not a stylistic choice. Production carries one DUPLICATED name —
-- `fix_cheque_treasury_company_scope`, recorded twice — and a name join turns
-- those 2 rows into 4 pairs, two of which compare one row's old digest against
-- the other's new one. The first version of this proof did exactly that and
-- refused on production, reporting two clean rows as having moved. The proof
-- was wrong, not the change. check-migrations.mjs already declines to compare a
-- duplicated key (`if (rs.length !== 1) continue`); this proof now does the
-- same, by not joining on one.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_rows      int;
  v_expected  int;
  v_changed   int;
  v_dirty     int;
  v_bad       int;
  v_probe     text := 'select 1;' || E'\r\n\n\n';
begin
  -- (a)
  select count(*) into v_rows     from public.applied_migration_digests();
  select count(*) into v_expected from supabase_migrations.schema_migrations;
  if v_rows <> v_expected then
    raise exception
      '0332 FAILED: applied_migration_digests() returns % rows but schema_migrations holds % — the surgery changed the query, not just the digest', v_rows, v_expected;
  end if;
  if exists (
    select 1 from supabase_migrations.schema_migrations m
     where not exists (select 1 from public.applied_migration_digests() d where d.name = m.name))
  then
    raise exception '0332 FAILED: applied_migration_digests() no longer names every recorded migration';
  end if;

  -- (b) and (c), on schema_migrations directly. See the header note above.
  with t as (
    select array_to_string(m.statements, E'\n') as s
      from supabase_migrations.schema_migrations m
     where m.statements is not null
  ), n as (
    select s,
           regexp_replace(replace(s, E'\r', ''), E'\n+$', '') as ns,
           (s ~ E'\n+$' or position(E'\r' in s) > 0) as dirty
      from t
  )
  select count(*) filter (where md5(s) is distinct from md5(ns)),
         count(*) filter (where dirty),
         count(*) filter (where md5(s) is distinct from md5(ns) and not dirty)
    into v_changed, v_dirty, v_bad
    from n;

  if v_bad > 0 then
    raise exception
      '0332 FAILED: % row(s) changed digest despite having no trailing newline and no carriage return — the change is not monotone and may be hiding real drift', v_bad;
  end if;
  if v_changed <> v_dirty then
    raise exception
      '0332 FAILED: % row(s) changed digest but % row(s) carry trailing whitespace — those two must be the same set', v_changed, v_dirty;
  end if;

  -- (b2) and the FUNCTION returns that normalised digest for every recorded
  --      migration. Stated as set membership, which a duplicated name cannot
  --      distort the way a join does.
  if exists (
    select 1 from supabase_migrations.schema_migrations m
     where m.statements is not null
       and not exists (
         select 1 from public.applied_migration_digests() d
          where d.name = m.name
            and d.digest = md5(regexp_replace(
                  replace(array_to_string(m.statements, E'\n'), E'\r', ''), E'\n+$', ''))))
  then
    raise exception
      '0332 FAILED: applied_migration_digests() does not return the normalised digest for every recorded migration';
  end if;

  -- (d) the normalisation is the checker's, demonstrated rather than asserted.
  if md5(regexp_replace(replace(v_probe, E'\r', ''), E'\n+$', '')) <> md5('select 1;') then
    raise exception
      '0332 FAILED: the normalisation does not reduce a CRLF-and-trailing-newline string to its bare form';
  end if;
  if md5(regexp_replace(replace('select 1;', E'\r', ''), E'\n+$', '')) <> md5('select 1;') then
    raise exception
      '0332 FAILED: the normalisation altered a string that was already clean';
  end if;

  raise notice
    '0332 OK: applied_migration_digests() names all % recorded migrations; % row(s) carried trailing newlines or a carriage return and exactly those % changed digest; no clean row moved.',
    v_rows, v_dirty, v_changed;
end
$proof$;

comment on function public.applied_migration_digests() is
  'Recorded migration SQL, digested. 0332: normalised the way check-migrations.mjs normalises the file — \r removed, trailing newlines stripped — so the two halves of the comparison agree about what counts as a difference. The stored statements are not rewritten.';
