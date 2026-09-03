-- 0364. THE MIGRATION LEDGER IS CHECKED AGAINST THE REPO, NIGHTLY, BY THE
--       DATABASE ITSELF.
--
-- This is the fifth attempt at the same defect and the first one on the right
-- event. The four before it fired on `git push`:
--
--   * `apply_migration` writes production. The file is committed later, or
--     never. 0240 and 0241 reached prod with the pre-push hook armed in the
--     tree; 0319-0340 reached it while the checkout sat at 0318.
--   * A pre-push hook fires on a different, optional, later action by the same
--     person who already forgot. It cannot fire on a push that does not happen.
--   * The last round made the hook fail loudly instead of skipping silently.
--     That was right and it did not help, because the event was still wrong.
--
-- `run_scheduled_ledger_checks` fires on TIME. Nobody has to do anything for it
-- to run. So the only design question left is how the repo's file list reaches
-- the database without a human in the loop.
--
-- THE ANSWER THAT LOOKS OBVIOUS AND IS WRONG: a table of expected migration
-- names, updated by a commit hook, a CI job, or a deploy step. That is the same
-- defect wearing a different hat -- it re-inserts a human action between "the
-- migration was applied" and "the check knows about it". A deploy is not more
-- reliable than a commit; it is the same person on a different day.
--
-- THE ANSWER HERE: the database fetches the repo's file list from GitHub on a
-- schedule. pg_net is asynchronous, so the fetch is two jobs -- request at
-- 04:30, ingest at 04:45 -- and the suite reads the ingested manifest at 05:00.
--
-- THE FETCH IS UNAUTHENTICATED BY DESIGN. DO NOT ADD A TOKEN.
--
-- Safi1000/employee-manager is public, so the contents API answers without a
-- credential. That is not an oversight to be tidied up later: a token is an
-- expiry, an expiry is a fetch that silently stops working, and the freshness
-- rule below would then turn a lapsed PAT into a nightly red about the wrong
-- thing, 36 hours after the fact and every night until someone rotates it. A
-- control that acquires a credential acquires a way to fail that has nothing to
-- do with what it measures. Sixty unauthenticated requests an hour against one
-- call a night is not a constraint worth paying a secret for. If the repository
-- is ever made private this needs a token AND a plan for its rotation, and both
-- decisions belong in the same migration.
--
-- WHERE THE POLICY LIVES. The fetch stores bytes and decides nothing. What
-- counts as drift -- the NNNN_ strip, the alias map, the baseline, counting by
-- key rather than comparing sets -- is SQL, in one place, here. A second copy of
-- "what counts as drift" in another language is how the two come to disagree,
-- and the database is the one holding the ledger. The alias and baseline files
-- are fetched from the same commit as the file list rather than mirrored into a
-- table, for the same reason: one source of truth, not two that drift apart.
--
-- WHAT IT DOES NOT DO: digest drift (a file edited after it was applied). The
-- contents API gives a name and a blob SHA, not the body, so a real digest
-- comparison is ~360 more requests a night. The blob SHA is stored anyway, so a
-- later pass can fetch bodies only for the few that changed. Name-level drift
-- is the failure that has happened five times; digest drift has happened once
-- and `npm run check:migrations` catches it locally.

-- ---------------------------------------------------------------------------
-- 1. THE STAGED MANIFEST
-- ---------------------------------------------------------------------------
-- Not tenant data: no company_id, and nothing in the application reads it. RLS
-- is enabled with NO policies, which denies every non-bypassing role, and the
-- grants are revoked as well. Belt and braces on a table that carries the
-- repo's shape and answers nothing a tenant may ask.

create table if not exists public.migration_manifest (
  file_name  text primary key,        -- '0364_the_repo_reaches...' (no .sql)
  blob_sha   text not null,           -- for the digest pass this does not do yet
  fetched_at timestamptz not null default now()
);

