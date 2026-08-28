-- ---------------------------------------------------------------------------
-- 0202 — renew_contract(): clone an expiring/expired contract onto a new term.
--
-- Renewing by hand meant re-keying the whole contract — every term, every line,
-- every rate — and getting one number wrong silently changes what the client is
-- billed. This copies the source contract in one transaction and asks the caller
-- for nothing but the new dates.
--
-- What it does:
--   • Inserts a new contract with every business term copied from the source and
--     the caller's new start/end (or open-ended). Status is 'active'.
--   • Copies every contract_line verbatim, including site, shift, rates and
--     relief settings. Sites belong to the CLIENT, not the contract, so the
--     site_id references stay valid. required_on_ground is a generated column
--     and recomputes itself, so it is not copied.
--   • Marks the source contract 'expired' — a renewal supersedes it, and leaving
--     two active contracts would double-count committed headcount.
--   • Re-points employees pinned to the old contract at the new one. Without
--     this the renewal would be cosmetic: every guard carrying the old
--     contract_id would still hit "Contract ... ended" on the attendance window
--     the day after the old term ran out.
--
-- Deliberately NOT copied:
--   • contract_code — the trigger assigns a fresh one; a renewal is its own
--     contract with its own identity.
--   • The Drive document (drive_file_id / drive_view_url / contract_file_name) —
--     a renewal is signed on a new piece of paper. Upload it to the new record.
--   • Addendums — they were dated amendments to the OLD term. Anything still in
--     force should be written into the new contract's lines.
--   • termination_date.
-- ---------------------------------------------------------------------------
create or replace function public.renew_contract(
  p_contract_id uuid,
  p_start_date  date,
  p_end_date    date default null,
  p_is_infinite boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  src public.contracts%rowtype;
  new_id uuid;
begin
  select * into src from public.contracts where id = p_contract_id;
  if src.id is null then
    raise exception 'Contract not found' using errcode = '23503';
  end if;

  if p_start_date is null then
    raise exception 'A renewal needs a start date' using errcode = '23514';
  end if;
  if not coalesce(p_is_infinite, false) and p_end_date is null then
    raise exception 'A renewal needs an end date, or must be marked open-ended'
      using errcode = '23514';
  end if;
  if not coalesce(p_is_infinite, false) and p_end_date < p_start_date then
    raise exception 'The renewal end date cannot be before its start date'
      using errcode = '23514';
  end if;

  insert into public.contracts (
    company_id, client_id, contract_type,
    start_date, end_date, is_infinite,
    number_of_guards, shift_pattern, rate_per_guard_per_month,
    allowed_leaves_per_month, eobi_deduction, eobi_amount,
    annual_escalation_pct, auto_invoice_enabled, renewal_terms,
    day_guards, night_guards, evening_guards, guard_rates,
    notice_period_days, status
  ) values (
    src.company_id, src.client_id, src.contract_type,
    p_start_date,
    case when coalesce(p_is_infinite, false) then null else p_end_date end,
    coalesce(p_is_infinite, false),
    src.number_of_guards, src.shift_pattern, src.rate_per_guard_per_month,
    src.allowed_leaves_per_month, src.eobi_deduction, src.eobi_amount,
    src.annual_escalation_pct, src.auto_invoice_enabled, src.renewal_terms,
    src.day_guards, src.night_guards, src.evening_guards, src.guard_rates,
    src.notice_period_days, 'active'
  )
  returning id into new_id;

  insert into public.contract_lines (
    company_id, contract_id, category, label, location,
    committed_count, unit_rate, cost_components, taxable,
    site_id, shift_code, billed_qty, relief_allowance,
    relief_mode, billing_rate, client_ot_rate,
    effective_from, effective_to
  )
  select
    l.company_id, new_id, l.category, l.label, l.location,
    l.committed_count, l.unit_rate, l.cost_components, l.taxable,
    l.site_id, l.shift_code, l.billed_qty, l.relief_allowance,
    l.relief_mode, l.billing_rate, l.client_ot_rate,
    l.effective_from, l.effective_to
  from public.contract_lines l
  where l.contract_id = p_contract_id;

  update public.contracts set status = 'expired' where id = p_contract_id;
  update public.employees set contract_id = new_id where contract_id = p_contract_id;

  return new_id;
end $$;

grant execute on function public.renew_contract(uuid, date, date, boolean) to authenticated;
