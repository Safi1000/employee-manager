-- 0635 — the nightly controls are kept, so the Accountant page can read them.
--
-- Found in the 3 Nov 2026 audit: the Accountant page's "Controls red" tile
-- and its Checks tab call ledger_checks() live. It now takes 15–20 seconds;
-- a signed-in user's statement is cancelled at 8, so the page sat on
-- "running the nightly controls…" for ever and the red controls could not be
-- read in the app at all.
--
-- The nightly job already runs every check for every company at 05:00. This
-- keeps what it found: save_ledger_check_results() writes one row per check per
-- company per run into ledger_check_results, scheduled ten minutes after the
-- alert run, and the pages read the latest run (fast). Nothing about the
-- checks themselves changes, and the alert run is untouched.

create table public.ledger_check_results (
  id          bigserial primary key,
  company_id  uuid not null references public.companies(id),
  run_at      timestamptz not null,
  check_name  text not null,
  expected    numeric,
  actual      numeric,
  difference  numeric,
  passed      boolean not null
);
create index ledger_check_results_latest_idx on public.ledger_check_results (company_id, run_at desc);
comment on table public.ledger_check_results is
  'DECIDED 3 Nov 2026 (0635): what each nightly ledger_checks() run found, per company and check, so the Accountant page reads the result instead of re-running checks that outlast a user''s statement timeout. Figures are the checks'' own expected/actual/difference (counts or amounts). Written only by save_ledger_check_results(); read by finance.';
alter table public.ledger_check_results enable row level security;
create policy company_members on public.ledger_check_results for select
  using (company_id = (select public.current_company_id()));
create policy ssa_all on public.ledger_check_results for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
create policy perm_read on public.ledger_check_results as restrictive for select
  using ((select public.has_perm('accountant.view')) or (select public.has_perm('reports.view')) or (select public.has_perm('dashboard.ceo')));
create policy perm_write_ins on public.ledger_check_results as restrictive for insert with check (false);
create policy perm_write_upd on public.ledger_check_results as restrictive for update using (false) with check (false);
create policy perm_write_del on public.ledger_check_results as restrictive for delete using (false);
grant select on public.ledger_check_results to authenticated;

-- One run for every live company. A company that fails is skipped and the
-- others still run (the same shape as run_scheduled_ledger_checks). Keeps 60
-- days of runs.
create or replace function public.save_ledger_check_results()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_co   record;
  v_at   timestamptz := now();
  v_n    int := 0;
  v_rows int;
begin
  for v_co in select c.id from public.companies c where c.active and c.archived_at is null loop
    begin
      insert into public.ledger_check_results (company_id, run_at, check_name, expected, actual, difference, passed)
      select v_co.id, v_at, x.check_name, x.expected, x.actual, x.difference, x.passed
        from public.ledger_checks(v_co.id) x;
      get diagnostics v_rows = row_count;
      v_n := v_n + v_rows;
    exception when others then
      raise warning 'save_ledger_check_results: company % failed: %', v_co.id, sqlerrm;
    end;
  end loop;
  delete from public.ledger_check_results where run_at < now() - interval '60 days';
  return v_n;
end $$;
comment on function public.save_ledger_check_results() is
  '0635: keep tonight''s ledger_checks() result for every live company in ledger_check_results. Run by cron (ledger-check-results-daily, 05:10); not callable by users.';
revoke all on function public.save_ledger_check_results() from public, anon, authenticated;

do $sched$
begin
  if exists (select 1 from cron.job where jobname = 'ledger-check-results-daily') then
    perform cron.unschedule('ledger-check-results-daily');
  end if;
  perform cron.schedule('ledger-check-results-daily', '10 5 * * *', 'select public.save_ledger_check_results()');
end
$sched$;

-- The first run now, so the page has something to read today.
select public.save_ledger_check_results();

-- ───────────────────────── Tests ─────────────────────────
do $test$
declare
  v_co   uuid;
  v_n    int;
  v_live int;
  v_ran  int := 0;
begin
  select company_id into v_co from public.ledger_check_results order by run_at desc limit 1;
  if v_co is null then raise exception '0635 REFUSED: the first run kept nothing.'; end if;

  -- 1. The run kept every check the function evaluates, once each.
  select count(*) into v_n from public.ledger_check_results
   where company_id = v_co and run_at = (select max(run_at) from public.ledger_check_results where company_id = v_co);
  select count(*) into v_live from public.ledger_checks(v_co);
  if v_n <> v_live then raise exception '0635 REFUSED: kept % rows but ledger_checks returns %.', v_n, v_live; end if;
  v_ran := v_ran + 1;

  -- 2. The schedule exists.
  if not exists (select 1 from cron.job where jobname = 'ledger-check-results-daily' and schedule = '10 5 * * *') then
    raise exception '0635 REFUSED: the nightly schedule is missing.';
  end if;
  v_ran := v_ran + 1;

  if v_ran <> 2 then raise exception '0635 REFUSED: % of 2 assertions ran.', v_ran; end if;
  if exists (select 1 from public.security_gaps()) then raise exception '0635 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0635 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
