-- 0126: Phase 6 — attendance board by client-shift, exception marking, gating.
--
-- Spec §7, §8.1-8.10. Additive; existing 22,366 attendance_records kept.
-- Existing capitalized statuses (Present/Absent/Leave) are LEFT as-is; the new
-- board writes the spec's lowercase status set. Payroll counting reads both
-- (case-insensitive) — no risky rewrite of historical rows.
--
-- ASSUMPTIONS (spec-silent / data-driven, noted in report):
--  * client-shift keyed on (site, shift): scheduled_shift =
--    coalesce(deployment contract_line shift, employees.shift), since
--    deployments.contract_line_id is sparse.
--  * backdating limit n = 3 days (spec's own open-item recommendation).

-- ---------------------------------------------------------------------------
-- 1. Enums (§7, §8.3)
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname='attendance_source') then
    create type attendance_source as enum ('whatsapp','app','manual');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname='attendance_entry_type') then
    create type attendance_entry_type as enum ('normal','swap','double_duty','relief_cover');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. attendance_records new columns (§7)
-- ---------------------------------------------------------------------------
alter table public.attendance_records
  add column if not exists scheduled_shift      text,
  add column if not exists worked_shift         text,
  add column if not exists entry_type           attendance_entry_type not null default 'normal',
  add column if not exists swap_partner_id      uuid references public.employees(id) on delete set null,
  add column if not exists covering_for_guard_id uuid references public.employees(id) on delete set null,
  add column if not exists source               attendance_source,
  add column if not exists absent_reason        text,   -- awol / sick / absconded
  add column if not exists supervisor_override  boolean not null default false,
  add column if not exists override_reason      text;

-- Backfill worked/scheduled shift from the guard's shift so the new uniqueness
-- (guard, date, worked_shift) holds for existing one-per-day rows. The reliever
-- validation trigger is disabled around this mechanical backfill (it only sets
-- worked/scheduled shift; it does not touch reliever/status/worked_for_client_id).
alter table public.attendance_records disable trigger trg_attendance_records_enforce_reliever;

update public.attendance_records ar
set worked_shift    = coalesce(ar.worked_shift, e.shift, 'day'),
    scheduled_shift = coalesce(ar.scheduled_shift, e.shift, 'day')
from public.employees e
where e.id = ar.employee_id and (ar.worked_shift is null or ar.scheduled_shift is null);

update public.attendance_records
set worked_shift = coalesce(worked_shift,'day'), scheduled_shift = coalesce(scheduled_shift,'day')
where worked_shift is null or scheduled_shift is null;

alter table public.attendance_records enable trigger trg_attendance_records_enforce_reliever;

alter table public.attendance_records alter column worked_shift set not null;

-- ---------------------------------------------------------------------------
-- 3. Uniqueness (§7): (guard, date, worked_shift) — allows double duty.
-- ---------------------------------------------------------------------------
alter table public.attendance_records
  drop constraint if exists attendance_records_employee_id_attendance_date_key;
create unique index if not exists attendance_records_guard_date_shift_uidx
  on public.attendance_records (employee_id, attendance_date, worked_shift);

-- ---------------------------------------------------------------------------
-- 4. attendance_confirmations — the client-shift-day UNIT OF WORK (§8.1/8.2).
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_confirmations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  client_id        uuid not null references public.clients(id) on delete cascade,
  site_id          uuid not null references public.sites(id) on delete cascade,
  shift_code       text not null,
  attendance_date  date not null,
  contract_line_id uuid references public.contract_lines(id) on delete set null,
  supervisor_name  text not null,
  source           attendance_source not null default 'app',
  confirmed_by     uuid references auth.users(id) on delete set null,
  confirmed_at     timestamptz not null default now(),
  unique (site_id, shift_code, attendance_date)
);
create index if not exists attendance_confirmations_date_idx on public.attendance_confirmations(attendance_date);
create index if not exists attendance_confirmations_company_idx on public.attendance_confirmations(company_id);

drop trigger if exists trg_aaa_att_conf_fill_company on public.attendance_confirmations;
create trigger trg_aaa_att_conf_fill_company before insert on public.attendance_confirmations
  for each row execute function public.fill_company_id();
drop trigger if exists trg_zzz_att_conf_audit on public.attendance_confirmations;
create trigger trg_zzz_att_conf_audit after insert or update or delete on public.attendance_confirmations
  for each row execute function public.log_audit_change();

alter table public.attendance_confirmations enable row level security;
drop policy if exists "ssa_all" on public.attendance_confirmations;
create policy "ssa_all" on public.attendance_confirmations for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.attendance_confirmations;
create policy "company_members" on public.attendance_confirmations for all
  using (company_id = public.current_company_id()) with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 5. vacancies (§8.10) — raised when a posting closes with no replacement.
-- ---------------------------------------------------------------------------
create table if not exists public.vacancies (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  client_id         uuid not null references public.clients(id) on delete cascade,
  site_id           uuid references public.sites(id) on delete set null,
  contract_line_id  uuid references public.contract_lines(id) on delete set null,
  shift_code        text,
  opened_at         timestamptz not null default now(),
  opened_reason     text,
  vacated_by_guard_id uuid references public.employees(id) on delete set null,
  status            text not null default 'open',   -- open / filled / cancelled
  filled_at         timestamptz,
  filled_by_guard_id uuid references public.employees(id) on delete set null
);
create index if not exists vacancies_company_idx on public.vacancies(company_id);
create index if not exists vacancies_client_idx  on public.vacancies(client_id);
create index if not exists vacancies_status_idx  on public.vacancies(status);

