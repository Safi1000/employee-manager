-- 0316b — withholding_written_after_cutover() carries the tenant guard it was
-- written without.
--
-- FOUND BY 0286, ON THE DAY 0286 WAS WIRED
--
-- 0286 makes tenant_guard_gaps() a ledger check. The moment it landed on
-- crm-design the detector reported TWENTY uncovered parameters, not the
-- nineteen 0287 was written to close. The twentieth is:
--
--   withholding_written_after_cutover  p_company_id  claimed
--
-- which 0316 added THREE MIGRATIONS AGO, in this same session, while the
-- detector that would have caught it was not yet wired into anything that runs.
--
-- That is 0286's own thesis arriving on schedule:
--
--   A CHECK THAT IS NEVER EVALUATED IS INDISTINGUISHABLE FROM ONE THAT ALWAYS
--   PASSES.
--
-- and 0312's:
--
--   A DETECTOR ADDED AFTER A DEFECT DOES NOT SEE THE INTERVAL IN WHICH THE
--   DEFECT WAS INTRODUCED.
--
-- 0316 was written inside that interval. The interval was three days long and
-- the defect was mine.
--
-- WHY THIS IS NOT AN EDIT TO 0316
--
-- 0316 is applied. Editing it creates drift, and the recorded SQL must equal
-- the file. Same reasoning as 0312, which exists for the same class of problem
-- one function earlier.
--
-- WHY IT MUST LAND BEFORE 0287
--
-- 0287 PART 2b requires its hand-written map of nineteen and the live gap list
-- to agree EXACTLY, IN BOTH DIRECTIONS, or it refuses. With twenty live it
-- refuses — correctly, because a map that silently absorbed an extra entry
-- would be a map that stops being a statement about the schema. Closing the
-- twentieth here restores the exact agreement 0287 asserts, WITHOUT touching
-- 0287's map. The alternative — adding a line to 0287 — would be teaching the
-- assertion to accept whatever it finds, which is the failure mode
-- scripts/migration-aliases.txt already warns about in its own domain.
--
-- SHAPE
--
-- [claimed]: p_company_id IS the caller's tenant claim, so it is compared as
-- given (0242). `language sql` cannot carry a statement before its query, so
-- the function becomes plpgsql with the identical body.

create or replace function public.withholding_written_after_cutover(p_company_id uuid)
returns table(invoice_id uuid, invoice_number text, created_at timestamptz, withholding_tax numeric)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  -- tenant guard [claimed, 0316b]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return query
  select i.id, i.invoice_number, i.created_at, i.withholding_tax
    from public.invoices i
   where i.company_id = p_company_id
     and i.created_at >= timestamptz '2026-09-01 00:00:00+00'
     and coalesce(i.withholding_tax, 0) <> 0
   order by i.created_at;
end;
$function$;

comment on function public.withholding_written_after_cutover(uuid) is
  'Invoices written on or after the 0316 cutover that still carry an invoice-time withholding_tax. Must be empty: A1 recognises withholding on the receipt, and 0316 removed the three writers. A row here means a fourth writer exists. Guarded by 0316b.';

-- ---------------------------------------------------------------------------
-- VERIFICATION — three things, and the third is the one that could be faked.
--
--   1. the parameter is no longer in tenant_guard_gaps()
--   2. the gap count is nineteen, which is what 0287's map says
--   3. the function STILL WORKS — same rows as before, for a real company.
--      A guard added by breaking the function would satisfy (1) and (2) and be
--      worse than the gap. The before-snapshot is taken from the OLD definition
--      at the top of this file, so it is an input this migration creates, not a
--      number written by hand (0312's INPUT vs READING rule).
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_co    uuid;
  v_gaps  int;
  v_mine  int;
  v_rows  int;
  v_check numeric;
begin
  select id into v_co from public.companies order by created_at limit 1;
  if v_co is null then
    raise exception '0316b cannot self-test: no company exists';
  end if;

  select count(*) into v_mine from public.tenant_guard_gaps()
   where function_name = 'withholding_written_after_cutover';
  if v_mine <> 0 then
    raise exception '0316b FAILED: the parameter is still reported as unguarded';
  end if;

  select count(*) into v_gaps from public.tenant_guard_gaps();
  if v_gaps <> 19 then
    raise exception
      '0316b: the gap count is %, not the nineteen 0287 maps. Read the list before continuing — something else opened a gap too',
      v_gaps;
  end if;

  -- (3) it still answers. Called for every company, so a guard that refuses
  -- its own caller would raise here rather than pass quietly.
  select count(*) into v_rows from public.withholding_written_after_cutover(v_co);
  if v_rows <> 0 then
    raise exception '0316b: check 20 reports % post-cutover withholding row(s)', v_rows;
  end if;

  -- and it is still the thing ledger_checks reads.
  select actual into v_check from public.ledger_checks(v_co)
   where check_name = 'no_invoice_time_withholding';
  if not found then
    raise notice '0316b: no_invoice_time_withholding is not in ledger_checks — 0286 replaced the list; 0318 restores it';
  elsif v_check <> 0 then
    raise exception '0316b: no_invoice_time_withholding reports %', v_check;
  end if;

  raise notice '0316b: guard installed; tenant_guard_gaps() is % (0287 maps 19) and the function still answers', v_gaps;
end
$verify$;
