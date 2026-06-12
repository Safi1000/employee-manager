-- Item 6: Company Profile settings.
--
-- The companies table is writable only by Super Super Admin (ssa_all), but the
-- Company Profile editor lives in the super-admin Settings page. Rather than
-- widen RLS on companies (which also holds subscription/active flags), expose a
-- SECURITY DEFINER RPC that lets a super_admin or SSA edit ONLY the presentational
-- profile columns of their own current company.
create or replace function public.update_company_profile(
  p_name                 text,
  p_legal_address        text,
  p_tax_ntn              text,
  p_presentation_currency text,
  p_fiscal_year_start    text,
  p_logo_url             text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_role public.user_role;
begin
  v_company := public.current_company_id();
  v_role := public.current_role();
  if v_company is null then
    raise exception 'No company in context';
  end if;
  if v_role not in ('super_admin', 'super_super_admin') then
    raise exception 'Not authorised to edit company profile';
  end if;

  update public.companies set
    name                  = coalesce(nullif(btrim(p_name), ''), name),
    legal_address         = p_legal_address,
    tax_ntn               = p_tax_ntn,
    presentation_currency = coalesce(nullif(p_presentation_currency, ''), presentation_currency),
    fiscal_year_start     = coalesce(nullif(p_fiscal_year_start, ''), fiscal_year_start),
    logo_url              = p_logo_url,
    updated_at            = now()
  where id = v_company;
end;
$$;

grant execute on function public.update_company_profile(text, text, text, text, text, text) to authenticated;
