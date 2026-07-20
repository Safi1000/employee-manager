-- Salaried reward architecture (spec section 13).
--
-- Salaried staff get "reward lines: appreciation-adjusted base, bonus payouts,
-- Eid, deductions. Salaried payslip PDF shows the reward architecture."
--
-- The payslip aggregates (bonus, deductions) stay as the totals the ledger and
-- guard stream already use. This adds the STRUCTURED breakdown behind those
-- totals so the salaried PDF can itemise where the reward came from, and keeps
-- the payslip's bonus/deduction totals in step with the lines by trigger — so
-- the itemisation and the total can never disagree.

do $$ begin
  create type public.reward_line_kind as enum
    ('appreciation', 'bonus', 'eid', 'other_earning', 'deduction');
exception when duplicate_object then null; end $$;

create table if not exists public.payslip_reward_lines (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  payslip_id  uuid not null references public.payslips(id) on delete cascade,
  kind        public.reward_line_kind not null,
  label       text not null,
  -- Always positive; `kind` decides whether it adds to earnings or subtracts.
  amount      numeric(16,2) not null check (amount >= 0),
  created_at  timestamptz not null default now()
);

create index if not exists idx_prl_payslip on public.payslip_reward_lines(payslip_id);

drop trigger if exists trg_aaa_prl_fill_company on public.payslip_reward_lines;
create trigger trg_aaa_prl_fill_company
  before insert on public.payslip_reward_lines
  for each row execute function public.fill_company_id();

alter table public.payslip_reward_lines enable row level security;
drop policy if exists "ssa_all" on public.payslip_reward_lines;
create policy "ssa_all" on public.payslip_reward_lines for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "via_payslip" on public.payslip_reward_lines;
create policy "via_payslip" on public.payslip_reward_lines for all
  using (exists (select 1 from public.payslips p
                  where p.id = payslip_id and p.company_id = public.current_company_id()))
  with check (exists (select 1 from public.payslips p
                  where p.id = payslip_id and p.company_id = public.current_company_id()));

-- ---------------------------------------------------------------------------
-- Keep the payslip's bonus/deduction totals equal to the sum of the lines.
-- Earnings kinds roll into `bonus`; deduction kinds roll into `deductions`.
-- Reworks final_salary/net_salary by the same delta so the take-home stays
-- consistent without re-deriving the whole payroll formula here.
--
-- Refuses to touch a payslip whose run is locked (approved+), so reward edits
-- respect the same gate as every other pay figure.
-- ---------------------------------------------------------------------------

create or replace function public.sync_payslip_reward_totals()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_payslip   uuid := coalesce(new.payslip_id, old.payslip_id);
  v_earn      numeric;
  v_deduct    numeric;
  p           record;
  v_run_status public.payroll_run_status;
  v_base_net  numeric;
begin
  select coalesce(sum(amount) filter (where kind <> 'deduction'), 0),
         coalesce(sum(amount) filter (where kind = 'deduction'), 0)
    into v_earn, v_deduct
    from public.payslip_reward_lines where payslip_id = v_payslip;

  select * into p from public.payslips where id = v_payslip;
  if not found then return null; end if;

  -- Respect the run lock rather than silently failing the payslip update.
  if p.payroll_run_id is not null then
    select status into v_run_status from public.payroll_runs where id = p.payroll_run_id;
    if v_run_status in ('approved', 'disbursed', 'completed') then
      raise exception 'payroll run is % and locked; reward lines cannot change', v_run_status
        using errcode = '23514';
    end if;
  end if;

  -- net = base + allowance + bonus - deductions - advance - income_tax - eobi.
  -- Recompute from the parts we own so reward edits flow straight to take-home.
  v_base_net := coalesce(p.base_salary,0) + coalesce(p.allowance,0)
              + v_earn - v_deduct - coalesce(p.advance,0)
              - coalesce(p.income_tax,0) - coalesce(p.eobi,0);

  update public.payslips set
    bonus        = v_earn,
    deductions   = v_deduct,
    final_salary = coalesce(p.base_salary,0) + coalesce(p.allowance,0) + v_earn - v_deduct,
    net_salary   = v_base_net,
    updated_at   = now()
  where id = v_payslip;

  return null;
end;
$$;

drop trigger if exists trg_prl_sync_totals on public.payslip_reward_lines;
create trigger trg_prl_sync_totals
  after insert or update or delete on public.payslip_reward_lines
  for each row execute function public.sync_payslip_reward_totals();

-- The reward architecture for a payslip, ready for the PDF.
create or replace view public.payslip_reward_breakdown
  with (security_invoker = true) as
  select rl.payslip_id,
         rl.company_id,
         rl.kind,
         rl.label,
         rl.amount,
         case when rl.kind = 'deduction' then -rl.amount else rl.amount end as signed_amount
    from public.payslip_reward_lines rl;