create table if not exists public.migration_manifest_meta (
  only_row      boolean primary key default true check (only_row),
  requested_at  timestamptz,
  fetched_at    timestamptz,          -- last SUCCESSFUL ingest; the freshness clock
  file_count    integer,
  aliases_text  text,
  baseline_text text,
  error         text,                 -- non-null: the last fetch failed, and why
  req_files     bigint,
  req_aliases   bigint,
  req_baseline  bigint
);

insert into public.migration_manifest_meta (only_row) values (true) on conflict do nothing;

alter table public.migration_manifest      enable row level security;
alter table public.migration_manifest_meta enable row level security;
revoke all on public.migration_manifest      from anon, authenticated;
revoke all on public.migration_manifest_meta from anon, authenticated;

comment on table public.migration_manifest is
  'TENANT GUARD EXEMPT: repository metadata, not tenant data. No company_id exists to scope by.';
comment on table public.migration_manifest_meta is
  'TENANT GUARD EXEMPT: repository metadata, not tenant data.';

-- ---------------------------------------------------------------------------
-- 2. THE REQUEST (04:30)
-- ---------------------------------------------------------------------------

create or replace function public.request_migration_manifest()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_base    text  := 'https://api.github.com/repos/Safi1000/employee-manager/contents/';
  v_params  jsonb := jsonb_build_object('ref', 'main');
  -- GitHub refuses requests without a User-Agent. A 403 here would surface as
  -- a fetch fault rather than as silence, but there is no reason to earn one.
  v_headers jsonb := jsonb_build_object(
    'User-Agent', 'bastion-migration-ledger',
    'Accept',     'application/vnd.github+json');
  v_files bigint; v_aliases bigint; v_baseline bigint;
begin
  select net.http_get(v_base || 'supabase/migrations',            v_params, v_headers, 20000) into v_files;
  select net.http_get(v_base || 'scripts/migration-aliases.txt',  v_params, v_headers, 20000) into v_aliases;
  select net.http_get(v_base || 'scripts/migration-baseline.txt', v_params, v_headers, 20000) into v_baseline;

  update public.migration_manifest_meta
     set requested_at = now(),
         req_files    = v_files,
         req_aliases  = v_aliases,
         req_baseline = v_baseline
   where only_row;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 3. THE INGEST (04:45)
-- ---------------------------------------------------------------------------
-- Every failure path writes `error` and LEAVES THE MANIFEST ALONE. A half-read
-- manifest replacing a good one would turn a network blip into two hundred
-- fabricated findings; leaving the old one in place lets the freshness rule
-- report the true fault, which is that the fetch stopped working.

create or replace function public.ingest_migration_manifest()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_meta      public.migration_manifest_meta%rowtype;
  v_fault     text;
  v_files     text;
  v_aliases   text;
  v_baseline  text;
  v_status    int;
  v_content   text;
  v_err       text;
  v_new_count int;
  v_old_count int;
