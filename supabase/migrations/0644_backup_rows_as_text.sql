-- 0644 — the backup's rows are written as text by the database.
--
-- 5 Nov 2026, the first "Back up now" after the key was fixed: backup-export
-- was shut down after ~30 s with "CPU Time exceeded" (HTTP 546), part-way
-- through the tables beginning with "e". An Edge Function gets about two
-- seconds of CPU per request, and the function was spending it on JSON:
-- PostgREST serialised each page of rows, the function parsed it into objects
-- and then stringified every row again to write NDJSON — 165k rows, 52 MB, done
-- twice in JavaScript. The run row was left with no finish because the runtime
-- killed the function before its catch block could run.
--
-- backup_ndjson returns one page of a table already as NDJSON lines, in exactly
-- the shape the file has always had ({"t": table, "r": row} per line), so the
-- function only compresses, encrypts and uploads. The file format and
-- scripts/decrypt-backup.mjs do not change.
--
-- Service role only, like backup_tables (0594). The table name is checked
-- against backup_tables() and quoted with %I, so it cannot name anything else.

create or replace function public.backup_ndjson(p_table text, p_offset integer, p_limit integer)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_has_id boolean; v_out text;
begin
  select b.has_id into v_has_id from public.backup_tables() b where b.table_name = p_table;
  if not found then raise exception 'backup_ndjson: % is not a backed-up table.', p_table; end if;
  if p_offset < 0 or p_limit < 1 or p_limit > 20000 then raise exception 'backup_ndjson: bad page (% , %).', p_offset, p_limit; end if;
  execute format(
    'select string_agg(json_build_object(''t'', %L, ''r'', to_jsonb(x))::text, E''\n'') from (select * from public.%I %s offset %s limit %s) x',
    p_table, p_table, case when v_has_id then 'order by id' else '' end, p_offset, p_limit)
  into v_out;
  return v_out;   -- null when the page is empty
end $$;
comment on function public.backup_ndjson(text, integer, integer) is
  'TENANT GUARD EXEMPT: reads whole tables for the encrypted backup; no tenant argument. Service role only (0644).';
revoke all on function public.backup_ndjson(text, integer, integer) from public, anon, authenticated;
grant execute on function public.backup_ndjson(text, integer, integer) to service_role;

-- ───────────────────────── Tests (read-only) ─────────────────────────
do $test$
declare v_txt text; v_n int; v_msg text; v_ran int := 0;
begin
  -- 1. A page comes back as one line per row, each line {"t":..., "r":{...}}.
  v_txt := public.backup_ndjson('branches', 0, 1000);
  v_n := array_length(string_to_array(v_txt, E'\n'), 1);
  if v_n is distinct from (select count(*)::int from public.branches) then raise exception '0644 REFUSED: branches gave % lines, expected %.', v_n, (select count(*) from public.branches); end if;
  if ((split_part(v_txt, E'\n', 1))::jsonb ->> 't') is distinct from 'branches' or ((split_part(v_txt, E'\n', 1))::jsonb -> 'r' ->> 'id') is null then
    raise exception '0644 REFUSED: a line is not {"t": table, "r": row}.';
  end if;
  v_ran := v_ran + 1;

  -- 2. Paging past the end returns null, which is how the function knows a table is done.
  if public.backup_ndjson('branches', 100000, 1000) is not null then raise exception '0644 REFUSED: a page past the end was not empty.'; end if;
  v_ran := v_ran + 1;

  -- 3. A name that is not a backed-up table is refused, in its own words.
  v_msg := null;
  begin perform public.backup_ndjson('pg_authid', 0, 10); exception when others then get stacked diagnostics v_msg = message_text; end;
  if v_msg is distinct from 'backup_ndjson: pg_authid is not a backed-up table.' then raise exception '0644 REFUSED: an unknown table was not refused (%).', coalesce(v_msg, 'no error'); end if;
  v_ran := v_ran + 1;

  -- 4. Only the service role may call it.
  if has_function_privilege('authenticated', 'public.backup_ndjson(text, integer, integer)', 'execute')
     or has_function_privilege('anon', 'public.backup_ndjson(text, integer, integer)', 'execute') then
    raise exception '0644 REFUSED: backup_ndjson is callable by a signed-in or anonymous user.';
  end if;
  v_ran := v_ran + 1;

  if v_ran <> 4 then raise exception '0644 REFUSED: % of 4 assertions ran.', v_ran; end if;
  if exists (select 1 from public.security_gaps()) then raise exception '0644 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0644 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
