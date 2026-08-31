-- 0109b — §5 Regional revenue & receivables ownership + §10 invoicing + §22 scorecard
--
-- RECOVERED from supabase_migrations.schema_migrations on 2026-08-31, where it
-- is recorded as `0109_regional_receivables_and_invoicing`. It was applied
-- directly to the database and never written back to the repo, while the repo's
-- own 0109 slot was taken by `0109_fire_clearance_salary_and_attendance_window`.
-- Committed here as 0109b so both keep their identity and this still sorts
-- before 0110, which depends on it. See docs/MIGRATION_DIVERGENCE.md.
--
-- Two things later migrations correct, left as they were so the sequence is
-- faithful:
--   * invoice status is written lowercase ('written_off' / 'paid'); 0110 aligns
--     it with the capitalised vocabulary the rest of the app uses.
--   * attendance_billing_suggestion is declared with OUT names
--     (billable_guard_days, standard_days, rate_per_guard, suggested_amount).
--     0224 renames them, which is why it needs an explicit DROP FUNCTION first.

alter table public.clients
  add column if not exists workout_account          boolean not null default false,
  add column if not exists credit_ceiling           numeric(16,2),
  add column if not exists receivable_owner_branch_id uuid references public.branches(id),
  add column if not exists attendance_billing        boolean not null default false;

comment on column public.clients.receivable_owner_branch_id is
  'Overrides which region owns this client''s receivables/aging (§5 legacy carve-out). Null = client''s operating region.';

-- finance_settings already exists (HO allocation etc.) — extend it.
alter table public.finance_settings
  add column if not exists bad_debt_bearer       text not null default 'region',
  add column if not exists reminder_cadence_days integer[] not null default '{0,7,15,30,45}',
  add column if not exists workout_credit_bypass boolean not null default true;

do $$ begin
  alter table public.finance_settings
    add constraint finance_settings_bad_debt_bearer_chk
    check (bad_debt_bearer in ('region','head_office'));
exception when duplicate_object then null; end $$;

insert into public.finance_settings (company_id)
select id from public.companies
on conflict (company_id) do nothing;

insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, active)
select c.id, '6700', 'Bad Debt Expense', 'expense', 'debit', 'bad_debt_expense', true, true
  from public.companies c
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = 'bad_debt_expense');

create or replace function public.receivable_owner_region(p_client_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(c.receivable_owner_branch_id, public.region_for_client(p_client_id))
    from public.clients c where c.id = p_client_id;
$$;

create or replace function public.write_off_receivable(p_invoice_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  inv record; v_bearer text; v_region uuid; v_out numeric(16,2); v_bad uuid; v_ar uuid;
begin
  if coalesce(trim(p_reason),'') = '' then
    raise exception 'a write-off reason is required' using errcode='23514';
  end if;
  select * into inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'invoice % not found', p_invoice_id using errcode='23503'; end if;
  v_out := coalesce(inv.total_due, inv.invoice_amount, 0) - coalesce(inv.amount_received, 0);
  if v_out <= 0 then
    raise exception 'invoice has nothing outstanding to write off' using errcode='23514';
  end if;
  select bad_debt_bearer into v_bearer from public.finance_settings where company_id = inv.company_id;
  if coalesce(v_bearer,'region') = 'head_office' then
    v_region := public.head_office_region(inv.company_id);
  else
    v_region := public.receivable_owner_region(inv.client_id);
  end if;
  select id into v_bad from public.chart_of_accounts
    where company_id = inv.company_id and system_key = 'bad_debt_expense' limit 1;
  select id into v_ar  from public.chart_of_accounts
    where company_id = inv.company_id and system_key = 'ar' limit 1;
  perform public.post_journal(
    inv.company_id, current_date,
    'Bad debt write-off: '||coalesce(inv.invoice_number,'')||' — '||p_reason,
    'invoices', inv.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_bad, 'debit',  v_out, 'credit', 0),
      jsonb_build_object('account_id', v_ar,  'debit', 0,       'credit', v_out)
    ),
    v_region);
  update public.invoices
     set status = 'written_off',
         notes  = coalesce(notes,'')||' [written off '||current_date||': '||p_reason||']',
         updated_at = now()
   where id = p_invoice_id;
end;
$$;

create or replace view public.regional_receivables_aging
  with (security_invoker = true) as
  with open_inv as (
    select i.company_id,
           public.receivable_owner_region(i.client_id) as owner_region,
           c.workout_account,
           (coalesce(i.total_due, i.invoice_amount, 0) - coalesce(i.amount_received,0)) as outstanding,
           (current_date - i.invoice_date) as age_days
      from public.invoices i
      join public.clients c on c.id = i.client_id
     where coalesce(i.status,'') <> 'written_off'
       and (coalesce(i.total_due, i.invoice_amount, 0) - coalesce(i.amount_received,0)) > 0
  )
  select o.company_id,
         o.owner_region as branch_id,
         b.name as region_name,
         o.workout_account,
         sum(o.outstanding)                                              as total_outstanding,
         sum(o.outstanding) filter (where o.age_days <= 30)              as bucket_current,
         sum(o.outstanding) filter (where o.age_days between 31 and 60)  as bucket_31_60,
         sum(o.outstanding) filter (where o.age_days between 61 and 90)  as bucket_61_90,
         sum(o.outstanding) filter (where o.age_days > 90)               as bucket_90_plus,
         round(coalesce(sum(o.outstanding * o.age_days) / nullif(sum(o.outstanding),0), 0), 1) as dso_weighted_days
    from open_inv o
    join public.branches b on b.id = o.owner_region
   group by o.company_id, o.owner_region, b.name, o.workout_account;