begin
  select * into v_meta from public.migration_manifest_meta where only_row;

  if v_meta.req_files is null then
    update public.migration_manifest_meta
       set error = 'No manifest request has been made. Is the 04:30 cron job scheduled?'
     where only_row;
    return 'no request';
  end if;

  -- ---- the listing -------------------------------------------------------
  select status_code, content, error_msg into v_status, v_content, v_err
    from net._http_response where id = v_meta.req_files;

  if not found then
    v_fault := 'The GitHub listing response never arrived or has already expired (request '
               || v_meta.req_files || '). pg_net discards responses after a few hours.';
  elsif v_err is not null then
    v_fault := 'The GitHub listing request failed: ' || v_err;
  elsif v_status <> 200 then
    v_fault := 'GitHub returned ' || v_status || ' for the migrations listing. '
               || 'Has the repository been renamed or made private?';
  else
    begin
      select count(*) into v_new_count
        from jsonb_array_elements(v_content::jsonb) x
       where x->>'type' = 'file' and x->>'name' like '%.sql';
    exception when others then
      v_fault := 'The GitHub listing was not JSON (' || coalesce(sqlerrm, '?') || ').';
    end;
    v_files := v_content;
  end if;

  -- THE FLOOR. A 404 or an empty array is not "every migration is orphaned",
  -- and reporting it that way would name the wrong defect and burn an hour.
  -- Refusing to replace the manifest turns a broken fetch into a fault about
  -- the fetch.
  if v_fault is null then
    select count(*) into v_old_count from public.migration_manifest;
    if v_old_count > 0 and v_new_count * 10 < v_old_count * 9 then
      v_fault := 'The GitHub listing returned ' || v_new_count || ' migration files where '
                 || v_old_count || ' were recorded last time. Refusing to replace the manifest: '
                 || 'that is a broken fetch, not a repository that lost a tenth of its migrations. '
                 || 'If migrations really were deleted, truncate migration_manifest deliberately '
                 || 'and run ingest_migration_manifest() again.';
    end if;
  end if;

  -- ---- the alias map and the baseline ------------------------------------
  -- These are POLICY INPUTS, not decoration. Without them every pre-0109
  -- migration reports as drift in both directions, every night, and a control
  -- that fires on every input carries as much information as one that never
  -- fires. A failure to fetch them is therefore a fault, not a shrug.
  if v_fault is null then
    select status_code, content, error_msg into v_status, v_content, v_err
      from net._http_response where id = v_meta.req_aliases;
    if not found or v_err is not null or v_status <> 200 then
      v_fault := 'Could not fetch scripts/migration-aliases.txt (status '
                 || coalesce(v_status::text, 'none') || '). Without the alias map every '
                 || 'pre-0109 migration reports as drift, so this check refuses to run blind.';
    else
      v_aliases := convert_from(decode(replace((v_content::jsonb)->>'content', E'\n', ''), 'base64'), 'UTF8');
    end if;
  end if;

  if v_fault is null then
    select status_code, content, error_msg into v_status, v_content, v_err
      from net._http_response where id = v_meta.req_baseline;
    if not found or v_err is not null or v_status <> 200 then
      v_fault := 'Could not fetch scripts/migration-baseline.txt (status '
                 || coalesce(v_status::text, 'none') || '). Same reason as the alias map.';
    else
      v_baseline := convert_from(decode(replace((v_content::jsonb)->>'content', E'\n', ''), 'base64'), 'UTF8');
    end if;
  end if;

  if v_fault is not null then
    update public.migration_manifest_meta set error = v_fault where only_row;
    return v_fault;
  end if;

  -- ---- commit the manifest ------------------------------------------------
  delete from public.migration_manifest;
  insert into public.migration_manifest (file_name, blob_sha)
  select replace(x->>'name', '.sql', ''), x->>'sha'
    from jsonb_array_elements(v_files::jsonb) x
   where x->>'type' = 'file' and x->>'name' like '%.sql';

  update public.migration_manifest_meta
     set fetched_at    = now(),
         file_count    = v_new_count,
         aliases_text  = v_aliases,
         baseline_text = v_baseline,
         error         = null
   where only_row;

  return 'ok: ' || v_new_count || ' migration files';
end
$fn$;

-- ---------------------------------------------------------------------------
-- 4. THE COMPARISON
-- ---------------------------------------------------------------------------
-- Mirrors scripts/check-migrations.mjs exactly, and the two rules it earned the
-- hard way are the two that look like details:
--
--   * BY COUNT, NOT BY SET. Six repo files share the stem
--     drop_partnership_allocation and production records it once. Set
--     comparison sees a match on each side and reports zero discrepancy while
--     five migrations are missing.
--   * BOTH DIRECTIONS. Recorded-with-no-file is the serious one: something ran
--     against a database that nothing in the repo describes.

