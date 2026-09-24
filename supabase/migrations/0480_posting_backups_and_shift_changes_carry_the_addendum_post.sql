-- 0480 — Posting backups and shift changes carry the addendum post (0479).
--
-- 1. BACKUP TABLE. deployments_overlap_backup_0183 is written positionally —
--    `insert into … select d.*, now(), <note>` in archive_guard_deployments and
--    change_client (record_separation reaches it through them) — so its columns must be deployments'
--    columns, in deployments' order, then backed_up_at and backup_note. 0479
--    appended deployments.contract_addendum_id, and every one of those inserts
--    began failing: 16 expressions into 15 columns. That broke a same-day shift
--    change, a same-day client change, archiving overlaps and separations.
--
--    Rebuilt with contract_addendum_id in deployments' position (after
--    shift_code). MEASURED BEFORE (prod): 51 rows; RLS on with no policies;
--    grants to postgres and service_role only; one trigger,
--    trg_company_not_archived. All of it is restored as it was, and the row
--    count is asserted. The three writers are untouched: the fix is the shape
--    they already assume.
--
-- 2. change_guard_shift copies the current posting forward onto the new shift.
--    It carried contract_line_id and not contract_addendum_id, so a guard on an
--    addendum post changing shift would drop off the post and out of its cap.
--    Amended by surgery (many authors), anchors asserted once.

do $mig$
declare
  v_before int;
  v_after  int;
  v_cols_dep text;
  v_cols_bak text;
begin
  -- Already the right shape (replay): nothing to rebuild.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public'
                    and table_name = 'deployments_overlap_backup_0183'
                    and column_name = 'contract_addendum_id') then
    select count(*) into v_before from public.deployments_overlap_backup_0183;

    -- Same columns, nullability and defaults as before, plus contract_addendum_id
    -- in deployments' position.
    create table public.deployments_overlap_backup_0183_new (
      id                   uuid not null default gen_random_uuid(),
      company_id           uuid not null,
      guard_id             uuid not null,
      client_id            uuid not null,
      contract_line_id     uuid,
      site_id              uuid,
      post_id              uuid,
      start_date           date not null,
      end_date             date,
      reason               public.deployment_reason not null default 'new_hire'::public.deployment_reason,
      created_at           timestamptz not null default now(),
      updated_at           timestamptz not null default now(),
      shift_code           text,
      contract_addendum_id uuid,
      backed_up_at         timestamptz not null default now(),
      backup_note          text
    );
    insert into public.deployments_overlap_backup_0183_new
      (id, company_id, guard_id, client_id, contract_line_id, site_id, post_id,
       start_date, end_date, reason, created_at, updated_at, shift_code,
       backed_up_at, backup_note)
    select id, company_id, guard_id, client_id, contract_line_id, site_id, post_id,
           start_date, end_date, reason, created_at, updated_at, shift_code,
           backed_up_at, backup_note
      from public.deployments_overlap_backup_0183;

    drop table public.deployments_overlap_backup_0183;
    alter table public.deployments_overlap_backup_0183_new
      rename to deployments_overlap_backup_0183;

    alter table public.deployments_overlap_backup_0183 enable row level security;
    revoke all on public.deployments_overlap_backup_0183 from public, anon, authenticated;
    grant all on public.deployments_overlap_backup_0183 to service_role;

    create trigger trg_company_not_archived
      before insert or delete or update on public.deployments_overlap_backup_0183
      for each row execute function public.enforce_company_not_archived();

    select count(*) into v_after from public.deployments_overlap_backup_0183;
    if v_after <> v_before then
      raise exception '0480: backup rebuilt with % rows, had %', v_after, v_before;
    end if;
  end if;

  -- The shape every positional writer assumes: deployments' columns, in order,
  -- then the two backup columns.
  select string_agg(column_name, ',' order by ordinal_position) into v_cols_dep
    from information_schema.columns
   where table_schema = 'public' and table_name = 'deployments';
  select string_agg(column_name, ',' order by ordinal_position) into v_cols_bak
    from information_schema.columns
   where table_schema = 'public' and table_name = 'deployments_overlap_backup_0183';
  if v_cols_bak <> v_cols_dep || ',backed_up_at,backup_note' then
    raise exception '0480: backup columns (%) are not deployments'' columns (%) + backed_up_at, backup_note',
      v_cols_bak, v_cols_dep;
  end if;
end $mig$;

comment on table public.deployments_overlap_backup_0183 is
  'Postings removed or superseded by archive_guard_deployments / change_client (and record_separation through them). '
  'Written POSITIONALLY (select d.*, now(), note): its columns must stay deployments'' columns in '
  'deployments'' order, then backed_up_at, backup_note. A column added to deployments must be '
  'added here in the same position (0480).';

-- ── 2. change_guard_shift carries the addendum post forward ───────────────────
do $mig$
declare
  v_def text;
  v_new text;
  v_a   text;
  v_b   text;
  v_n   int;
begin
  v_def := pg_get_functiondef('public.change_guard_shift'::regproc);
  if position('0480:' in v_def) > 0 then
    return;
  end if;

  v_a := E'reason, shift_code)\n  values (v_company, p_guard, v_dep.client_id,\n';
  v_n := (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a);
  if v_n <> 1 then
    raise exception '0480: change_guard_shift column-list anchor found % times, expected 1', v_n;
  end if;
  v_b := E'     v_dep.site_id, v_eff, ''shift_change'', p_new_shift)\n';
  v_n := (length(v_def) - length(replace(v_def, v_b, ''))) / length(v_b);
  if v_n <> 1 then
    raise exception '0480: change_guard_shift values anchor found % times, expected 1', v_n;
  end if;

  v_new := replace(v_def, v_a,
    E'reason, shift_code, contract_addendum_id)\n  values (v_company, p_guard, v_dep.client_id,\n');
  v_new := replace(v_new, v_b,
       E'     v_dep.site_id, v_eff, ''shift_change'', p_new_shift,\n'
    || E'     -- 0480: an addendum post (no line) stays the same post on the new shift.\n'
    || E'     case when v_dep.contract_line_id is null then v_dep.contract_addendum_id end)\n');
  execute v_new;

  v_def := pg_get_functiondef('public.change_guard_shift'::regproc);
  if (length(v_def) - length(replace(v_def, '0480:', ''))) / 5 <> 1 then
    raise exception '0480: change_guard_shift marker missing or doubled';
  end if;
end $mig$;

do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
