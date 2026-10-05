-- 0493 — Attendance is verified by half-month: HR, then Ops, then Finance.
--
-- WHAT CHANGES
--
-- Until now a client's month of attendance had ONE sign-off: OPS Verify
-- (attendance_month_verifications, 0190/0192), which locked the month and
-- opened the payroll run. Asked for on 2026-10-05 and DECIDED with the user:
--
--   * The month splits into two boards. The cut is EXACT HALVES: half 1 is
--     days 1..floor(days_in_month / 2), half 2 the rest. So 28-day February is
--     1-14 / 15-28, 29-day February 1-14 / 15-29, 30-day months 1-15 / 16-30,
--     31-day months 1-15 / 16-31. attendance_half_of() is the only place that
--     says this.
--   * Each half is verified HR -> Ops -> Finance, per client (or per client-less
--     staff group, same scoping as 0192). HR's verification is the one that
--     locks the half's attendance; the later two can only follow it.
--   * A later stage may SEND BACK to the earlier one, and must say why. Ops
--     returns to HR (clears HR's stamp, which unlocks the half); Finance
--     returns to Ops. The reason is written to the board's remarks thread, so
--     a return is never silent. A stage may also withdraw its own
--     verification while the next stage has not acted.
--   * Each board (client + half) carries ONE remarks thread: remarks, and
--     replies to them, each naming its author.
--   * Payroll for a client opens (Draft -> Review) only when BOTH halves are
--     Finance-verified. attendance_month_cleared() is that test.
--   * Once payroll for the scope has left Draft, the halves are frozen: no
--     verify, undo or return. Same rule the old Un-verify button enforced
--     in the browser; here it is enforced in the database.
--
-- THE OLD MONTHLY VERIFICATIONS
--
-- 36 rows exist (Aug-Sep 2026, 3 verifiers). They are NOT converted into half
-- rows: stamping HR and Finance with the Ops verifier's name would fabricate
-- two sign-offs nobody gave. Instead every reader treats a legacy month row as
-- that month fully verified — the legacy lock trigger keeps enforcing it,
-- attendance_month_cleared() returns true for it — and NEW legacy rows are
-- refused, so a stale screen (the mobile app's old OPS Verify) cannot skip HR
-- and Finance by writing one. Deleting a legacy row (Un-verify) still works.
--
-- WHY A SECOND LOCK TRIGGER RATHER THAN SURGERY ON THE FIRST
--
-- enforce_attendance_month_lock() has been edited by eight migrations. The
-- half lock is a separate trigger beside it, so that function is not touched.
-- purge_attendance_after_separation() IS amended (one-line anchor, asserted
-- once): without it, separating a guard whose later days sit in a verified
-- half would try to delete them, the new lock would refuse, and the
-- separation itself would fail.
--
-- SET OR SINGLE ROW
--
-- attendance_half_action() writes exactly one row named by its full key
-- (scope + month + half) and asserts the row count. It is SECURITY DEFINER
-- because each stage has its own key (CLAUDE.md "the key follows the STAGE"):
-- under invoker the table policy would have to hold one key for every stage,
-- which is the flattening the split exists to prevent.

-- ---------------------------------------------------------------------------
-- 1. Permission keys. attendance.ops_verify already exists (0384).
-- ---------------------------------------------------------------------------
insert into public.permission_keys (key, grp, label) values
  ('attendance.hr_verify',      'Attendance', 'HR-verify a half-month of attendance'),
  ('attendance.finance_verify', 'Attendance', 'Finance-verify a half-month of attendance')
on conflict (key) do nothing;

update public.permission_keys
   set label = 'OPS-verify a half-month of attendance (after HR)'
 where key = 'attendance.ops_verify';

-- ---------------------------------------------------------------------------
-- 2. Where a month is cut.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_half_of(p_date date)
returns smallint
language sql
immutable
as $$
  select case
    when extract(day from p_date)::int
         <= extract(day from (date_trunc('month', p_date) + interval '1 month - 1 day'))::int / 2
    then 1 else 2 end::smallint;
$$;

comment on function public.attendance_half_of(date) is
  'Which half of its month a date falls in (1 or 2). Exact halves: half 1 is days 1..floor(days_in_month/2). DECIDED 2026-10-05 (0493).';

create or replace function public.attendance_half_bounds(p_month date, p_half int,
  out half_start date, out half_end date)
language sql
immutable
as $$
  select case when p_half = 1 then date_trunc('month', p_month)::date
              else (date_trunc('month', p_month)
                    + make_interval(days => extract(day from (date_trunc('month', p_month) + interval '1 month - 1 day'))::int / 2))::date
         end,
         case when p_half = 1 then (date_trunc('month', p_month)
                    + make_interval(days => extract(day from (date_trunc('month', p_month) + interval '1 month - 1 day'))::int / 2 - 1))::date
              else (date_trunc('month', p_month) + interval '1 month - 1 day')::date
         end;
$$;

comment on function public.attendance_half_bounds(date, int) is
  'First and last day of half 1 or 2 of the month containing p_month (0493). Agrees with attendance_half_of by construction.';

do $$
declare d date; h int; b record;
begin
  -- The two functions must agree on every day of a 28, 29, 30 and 31-day month.
  foreach d in array array['2026-02-01','2028-02-01','2026-09-01','2026-10-01']::date[] loop
    for h in 1..2 loop
      select * into b from public.attendance_half_bounds(d, h);
      if public.attendance_half_of(b.half_start) <> h or public.attendance_half_of(b.half_end) <> h then
        raise exception '0493 FAILED: half bounds disagree with attendance_half_of for % half %', d, h;
      end if;
    end loop;
  end loop;
  if (select half_end from public.attendance_half_bounds('2026-02-01', 1)) <> '2026-02-14'
     or (select half_end from public.attendance_half_bounds('2026-10-01', 1)) <> '2026-10-15'
     or (select half_start from public.attendance_half_bounds('2026-10-01', 2)) <> '2026-10-16' then
    raise exception '0493 FAILED: half cut is not the decided exact-halves rule';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The verification record: one row per scope + month + half.
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_half_verifications (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  client_id        uuid references public.clients(id) on delete cascade,
  category         text,
  period_month     date not null check (period_month = date_trunc('month', period_month)::date),
  half             smallint not null check (half in (1, 2)),
  hr_verified_by        uuid references public.profiles(id),
  hr_verified_by_name   text,
  hr_verified_at        timestamptz,
  ops_verified_by       uuid references public.profiles(id),
  ops_verified_by_name  text,
  ops_verified_at       timestamptz,
  finance_verified_by       uuid references public.profiles(id),
  finance_verified_by_name  text,
  finance_verified_at       timestamptz,
  updated_at       timestamptz not null default now(),
  check ((client_id is not null) <> (category is not null)),
  -- A stage cannot stand without the one before it.
  check (ops_verified_at is null or hr_verified_at is not null),
  check (finance_verified_at is null or ops_verified_at is not null)
);

create unique index if not exists ahv_scope_unique
  on public.attendance_half_verifications
  (company_id, period_month, half, coalesce(client_id::text, 'cat:' || category));

comment on table public.attendance_half_verifications is
  'HR -> Ops -> Finance verification of one half-month of attendance for one client or client-less staff group (0493). Written only by attendance_half_action(). Names are captured at the moment of each action, because profiles are not readable across users.';

alter table public.attendance_half_verifications enable row level security;

drop policy if exists ahv_company on public.attendance_half_verifications;
create policy ahv_company on public.attendance_half_verifications
  for select using (company_id = (select public.current_company_id()));
drop policy if exists ahv_ssa on public.attendance_half_verifications;
create policy ahv_ssa on public.attendance_half_verifications
  for select using ((select public.is_ssa_unscoped()));
-- No insert/update/delete policy: the only writer is attendance_half_action().

-- ---------------------------------------------------------------------------
-- 4. The board's remarks thread.
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_board_remarks (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  client_id     uuid references public.clients(id) on delete cascade,
  category      text,
  period_month  date not null check (period_month = date_trunc('month', period_month)::date),
  half          smallint not null check (half in (1, 2)),
  parent_id     uuid references public.attendance_board_remarks(id) on delete cascade,
  kind          text not null default 'remark' check (kind in ('remark', 'reply', 'returned')),
  body          text not null check (length(btrim(body)) between 1 and 4000),
  author_id     uuid references public.profiles(id),
  author_name   text,
  created_at    timestamptz not null default now(),
  check ((client_id is not null) <> (category is not null)),
  check ((kind = 'reply') = (parent_id is not null))
);

create index if not exists abr_board on public.attendance_board_remarks
  (company_id, period_month, half, client_id, category, created_at);

comment on table public.attendance_board_remarks is
  'Remarks and replies on one half-month attendance board (0493). kind=returned is written by attendance_half_action when a stage sends the half back; its body is the reason. Written only through the RPCs, which stamp the author.';

alter table public.attendance_board_remarks enable row level security;

drop policy if exists abr_company on public.attendance_board_remarks;
create policy abr_company on public.attendance_board_remarks
  for select using (company_id = (select public.current_company_id()));
drop policy if exists abr_ssa on public.attendance_board_remarks;
create policy abr_ssa on public.attendance_board_remarks
  for select using ((select public.is_ssa_unscoped()));

-- ---------------------------------------------------------------------------
-- 5. Readers.
-- ---------------------------------------------------------------------------

-- Is this date inside a half that HR has verified (i.e. locked)? Matches a
-- client scope or a group scope the same way the separation purge does.
create or replace function public.attendance_date_verified(p_client uuid, p_category text, p_date date)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.attendance_half_verifications h
     where h.period_month = date_trunc('month', p_date)::date
       and h.half = public.attendance_half_of(p_date)
       and h.hr_verified_at is not null
       and (h.client_id = p_client
            or (h.category is not null and h.category = p_category))
  );
$$;

comment on function public.attendance_date_verified(uuid, text, date) is
  'True when p_date sits in a half-month that HR has verified for this client or group, which locks it (0493). Does not read the legacy monthly table; enforce_attendance_month_lock still does.';

-- Is the whole month ready for payroll? Both halves Finance-verified, or a
-- legacy monthly verification (pre-0493) exists.
create or replace function public.attendance_month_cleared(p_client_id uuid, p_category text, p_period_month date)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
           select 1 from public.attendance_month_verifications v
            where v.period_month = date_trunc('month', p_period_month)::date
              and (v.client_id = p_client_id or (p_client_id is null and v.category = p_category)))
      or (select count(*) = 2
            from public.attendance_half_verifications h
           where h.period_month = date_trunc('month', p_period_month)::date
             and h.finance_verified_at is not null
             and (h.client_id = p_client_id or (p_client_id is null and h.category = p_category)));
