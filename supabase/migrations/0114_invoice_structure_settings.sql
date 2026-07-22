-- 0114_invoice_structure_settings.sql
-- Company-level invoice branding + per-template toggles for the "Invoice
-- Structure" panel. Everything per-company — nothing about invoices may hardcode
-- a specific company's name, logo, or contact details. Applied to crm-design
-- 2026-07-22.
--
-- Reuses existing companies columns: name, legal_address (Head Office address),
-- tax_ntn, contact_email, logo_url, invoice_template. Logo/stamp are stored as
-- base64 data URLs (same pattern as profiles.avatar_url) so jsPDF can embed them
-- directly with no fetch/CORS step.

alter table public.companies
  add column if not exists legal_name        text,
  add column if not exists registration_line text,
  add column if not exists website           text,
  add column if not exists signature_label   text,
  add column if not exists stamp_url         text,   -- base64 data URL
  add column if not exists contact_phones    jsonb not null default '[]'::jsonb,
  add column if not exists invoice_settings  jsonb not null default '{}'::jsonb;

-- invoice_settings shape (all optional; defaults chosen in the UI):
--   { "fixed_show_previous_balance": bool,
--     "variable_show_previous_balance": bool,
--     "general_show_stamp": bool,
--     "sla_taxes_dynamic": bool,        -- derive SLA tax columns from tax_profile
--     "sla_tax_columns": string[] }     -- only used when sla_taxes_dynamic = false

-- Save RPC (SECURITY DEFINER, gated to super_admin/SSA) — mirrors the existing
-- update_company_profile pattern so RLS on companies isn't an obstacle.
create or replace function public.update_invoice_structure(
  p_legal_name text, p_registration_line text, p_legal_address text,
  p_contact_email text, p_contact_phones jsonb, p_website text, p_tax_ntn text,
  p_signature_label text, p_logo_url text, p_stamp_url text, p_invoice_settings jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_role public.user_role;
begin
  v_company := public.current_company_id();
  v_role := public.current_role();
  if v_company is null then raise exception 'No company in context'; end if;
  if v_role not in ('super_admin','super_super_admin') then
    raise exception 'Not authorised to edit invoice structure'; end if;
  update public.companies set
    legal_name = p_legal_name, registration_line = p_registration_line,
    legal_address = p_legal_address, contact_email = p_contact_email,
    contact_phones = coalesce(p_contact_phones,'[]'::jsonb), website = p_website,
    tax_ntn = p_tax_ntn, signature_label = p_signature_label,
    logo_url = p_logo_url, stamp_url = p_stamp_url,
    invoice_settings = coalesce(p_invoice_settings,'{}'::jsonb), updated_at = now()
  where id = v_company;
end; $$;