create or replace function public.migration_ledger_drift()
returns table(kind text, detail text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_meta public.migration_manifest_meta%rowtype;
begin
  select * into v_meta from public.migration_manifest_meta where only_row;

  -- THE INPUT IS CHECKED BEFORE THE DATA IS, and each of these RETURNS rather
  -- than falling through. A missing or stale manifest compared against a live
  -- schema_migrations produces a page of fabricated orphans; the fault is the
  -- fetch, and the fault is what should be reported.
  --
  -- Without this arm the check reads green forever the moment the fetch breaks,
  -- which is 9.6's first vacuity form: a check that cannot fail. A control whose
  -- input can go missing must go red on the missing input, not on the absence
  -- of findings drawn from it.

  if v_meta.fetched_at is null then
    return query select 'manifest'::text,
      'The repo manifest has never been fetched successfully'
      || coalesce(' -- ' || v_meta.error, '.')
      || ' This check is not reading the repository.';
    return;
  end if;

  if v_meta.error is not null then
    return query select 'manifest'::text,
      'The last manifest fetch failed: ' || v_meta.error;
    return;
  end if;

  -- 36 hours, not 24: one missed night is a network blip and should not page
  -- anyone. Two is a broken fetch.
  if v_meta.fetched_at < now() - interval '36 hours' then
    return query select 'manifest'::text,
      'The repo manifest is stale -- last fetched '
      || to_char(v_meta.fetched_at, 'YYYY-MM-DD HH24:MI') || 'Z. '
      || 'This check is not reading the repository.';
    return;
  end if;

  return query
  with alias as (
    select trim(split_part(l, '=', 1)) as repo_k,
           trim(split_part(l, '=', 2)) as applied_k
      from unnest(string_to_array(coalesce(v_meta.aliases_text, ''), E'\n')) as l
     where trim(l) <> '' and left(trim(l), 1) <> '#' and position('=' in l) > 0
  ),
  baseline as (
    select trim(l) as k
      from unnest(string_to_array(coalesce(v_meta.baseline_text, ''), E'\n')) as l
     where trim(l) <> '' and left(trim(l), 1) <> '#'
  ),
  -- Repo keys are translated through the alias map so both sides of the
  -- comparison speak the applied-name vocabulary.
  repo as (
    select f.file_name,
           coalesce(a.applied_k, regexp_replace(f.file_name, '^\d{4}[a-z]?_', '')) as k
      from public.migration_manifest f
      left join alias a on a.repo_k = regexp_replace(f.file_name, '^\d{4}[a-z]?_', '')
  ),
  db as (
    select s.name, regexp_replace(s.name, '^\d{4}[a-z]?_', '') as k
      from supabase_migrations.schema_migrations s
  ),
  repo_t as (
    select k, count(*) as n, string_agg(file_name, ', ' order by file_name) as names
      from repo group by k
  ),
  db_t as (
    select k, count(*) as n, string_agg(name, ', ' order by name) as names
      from db group by k
  )
  select 'in repo, not recorded'::text,
         r.names || case when coalesce(d.n, 0) = 0
                         then '  (not recorded at all)'
                         else '  (' || r.n || ' files, only ' || d.n || ' recorded)' end
    from repo_t r
    left join db_t d on d.k = r.k
   where not exists (select 1 from baseline b where b.k = r.k)
     and coalesce(d.n, 0) < r.n
  union all
  select 'recorded, no repo file'::text,
         d.names || case when coalesce(r.n, 0) = 0
                         then '  (no repo file)'
                         else '  (' || d.n || ' recorded, only ' || r.n || ' file(s))' end
    from db_t d
    left join repo_t r on r.k = d.k
   where not exists (select 1 from baseline b where b.k = d.k)
     and d.n > coalesce(r.n, 0);
end
$fn$;

revoke all on function public.request_migration_manifest()  from public, anon, authenticated;
revoke all on function public.ingest_migration_manifest()   from public, anon, authenticated;
revoke all on function public.migration_ledger_drift()      from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. WIRE IT INTO ledger_checks BY SURGERY
-- ---------------------------------------------------------------------------
-- ledger_checks has many authors. No file holds its true text, so it is amended
-- against pg_get_functiondef with anchors asserted to appear exactly once, and
-- the canary is read rather than assumed. 0304 and 0310 both shipped a literal
-- canary bump and both would have aborted at their own guards when 0318 moved
-- the number.

do $wire$
declare
  v_def    text;
  v_anchor text;
  v_n      int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks';
  if v_def is null then
    raise exception '0364 FAILED: public.ledger_checks does not exist';
  end if;

  if position('migration_ledger_matches_repo' in v_def) > 0 then
    raise exception '0364 FAILED: ledger_checks already carries migration_ledger_matches_repo';
  end if;

  if (select count(*) from regexp_matches(v_def, 'from public\.misparented_system_accounts\(p_company_id\)', 'g')) <> 1 then
    raise exception '0364 FAILED: the anchor is missing or doubled -- do not widen it, look at the function';
  end if;

  v_anchor := '      from public.misparented_system_accounts(p_company_id)' || E'\n' || '  )';
  if position(v_anchor in v_def) = 0 then
    raise exception '0364 FAILED: misparented_system_accounts is no longer the last arm -- re-anchor deliberately';
  end if;

  v_def := replace(v_def, v_anchor,
    '      from public.misparented_system_accounts(p_company_id)'                        || E'\n' ||
    '    union all'                                                                       || E'\n' ||
    '    -- 0364. Does the migration ledger still describe the repository? Asked'         || E'\n' ||
    '    -- nightly, by the database, on an event no developer has to remember.'          || E'\n' ||
    '    -- Company-independent: it reads the ledger, not the tenant data.'               || E'\n' ||
    '    select ''migration_ledger_matches_repo''::text,'                                 || E'\n' ||
    '           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0'           || E'\n' ||
    '      from public.migration_ledger_drift()'                                          || E'\n' ||
    '  )');

  v_n := (regexp_match(v_def, 'select (\d+)::numeric n\) e \(n\)'))[1]::int;
  if v_n is null then
    raise exception '0364 FAILED: the canary is not in the single-number shape 0302 left it -- do not guess';
  end if;
  v_def := regexp_replace(v_def, 'select \d+::numeric n\) e \(n\)',
                          'select ' || (v_n + 1) || '::numeric n) e (n)');

  execute v_def;
end
$wire$;

-- ---------------------------------------------------------------------------
-- 6. SCHEDULE, BEFORE THE SUITE READS IT
-- ---------------------------------------------------------------------------
-- ledger-checks-daily runs 05:00 UTC. Request 04:30, ingest 04:45.

select cron.unschedule('migration-manifest-request')
 where exists (select 1 from cron.job where jobname = 'migration-manifest-request');
select cron.unschedule('migration-manifest-ingest')
 where exists (select 1 from cron.job where jobname = 'migration-manifest-ingest');

select cron.schedule('migration-manifest-request', '30 4 * * *',
                     'select public.request_migration_manifest();');
select cron.schedule('migration-manifest-ingest',  '45 4 * * *',
                     'select public.ingest_migration_manifest();');

-- ---------------------------------------------------------------------------
-- 7. VERIFICATION
-- ---------------------------------------------------------------------------
-- Every fixture below is CREATED, not selected (9.14a). The one thing it cannot
-- create is supabase_migrations.schema_migrations, so the manifest is built FROM
-- the recorded rows to establish a zero-drift floor, and the probes are exact
-- deviations from that floor. A probe that plants one fault and finds one row is
-- evidence; a probe that reads whatever is there and reports a number is not.

do $verify$
declare
  v_rows   int;
  v_detail text;
  v_kind   text;
  v_pick   text;   -- one real recorded name, deliberately left un-baselined
  v_key    text;
  v_base   text;   -- every OTHER recorded key, baselined out of the way
begin
  -- ---- 0. Nothing fetched yet, so the check must be RED, and red for the
  --         right reason. This is the state the migration lands in.
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 1 then
    raise exception '0364 FAILED: an unfetched manifest reported % rows, expected exactly 1', v_rows;
  end if;
  select kind, detail into v_kind, v_detail from public.migration_ledger_drift();
  if v_kind <> 'manifest' or v_detail not like '%never been fetched%' then
    raise exception '0364 FAILED: an unfetched manifest reported "%" / "%"', v_kind, v_detail;
  end if;

  -- ---- 1. NEUTRALISE THE SIDE THIS BLOCK CANNOT CREATE.
  --
  -- supabase_migrations.schema_migrations is the one input a fixture cannot
  -- fabricate, and it does not behave the way a first draft of this block
  -- assumed: production records the name fix_cheque_treasury_company_scope
  -- TWICE, so a manifest built from it — keyed by file_name — collapses two
  -- rows into one and reports a drift the probes did not plant. That is 9.14a
  -- again, one level down: a fixture that reads the ledger is a reading of
  -- state the migration did not create.
  --
  -- So every recorded key is baselined out of the way except ONE, chosen and
  -- asserted unique. Everything the probes see from here is planted.
  select name into v_pick
    from supabase_migrations.schema_migrations order by version desc limit 1;
  v_key := regexp_replace(v_pick, '^\d{4}[a-z]?_', '');

  if (select count(*) from supabase_migrations.schema_migrations s
       where regexp_replace(s.name, '^\d{4}[a-z]?_', '') = v_key) <> 1 then
    raise exception '0364 FAILED: the chosen probe key % is not unique in the ledger', v_key;
  end if;

  select string_agg(distinct regexp_replace(s.name, '^\d{4}[a-z]?_', ''), E'\n')
    into v_base
    from supabase_migrations.schema_migrations s
   where regexp_replace(s.name, '^\d{4}[a-z]?_', '') <> v_key;

  update public.migration_manifest_meta
     set fetched_at = now(), error = null, aliases_text = '', baseline_text = v_base
   where only_row;

  -- ---- 2. THE SERIOUS DIRECTION, and the one this whole file exists for:
  --         something recorded that the repository does not describe. This is
  --         the shape of 0240, 0241 and 0319-0340.
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 1 then
    raise exception '0364 FAILED: one recorded row with no repo file produced % rows, expected 1', v_rows;
  end if;
  select kind, detail into v_kind, v_detail from public.migration_ledger_drift();
  if v_kind <> 'recorded, no repo file' or v_detail not like '%' || v_pick || '%'
     or v_detail not like '%(no repo file)%' then
    raise exception '0364 FAILED: the orphan direction reported "%" / "%"', v_kind, v_detail;
  end if;

  -- ---- 3. THE FLOOR. Give it the file and the finding goes away — which also
  --         proves the NNNN_ strip matches a real recorded name, not just a
  --         synthetic one.
  insert into public.migration_manifest (file_name, blob_sha) values (v_pick, 'probe');
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 0 then
    select detail into v_detail from public.migration_ledger_drift() limit 1;
    raise exception '0364 FAILED: a matched pair still reported % rows (e.g. %)', v_rows, v_detail;
  end if;

  -- ---- 4. The other direction: a repo file nothing recorded, named.
  insert into public.migration_manifest (file_name, blob_sha)
  values ('9999_probe_repo_only', 'probe');
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 1 then
    raise exception '0364 FAILED: one unrecorded repo file produced % rows', v_rows;
  end if;
  select kind, detail into v_kind, v_detail from public.migration_ledger_drift();
  if v_kind <> 'in repo, not recorded' or v_detail not like '%9999_probe_repo_only%'
     or v_detail not like '%(not recorded at all)%' then
    raise exception '0364 FAILED: unrecorded repo file reported "%" / "%"', v_kind, v_detail;
  end if;

  -- ---- 5. THE BASELINE IS READ, comments and all. The same file, baselined,
  --         is silent.
  update public.migration_manifest_meta
     set baseline_text = v_base || E'\n' || '# a comment that must be ignored' || E'\n' || 'probe_repo_only'
   where only_row;
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 0 then
    raise exception '0364 FAILED: a baselined key still reported % rows — the baseline is not being read', v_rows;
  end if;
  update public.migration_manifest_meta set baseline_text = v_base where only_row;

  -- ---- 6. THE ALIAS MAP IS READ, and this probe DISCRIMINATES. Two repo files
  --         with different stems are two keys and two findings. Aliased onto one
  --         another they are ONE key holding two files, so the count comparison
  --         reports a single row naming both. A probe that reported a finding
  --         either way would prove nothing about the alias.
  insert into public.migration_manifest (file_name, blob_sha)
  values ('8888_probe_alias_target', 'probe');
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 2 then
    raise exception '0364 FAILED: two unaliased probe files produced % rows, expected 2', v_rows;
  end if;

  update public.migration_manifest_meta
     set aliases_text = '# comment' || E'\n' || 'probe_repo_only = probe_alias_target'
   where only_row;
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 1 then
    raise exception '0364 FAILED: the alias did not collapse two files onto one key (% rows)', v_rows;
  end if;
  select detail into v_detail from public.migration_ledger_drift();
  if v_detail not like '%8888_probe_alias_target%' or v_detail not like '%9999_probe_repo_only%'
     or v_detail not like '%(not recorded at all)%' then
    raise exception '0364 FAILED: the aliased finding did not name both files: %', v_detail;
  end if;

  delete from public.migration_manifest
   where file_name in ('9999_probe_repo_only', '8888_probe_alias_target');
  update public.migration_manifest_meta set aliases_text = '' where only_row;

  -- ---- 6b. COUNT, NOT SET -- the defect this whole comparison exists for.
  --
  -- Six repo files share the stem drop_partnership_allocation and production
  -- records it twice. Set comparison sees a match on each side and reports
  -- agreement while four migrations are missing. So: a SECOND file aliased onto
  -- a key that IS recorded, once. Two files, one recorded, and the finding must
  -- say so in those words rather than falling silent because the key matched.
  --
  -- The probe above could not test this branch: zero recorded takes the
  -- "not recorded at all" path, which is a different sentence and a different
  -- question. That is what the first draft of this assertion got wrong, and the
  -- migration refused to apply rather than shipping a probe that agreed with
  -- itself.
  insert into public.migration_manifest (file_name, blob_sha)
  values ('7777_probe_second_copy', 'probe');
  update public.migration_manifest_meta
     set aliases_text = 'probe_second_copy = ' || v_key
   where only_row;
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 1 then
    raise exception '0364 FAILED: two files against one recorded row produced % rows, expected 1', v_rows;
  end if;
  select kind, detail into v_kind, v_detail from public.migration_ledger_drift();
  if v_kind <> 'in repo, not recorded' or v_detail not like '%2 files, only 1 recorded%' then
    raise exception '0364 FAILED: the count branch reported "%" / "%" -- set comparison would have called this agreement', v_kind, v_detail;
  end if;

  delete from public.migration_manifest where file_name = '7777_probe_second_copy';
  update public.migration_manifest_meta set aliases_text = '' where only_row;
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 0 then
    raise exception '0364 FAILED: the probes were not fully withdrawn (% rows)', v_rows;
  end if;

  -- ---- 7. THE FRESHNESS RULE. A stale manifest is red BEFORE it compares
  --         anything, and says the fetch is broken rather than that the
  --         migrations are fine. Without this the check reads green forever the
  --         first time GitHub stops answering — 9.6's check that cannot fail.
  update public.migration_manifest_meta set fetched_at = now() - interval '40 hours' where only_row;
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 1 then
    raise exception '0364 FAILED: a 40-hour-old manifest produced % rows, expected exactly 1', v_rows;
  end if;
  select kind, detail into v_kind, v_detail from public.migration_ledger_drift();
  if v_kind <> 'manifest' or v_detail not like '%stale%' then
    raise exception '0364 FAILED: a stale manifest reported "%" / "%"', v_kind, v_detail;
  end if;

  -- 30 hours is one missed night and must NOT fire. A control that fires on a
  -- single network blip is one that gets muted.
  update public.migration_manifest_meta set fetched_at = now() - interval '30 hours' where only_row;
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 0 then
    raise exception '0364 FAILED: a 30-hour-old manifest fired (% rows) — one missed night must not page anyone', v_rows;
  end if;

  -- ---- 8. A RECORDED FETCH FAILURE IS RED, and carries its own reason rather
  --         than a count.
  update public.migration_manifest_meta
     set fetched_at = now(), error = 'GitHub returned 404 for the migrations listing.'
   where only_row;
  select count(*) into v_rows from public.migration_ledger_drift();
  if v_rows <> 1 then
    raise exception '0364 FAILED: a recorded fetch error produced % rows', v_rows;
  end if;
  select detail into v_detail from public.migration_ledger_drift();
  if v_detail not like '%404%' then
    raise exception '0364 FAILED: the fetch error did not carry its reason: %', v_detail;
  end if;

  -- ---- 9. RESTORE BEFORE THE VERDICT, so a failure below cannot leave a
  --         fabricated manifest behind (0318's lesson).
  delete from public.migration_manifest;
  update public.migration_manifest_meta
     set fetched_at = null, error = null, file_count = null,
         aliases_text = null, baseline_text = null
   where only_row;

  if (select count(*) from public.migration_manifest) <> 0 then
    raise exception '0364 FAILED: the probe manifest was not cleaned up';
  end if;
end
$verify$;

-- ---- 9. THE WIRING, checked after the restore.
do $suite$
declare
  v_company uuid;
  v_rows    int;
  v_exp     numeric;
  v_passed  boolean;
begin
  select id into v_company from public.companies order by created_at limit 1;

  select count(*) into v_rows from public.ledger_checks(v_company);
  select expected into v_exp from public.ledger_checks(v_company) where check_name = 'checks_evaluated';
  if v_exp is null then
    raise exception '0364 FAILED: the canary row is missing from ledger_checks';
  end if;
  if v_rows <> v_exp + 1 then
    raise exception '0364 FAILED: ledger_checks returned % rows against a canary of % (+1 for the canary itself)',
      v_rows, v_exp;
  end if;

  select passed into v_passed from public.ledger_checks(v_company) where check_name = 'checks_evaluated';
  if not v_passed then
    raise exception '0364 FAILED: the canary is red -- the arm count and expected_check_count disagree';
  end if;

  -- The new check must be PRESENT and, with no manifest fetched yet, RED. Green
  -- here would mean the arm is reading an empty manifest as agreement, which is
  -- the exact vacuity the freshness rule exists to prevent.
  select passed into v_passed from public.ledger_checks(v_company)
   where check_name = 'migration_ledger_matches_repo';
  if v_passed is null then
    raise exception '0364 FAILED: migration_ledger_matches_repo is not in the suite';
  end if;
  if v_passed then
    raise exception '0364 FAILED: the new check is GREEN before anything has been fetched';
  end if;

  -- 0288's control must now see the detector as invoked.
  if exists (select 1 from public.uninvoked_controls() where object_name = 'migration_ledger_drift') then
    raise exception '0364 FAILED: migration_ledger_drift is still reported as uninvoked';
  end if;

  -- And the jobs must actually be scheduled, before the suite reads the manifest.
  if (select count(*) from cron.job
       where jobname in ('migration-manifest-request', 'migration-manifest-ingest') and active) <> 2 then
    raise exception '0364 FAILED: the manifest cron jobs are not both scheduled and active';
  end if;
end
$suite$;
