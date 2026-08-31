-- 0238 — Close the three remaining prod/dev schema differences.
--
-- Every statement is idempotent and is a NO-OP against production, which
-- already has all three. This exists because dev did not, and dev is the
-- environment everything is now verified against: it cannot diverge from
-- production while being the place we decide whether things work.
--
-- HOW DEV GOT HERE, WHICH IS THE PART WORTH REMEMBERING
--
-- Two of the three come from 0109b_regional_receivables_and_invoicing. Dev's
-- ledger records 0109b as applied. Dev has neither the invoice_reminders
-- trigger nor the real regional_scorecard that 0109b creates.
--
-- That is not drift. Dev's schema_migrations rows were inserted by hand —
-- 257 rows, every version in the short '0109b' form rather than a timestamp,
-- every `statements` NULL, no runner involved. So a dev row asserts that a
-- migration ran without any evidence that it did, and here are two effects of a
-- migration dev claims to have applied and demonstrably has not.
--
-- Nothing can reason about what dev has had done to it until that is fixed;
-- see scripts/backfill-migration-sql.mjs.

-- ---------------------------------------------------------------------------
-- 1. attendance_confirmations — drop the superseded site-scoped unique.
-- ---------------------------------------------------------------------------
-- 0126 created `unique (site_id, shift_code, attendance_date)`. 0195 replaced it
-- with a company/group_key unique index and 0234 made client_id and site_id
-- nullable, but nothing ever dropped the original. Production dropped it by
-- hand; the repo never recorded the drop, so dev still carries it.
--
-- It is actively wrong now, not merely redundant. A category-scoped
-- confirmation — group_key like 'cat:office_staff' — names no site, and in
-- Postgres a UNIQUE constraint does not compare NULLs, so the FIRST such row per
-- shift and date is accepted and further ones are too... until two rows share a
-- non-null site. The real damage is narrower and worse: production holds 436
-- confirmations with NULL site_id today, and a dev rebuilt from prod data has to
-- accept them. 0195's index is the constraint that actually expresses the rule.
alter table public.attendance_confirmations
  drop constraint if exists attendance_confirmations_site_id_shift_code_attendance_date_key;

-- ---------------------------------------------------------------------------
-- 2. invoice_reminders — the company-fill trigger from 0109b.
-- ---------------------------------------------------------------------------
-- Without it a reminder inserted without an explicit company_id keeps a NULL
-- one, which then fails every RLS policy on the table and belongs to no tenant.
-- The trigger is named trg_aaa_* so it sorts first: Postgres fires same-timing
-- triggers in alphabetical order, and company_id has to be populated before any
-- policy or downstream trigger reads it.
drop trigger if exists trg_aaa_invrem_fill_company on public.invoice_reminders;
create trigger trg_aaa_invrem_fill_company
  before insert on public.invoice_reminders
  for each row execute function public.fill_company_id();

-- ---------------------------------------------------------------------------
-- 3. regional_scorecard — the real inter-region balance.
-- ---------------------------------------------------------------------------
-- 0100 shipped the column as `null::numeric ... -- pending §7` and 0109b filled
-- it in with interregion_net_position(). Dev is still on 0100's stub, so the
-- column reads NULL for every region rather than the balance. Redefined here
-- rather than left to 0109b because a view that silently reports NULL where a
-- number belongs is the kind of thing that gets read as "zero".
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

-- ---------------------------------------------------------------------------
-- 4. partner_account_entries — one foreign key, one name.
-- ---------------------------------------------------------------------------
-- Identical constraint, two names: production calls it fk_pae_cash_location,
-- dev got Postgres's auto-generated partner_account_entries_cash_location_id_fkey.
-- Cosmetic in behaviour and permanent in a schema diff, which is the problem —
-- a difference that can never be resolved teaches whoever runs the diff next to
-- skip a line, and the next real difference hides behind that habit.
-- Production's name wins because it is the one already in use.
do $rename_fk$
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'public.partner_account_entries'::regclass
                and conname = 'partner_account_entries_cash_location_id_fkey')
     and not exists (select 1 from pg_constraint
              where conrelid = 'public.partner_account_entries'::regclass
                and conname = 'fk_pae_cash_location') then
    alter table public.partner_account_entries
      rename constraint partner_account_entries_cash_location_id_fkey to fk_pae_cash_location;
  end if;
end
$rename_fk$;

-- ---------------------------------------------------------------------------
-- Assert, rather than trust, that all of it landed.
-- ---------------------------------------------------------------------------
do $verify$
declare v_problems text[] := '{}';
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.partner_account_entries'::regclass
                    and conname = 'fk_pae_cash_location') then
    v_problems := v_problems || 'partner_account_entries cash-location FK not named fk_pae_cash_location';
  end if;

  if exists (select 1 from pg_constraint
              where conrelid = 'public.attendance_confirmations'::regclass
                and conname = 'attendance_confirmations_site_id_shift_code_attendance_date_key') then
    v_problems := v_problems || 'superseded site-scoped unique still present';
  end if;

  if not exists (select 1 from pg_trigger t
                   join pg_class c on c.oid = t.tgrelid
                  where c.relname = 'invoice_reminders'
                    and t.tgname = 'trg_aaa_invrem_fill_company') then
    v_problems := v_problems || 'invoice_reminders company-fill trigger missing';
  end if;

  if exists (select 1 from information_schema.views
              where table_schema = 'public' and table_name = 'regional_scorecard'
                and view_definition like '%NULL::numeric AS inter_region_balance%') then
    v_problems := v_problems || 'regional_scorecard still stubs inter_region_balance';
  end if;

  if array_length(v_problems, 1) > 0 then
    raise exception '0238 did not converge: %', array_to_string(v_problems, '; ')
      using errcode = '23514';
  end if;
end
$verify$;