create table if not exists public.invoice_reminders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  step_day    integer not null,
  channel     text,
  note        text,
  sent_by     uuid,
  sent_at     timestamptz not null default now(),
  unique (invoice_id, step_day)
);
create index if not exists idx_invrem_invoice on public.invoice_reminders(invoice_id);

drop trigger if exists trg_aaa_invrem_fill_company on public.invoice_reminders;
create trigger trg_aaa_invrem_fill_company
  before insert on public.invoice_reminders
  for each row execute function public.fill_company_id();

alter table public.invoice_reminders enable row level security;
drop policy if exists "ssa_all" on public.invoice_reminders;
create policy "ssa_all" on public.invoice_reminders for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.invoice_reminders;
create policy "company_members" on public.invoice_reminders for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

create or replace view public.due_invoice_reminders
  with (security_invoker = true) as
  with cad as (
    select i.id as invoice_id, i.company_id, i.client_id, i.invoice_number, i.invoice_date,
           cl.name as client_name, cl.workout_account,
           (coalesce(i.total_due,i.invoice_amount,0) - coalesce(i.amount_received,0)) as outstanding,
           (current_date - i.invoice_date) as age_days,
           unnest(coalesce(fs.reminder_cadence_days, '{0,7,15,30,45}'::int[])) as step_day
      from public.invoices i
      join public.clients cl on cl.id = i.client_id
      left join public.finance_settings fs on fs.company_id = i.company_id
     where coalesce(i.status,'') not in ('paid','written_off')
       and (coalesce(i.total_due,i.invoice_amount,0) - coalesce(i.amount_received,0)) > 0
  )
  select distinct on (invoice_id)
         invoice_id, company_id, client_id, client_name, invoice_number, invoice_date,
         outstanding, workout_account, age_days, step_day as due_step
    from cad c
   where c.age_days >= c.step_day
     and not exists (select 1 from public.invoice_reminders r
                      where r.invoice_id = c.invoice_id and r.step_day = c.step_day)
   order by invoice_id, step_day desc;

create or replace function public.log_invoice_reminder(
  p_invoice_id uuid, p_step_day integer, p_channel text default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from public.invoices where id = p_invoice_id;
  if v_company is null then raise exception 'invoice not found' using errcode='23503'; end if;
  insert into public.invoice_reminders (company_id, invoice_id, step_day, channel, note, sent_by)
  values (v_company, p_invoice_id, p_step_day, p_channel, p_note, auth.uid())
  on conflict (invoice_id, step_day) do nothing;
end;
$$;

create or replace function public.attendance_billing_suggestion(
  p_client_id uuid, p_period_start date, p_period_end date)
returns table (
  billable_guard_days integer, standard_days integer,
  rate_per_guard numeric, suggested_amount numeric
) language sql stable security definer set search_path = public as $$
  with days as (select (p_period_end - p_period_start + 1)::int as std),
  present as (
    select count(*)::int as gd from public.attendance_records a
     where a.worked_for_client_id = p_client_id
       and a.attendance_date between p_period_start and p_period_end
       and a.status = 'present'
  ),
  rate as (
    select coalesce(max(ct.rate_per_guard_per_month), 0) as r from public.contracts ct
     where ct.client_id = p_client_id and coalesce(ct.status::text,'active') = 'active'
  )
  select present.gd, days.std, rate.r,
         round(rate.r * present.gd / nullif(days.std,0), 2)
    from present, days, rate;
$$;

create or replace view public.regional_scorecard
  with (security_invoker = true) as
  select b.company_id, b.id as branch_id, b.name as region_name, b.kind as region_kind,
    (select count(*) from public.employees e
       where e.branch_id = b.id and e.lifecycle_state = 'active') as active_headcount,
    (select count(*) from public.incidents i
       where i.branch_id = b.id
         and extract(year from i.occurred_at) = extract(year from current_date)) as incidents_ytd,
    (select count(*) from public.no_show_events n
       where n.branch_id = b.id and n.event_date >= current_date - 30) as no_shows_30d,
    (select coalesce(sum(coalesce(i.total_due, i.invoice_amount) - i.amount_received), 0)
       from public.invoices i
      where i.branch_id = b.id and i.amount_received < coalesce(i.total_due, i.invoice_amount)) as receivables_outstanding,
    public.region_operating_profit(b.company_id, b.id, extract(year from current_date)::int) as profit_ytd,
    public.region_operating_profit(b.company_id, b.id, extract(year from current_date)::int - 1) as profit_prior_year,
    public.interregion_net_position(b.company_id, b.id) as inter_region_balance
   from public.branches b
  where b.active;