drop trigger if exists trg_aaa_vacancies_fill_company on public.vacancies;
create trigger trg_aaa_vacancies_fill_company before insert on public.vacancies
  for each row execute function public.fill_company_id();
drop trigger if exists trg_zzz_vacancies_audit on public.vacancies;
create trigger trg_zzz_vacancies_audit after insert or update or delete on public.vacancies
  for each row execute function public.log_audit_change();

alter table public.vacancies enable row level security;
drop policy if exists "ssa_all" on public.vacancies;
create policy "ssa_all" on public.vacancies for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.vacancies;
create policy "company_members" on public.vacancies for all
  using (company_id = public.current_company_id()) with check (company_id = public.current_company_id());

-- 5b. Vacancy trigger: when a posting closes (end_date set) and no other active
--     posting exists on the same contract line / (site,shift), raise a vacancy.
create or replace function public.raise_vacancy_on_posting_close()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_still_active int;
begin
  if NEW.end_date is not null and (OLD.end_date is null)
     and NEW.reason in ('separation','return_to_pool') then
    -- any replacement still active on the same line (or same site) ?
    select count(*) into v_still_active from public.deployments d
      where d.end_date is null
        and d.guard_id <> NEW.guard_id
        and ( (NEW.contract_line_id is not null and d.contract_line_id = NEW.contract_line_id)
              or (NEW.contract_line_id is null and d.site_id = NEW.site_id) );
    if v_still_active = 0 then
      insert into public.vacancies (company_id, client_id, site_id, contract_line_id, opened_reason, vacated_by_guard_id)
      values (NEW.company_id, NEW.client_id, NEW.site_id, NEW.contract_line_id,
              'Posting closed (' || NEW.reason || ') with no replacement', NEW.guard_id);
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_raise_vacancy_on_posting_close on public.deployments;
create trigger trg_raise_vacancy_on_posting_close
  after update on public.deployments
  for each row execute function public.raise_vacancy_on_posting_close();

-- ---------------------------------------------------------------------------
-- 6. attendance_gate(guard, date) — §8.5 gating, first-match-wins, n=3 backdate.
--    Returns jsonb {mode, reason}. mode: blocked | override_required |
--    allowed_unposted | allowed.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_gate(p_guard uuid, p_date date, p_backdate_limit int default 3)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  e public.employees%rowtype;
  v_has_posting boolean;
begin
  select * into e from public.employees where id = p_guard;
  if e.id is null then return jsonb_build_object('mode','blocked','reason','Guard not found'); end if;

  if e.join_date is not null and p_date < e.join_date then
    return jsonb_build_object('mode','blocked','reason','Not employed before ' || to_char(e.join_date,'DD/MM/YYYY'));
  end if;
  if e.last_working_day is not null and p_date > e.last_working_day then
    return jsonb_build_object('mode','blocked','reason','Employment ended ' || to_char(e.last_working_day,'DD/MM/YYYY'));
  end if;
  if e.lifecycle_state = 'archived' then
    return jsonb_build_object('mode','blocked','reason','Record archived');
  end if;
  if exists (select 1 from public.accounting_periods ap
             where ap.company_id = e.company_id and ap.period_month = date_trunc('month', p_date)::date) then
    return jsonb_build_object('mode','blocked','reason','Payroll closed for ' || to_char(p_date,'Mon YYYY') || '. Post a reversal instead.');
  end if;
  if p_date < current_date - p_backdate_limit then
    return jsonb_build_object('mode','override_required','reason','Backdated beyond ' || p_backdate_limit || ' days — supervisor override required');
  end if;

  select exists (select 1 from public.deployments d
    where d.guard_id = p_guard and d.start_date <= p_date
      and (d.end_date is null or d.end_date >= p_date)) into v_has_posting;

  if v_has_posting then
    return jsonb_build_object('mode','allowed','reason',null);
  else
    return jsonb_build_object('mode','allowed_unposted','reason','No active posting — recorded against pool (not billable)');
  end if;
end $$;

grant execute on function public.attendance_gate(uuid, date, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. client_shift_roster(site, shift, date) — §8.6 roster (presume present).
--    scheduled_shift = coalesce(deployment line shift, employees.shift).
-- ---------------------------------------------------------------------------
create or replace function public.client_shift_roster(p_site uuid, p_shift text, p_date date)
returns table (guard_id uuid, full_name text, guard_code text, display_number int,
               employee_code text, client_id uuid, scheduled_shift text)
language sql stable security definer set search_path = public as $$
  select e.id, e.full_name, e.guard_code, e.display_number, e.employee_code, e.client_id,
         coalesce(cl.shift_code::text, e.shift) as scheduled_shift
  from public.deployments d
  join public.employees e on e.id = d.guard_id
  left join public.contract_lines cl on cl.id = d.contract_line_id
  where d.site_id = p_site
    and d.start_date <= p_date
    and (d.end_date is null or d.end_date >= p_date)
    and (e.join_date is null or e.join_date <= p_date)
    and (e.last_working_day is null or e.last_working_day >= p_date)
    and e.lifecycle_state <> 'archived'
    and coalesce(cl.shift_code::text, e.shift) = p_shift;
$$;

grant execute on function public.client_shift_roster(uuid, text, date) to authenticated;
