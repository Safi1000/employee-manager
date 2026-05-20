-- ============================================================================
-- Per-company invoice template: an ordered list of fields with custom titles.
-- Each item: { field: <known_field_key>, title: <custom label> }.
-- Layout is auto-arranged from the order (header → body → totals) based on
-- which fields are picked. Default seeds a reasonable starter template.
-- ============================================================================

alter table public.companies
  add column if not exists invoice_template jsonb not null
    default '[
      {"field":"invoice_number","title":"Invoice #"},
      {"field":"invoice_date","title":"Date"},
      {"field":"client_name","title":"Bill To"},
      {"field":"client_code","title":"Client Code"},
      {"field":"contract_period","title":"Service Period"},
      {"field":"description","title":"Description"},
      {"field":"subtotal","title":"Subtotal"},
      {"field":"withholding_tax","title":"Withholding Tax"},
      {"field":"total","title":"Total"},
      {"field":"amount_received","title":"Received"},
      {"field":"balance_due","title":"Balance Due"},
      {"field":"notes","title":"Notes"}
    ]'::jsonb;