$$;

comment on function public.attendance_month_cleared(uuid, text, date) is
  'Payroll gate (0493): true when both halves of the month are Finance-verified for the client/group, or a pre-0493 monthly OPS verification exists. RLS-scoped (invoker).';

grant execute on function public.attendance_half_of(date) to authenticated;
grant execute on function public.attendance_half_bounds(date, int) to authenticated;
grant execute on function public.attendance_date_verified(uuid, text, date) to authenticated;
grant execute on function public.attendance_month_cleared(uuid, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The lock: an HR-verified half refuses edits to its attendance.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_attendance_half_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_emp uuid; v_date date; v_client uuid; v_cat text;
begin
  if public.is_maintenance_session() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then v_emp := old.employee_id; v_date := old.attendance_date;
  else v_emp := new.employee_id; v_date := new.attendance_date; end if;
  select client_id, category into v_client, v_cat from public.employees where id = v_emp;
  -- Relievers are scoped by the site's client on the row (0449), as in the
  -- monthly lock.
  if v_cat = 'reliever' then
    v_client := case when tg_op = 'DELETE' then old.worked_for_client_id else new.worked_for_client_id end;
    v_cat := null;
  end if;
  if v_client is null and v_cat is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if public.attendance_date_verified(v_client, case when v_client is null then v_cat end, v_date) then
    raise exception 'Attendance for % is in a half-month that HR has verified, so it is locked. Ops must send it back to HR before it can be edited.',
      to_char(v_date, 'DD Mon YYYY');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists enforce_attendance_half_lock on public.attendance_records;
create trigger enforce_attendance_half_lock
  before insert or update or delete on public.attendance_records
  for each row execute function public.enforce_attendance_half_lock();

-- No new legacy monthly verifications. Existing ones stay valid; deleting one
-- (Un-verify) still works.
create or replace function public.refuse_new_monthly_attendance_verification()
returns trigger
language plpgsql
as $$
begin
  if public.is_maintenance_session() then return new; end if;
  raise exception 'Monthly OPS Verify has been replaced by half-month verification (HR, then Ops, then Finance). Update the app and verify each half on the Monthly Board.';
end;
$$;

drop trigger if exists refuse_new_monthly_attendance_verification on public.attendance_month_verifications;
create trigger refuse_new_monthly_attendance_verification
  before insert on public.attendance_month_verifications
  for each row execute function public.refuse_new_monthly_attendance_verification();

-- ---------------------------------------------------------------------------
-- 7. Separation purge skips verified halves (surgery, one anchor).
-- ---------------------------------------------------------------------------
do $$
declare v_def text; v_hits int;
  a text := '    and not exists (select 1 from attendance_month_verifications v';
  r text := '    and not public.attendance_date_verified(' ||
            'case when new.category::text = ''reliever'' then a.worked_for_client_id else new.client_id end, ' ||
            'case when new.category::text = ''reliever'' then null else new.category::text end, ' ||
            'a.attendance_date)' || chr(10) ||
            '    and not exists (select 1 from attendance_month_verifications v';
begin
  v_def := pg_get_functiondef('public.purge_attendance_after_separation()'::regprocedure);
  if position('attendance_date_verified' in v_def) > 0 then
    return;  -- already amended
  end if;
  v_hits := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
  if v_hits <> 1 then
    raise exception '0493 REFUSED: purge_attendance_after_separation anchor appears %, expected 1.', v_hits;
  end if;
  execute replace(v_def, a, r);
end $$;

-- ---------------------------------------------------------------------------
-- 8. The writers.
-- ---------------------------------------------------------------------------

-- p_action: hr_verify | ops_verify | finance_verify
--           undo_hr | undo_ops | undo_finance   (withdraw your own stage)
--           return_to_hr  (Ops sends back; clears HR)   — p_note required
--           return_to_ops (Finance sends back; clears Ops) — p_note required
create or replace function public.attendance_half_action(
  p_client_id uuid, p_category text, p_period_month date, p_half int,
  p_action text, p_note text default null)
returns public.attendance_half_verifications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_month   date := date_trunc('month', p_period_month)::date;
  v_end     date;
  v_row     public.attendance_half_verifications;
  v_me      uuid := auth.uid();
  v_name    text;
  v_n       int;
begin
  if p_client_id is not null then
    perform public.assert_same_company((select company_id from public.clients where id = p_client_id));
  end if;
  if (p_client_id is null) = (p_category is null) then
    raise exception 'Give exactly one of a client or a staff group.';
  end if;
  if p_half not in (1, 2) then raise exception 'Half must be 1 or 2.'; end if;

  v_company := coalesce((select company_id from public.clients where id = p_client_id),
                        public.current_company_id());
  if v_company is null then raise exception 'No company is selected.'; end if;

  -- The stage key, not the table key (CLAUDE.md, the stage exception).
  perform public.require_perm(case
    when p_action in ('hr_verify', 'undo_hr') then 'attendance.hr_verify'
    when p_action in ('ops_verify', 'undo_ops', 'return_to_hr') then 'attendance.ops_verify'
    when p_action in ('finance_verify', 'undo_finance', 'return_to_ops') then 'attendance.finance_verify'
    else 'attendance.__unknown_action__' end);

  if p_action in ('return_to_hr', 'return_to_ops') and coalesce(btrim(p_note), '') = '' then
    raise exception 'Say why it is being sent back.';
  end if;

  -- Frozen once payroll has left Draft for this scope and month.
  if exists (select 1 from public.payroll_run_phases ph
              where ph.period_month = v_month
                and ph.phase in ('review', 'finance_verify')
                and (ph.client_id = p_client_id or (p_client_id is null and ph.category = p_category))) then
    raise exception 'Payroll for this month has moved past Draft, so its attendance verification is frozen. Move payroll back to Draft first.';
  end if;

  select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = v_me;

  select * into v_row from public.attendance_half_verifications h
   where h.company_id = v_company and h.period_month = v_month and h.half = p_half
     and coalesce(h.client_id::text, 'cat:' || h.category)
         = coalesce(p_client_id::text, 'cat:' || p_category)
   for update;

  if p_action = 'hr_verify' then
    select half_end into v_end from public.attendance_half_bounds(v_month, p_half);
    if v_end >= current_date then
      raise exception 'This half ends on %. It can be verified from the next day.', to_char(v_end, 'DD Mon YYYY');
    end if;
    if v_row.hr_verified_at is not null then raise exception 'HR has already verified this half.'; end if;
    insert into public.attendance_half_verifications as h
      (company_id, client_id, category, period_month, half,
       hr_verified_by, hr_verified_by_name, hr_verified_at, updated_at)
    values (v_company, p_client_id, case when p_client_id is null then p_category end, v_month, p_half,
            v_me, v_name, now(), now())
    on conflict (company_id, period_month, half, coalesce(client_id::text, 'cat:' || category))
    do update set hr_verified_by = excluded.hr_verified_by,
                  hr_verified_by_name = excluded.hr_verified_by_name,
                  hr_verified_at = excluded.hr_verified_at,
                  updated_at = now()
    returning h.* into v_row;
    get diagnostics v_n = row_count;

  elsif p_action = 'ops_verify' then
    if v_row.hr_verified_at is null then raise exception 'HR has not verified this half yet.'; end if;
    if v_row.ops_verified_at is not null then raise exception 'Ops has already verified this half.'; end if;
    update public.attendance_half_verifications
       set ops_verified_by = v_me, ops_verified_by_name = v_name, ops_verified_at = now(), updated_at = now()
     where id = v_row.id returning * into v_row;
    get diagnostics v_n = row_count;

  elsif p_action = 'finance_verify' then
    if v_row.ops_verified_at is null then raise exception 'Ops has not verified this half yet.'; end if;
    if v_row.finance_verified_at is not null then raise exception 'Finance has already verified this half.'; end if;
    update public.attendance_half_verifications
       set finance_verified_by = v_me, finance_verified_by_name = v_name, finance_verified_at = now(), updated_at = now()
     where id = v_row.id returning * into v_row;
    get diagnostics v_n = row_count;

  elsif p_action = 'undo_hr' then
    if v_row.hr_verified_at is null then raise exception 'HR has not verified this half.'; end if;
    if v_row.ops_verified_at is not null then raise exception 'Ops has already verified this half; Ops must send it back first.'; end if;
    update public.attendance_half_verifications
       set hr_verified_by = null, hr_verified_by_name = null, hr_verified_at = null, updated_at = now()
     where id = v_row.id returning * into v_row;
    get diagnostics v_n = row_count;

  elsif p_action in ('undo_ops', 'return_to_hr') then
    if p_action = 'undo_ops' and v_row.ops_verified_at is null then raise exception 'Ops has not verified this half.'; end if;
    if p_action = 'return_to_hr' and v_row.hr_verified_at is null then raise exception 'HR has not verified this half, so there is nothing to send back.'; end if;
    if v_row.finance_verified_at is not null then raise exception 'Finance has already verified this half; Finance must send it back first.'; end if;
    update public.attendance_half_verifications
       set ops_verified_by = null, ops_verified_by_name = null, ops_verified_at = null,
           hr_verified_by      = case when p_action = 'return_to_hr' then null else hr_verified_by end,
           hr_verified_by_name = case when p_action = 'return_to_hr' then null else hr_verified_by_name end,
           hr_verified_at      = case when p_action = 'return_to_hr' then null else hr_verified_at end,
           updated_at = now()
     where id = v_row.id returning * into v_row;
    get diagnostics v_n = row_count;

  elsif p_action in ('undo_finance', 'return_to_ops') then
    if p_action = 'undo_finance' and v_row.finance_verified_at is null then raise exception 'Finance has not verified this half.'; end if;
    if p_action = 'return_to_ops' and v_row.ops_verified_at is null then raise exception 'Ops has not verified this half, so there is nothing to send back.'; end if;
    update public.attendance_half_verifications
       set finance_verified_by = null, finance_verified_by_name = null, finance_verified_at = null,
           ops_verified_by      = case when p_action = 'return_to_ops' then null else ops_verified_by end,
           ops_verified_by_name = case when p_action = 'return_to_ops' then null else ops_verified_by_name end,
           ops_verified_at      = case when p_action = 'return_to_ops' then null else ops_verified_at end,
           updated_at = now()
     where id = v_row.id returning * into v_row;
    get diagnostics v_n = row_count;

  else
    raise exception 'Unknown action %.', p_action;
  end if;

  if coalesce(v_n, 0) <> 1 then
    raise exception 'Attendance verification did not change (% rows). Reload the board and try again.', coalesce(v_n, 0);
  end if;

  if p_action in ('return_to_hr', 'return_to_ops') then
    insert into public.attendance_board_remarks
      (company_id, client_id, category, period_month, half, kind, body, author_id, author_name)
    values (v_company, p_client_id, case when p_client_id is null then p_category end, v_month, p_half,
            'returned',
            case when p_action = 'return_to_hr' then 'Sent back to HR: ' else 'Sent back to Ops: ' end || btrim(p_note),
            v_me, v_name);
  end if;

  return v_row;
end;
$$;

comment on function public.attendance_half_action(uuid, text, date, int, text, text) is
  'The only writer of attendance_half_verifications (0493). Each action asks its own stage key: hr_verify/undo_hr -> attendance.hr_verify; ops_verify/undo_ops/return_to_hr -> attendance.ops_verify; finance_verify/undo_finance/return_to_ops -> attendance.finance_verify. Single row by full key, row count asserted. Frozen once payroll leaves Draft.';

revoke all on function public.attendance_half_action(uuid, text, date, int, text, text) from public;
grant execute on function public.attendance_half_action(uuid, text, date, int, text, text) to authenticated;

create or replace function public.attendance_board_remark(
  p_client_id uuid, p_category text, p_period_month date, p_half int,
  p_body text, p_parent_id uuid default null)
returns public.attendance_board_remarks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_parent  public.attendance_board_remarks;
  v_row     public.attendance_board_remarks;
  v_name    text;
begin
  if p_client_id is not null then
    perform public.assert_same_company((select company_id from public.clients where id = p_client_id));
  end if;
  if p_parent_id is not null then
    perform public.assert_same_company((select company_id from public.attendance_board_remarks where id = p_parent_id));
  end if;
  if (p_client_id is null) = (p_category is null) then
    raise exception 'Give exactly one of a client or a staff group.';
  end if;
  if not (public.has_perm('attendance.view') or public.has_perm('attendance.edit')
          or public.has_perm('attendance.hr_verify') or public.has_perm('attendance.ops_verify')
          or public.has_perm('attendance.finance_verify')) then
    raise exception 'permission denied: attendance access required' using errcode = '42501';
  end if;
  if coalesce(btrim(p_body), '') = '' then raise exception 'Write something first.'; end if;

  v_company := coalesce((select company_id from public.clients where id = p_client_id),
                        public.current_company_id());

  if p_parent_id is not null then
    select * into v_parent from public.attendance_board_remarks where id = p_parent_id;
    if v_parent.parent_id is not null then
      raise exception 'Reply to the original remark, not to a reply.';
    end if;
    if v_parent.period_month <> date_trunc('month', p_period_month)::date or v_parent.half <> p_half
       or coalesce(v_parent.client_id::text, 'cat:' || v_parent.category)
          <> coalesce(p_client_id::text, 'cat:' || p_category) then
      raise exception 'That remark belongs to a different board.';
    end if;
  end if;

  select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();

  insert into public.attendance_board_remarks
    (company_id, client_id, category, period_month, half, parent_id, kind, body, author_id, author_name)
  values (v_company, p_client_id, case when p_client_id is null then p_category end,
          date_trunc('month', p_period_month)::date, p_half, p_parent_id,
          case when p_parent_id is null then 'remark' else 'reply' end,
          btrim(p_body), auth.uid(), v_name)
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.attendance_board_remark(uuid, text, date, int, text, uuid) is
  'Post a remark, or a reply to one, on a half-month attendance board (0493). Stamps the author from auth.uid(). Replies are one level deep.';

revoke all on function public.attendance_board_remark(uuid, text, date, int, text, uuid) from public;
grant execute on function public.attendance_board_remark(uuid, text, date, int, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Checks.
-- ---------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.permission_keys
       where key in ('attendance.hr_verify', 'attendance.ops_verify', 'attendance.finance_verify')) <> 3 then
    raise exception '0493 FAILED: a stage key is missing from permission_keys.';
  end if;
  if position('attendance_date_verified' in
              pg_get_functiondef('public.purge_attendance_after_separation()'::regprocedure)) = 0 then
    raise exception '0493 FAILED: separation purge was not amended.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'enforce_attendance_half_lock'
                   and tgrelid = 'public.attendance_records'::regclass) then
    raise exception '0493 FAILED: half lock trigger missing.';
  end if;
end $$;

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
