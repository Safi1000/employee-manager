-- 0146: Re-home the three non-Guards&Guides companies that received 'GGS-'
-- permanent codes from the OLD hardcoded generator, onto their own prefixes.
-- One-off DATA correction requested explicitly (permanent codes are otherwise
-- immutable). Guards & Guides is untouched — it legitimately owns 'GGS'.
--
--   gng      -> GNG
--   DEMO CRM -> GSS   (its existing invoice prefix)
--   SSG      -> SSG
--
-- The numeric suffix is preserved (GGS-00007 -> GNG-00007); only the prefix
-- block changes. guard_code + employee_code both updated; the immutability
-- trigger is disabled for the duration of the rewrite only.

do $$
declare
  v_map jsonb := jsonb_build_object(
    'c865e652-b353-4c16-825d-66d8192bc830', 'GNG',   -- gng
    '0947a23d-bef8-4755-9dc3-7a29054250eb', 'GSS',   -- DEMO CRM
    '34b579af-9af0-40c5-8d4b-4351c46760b8', 'SSG'    -- SSG
  );
  v_cid text;
  v_new text;
begin
  alter table public.employees disable trigger trg_guard_code_immutable;

  for v_cid, v_new in select key, value::text from jsonb_each_text(v_map) loop
    -- 1. Rewrite the permanent codes for this company's guards.
    update public.employees
       set guard_code    = regexp_replace(guard_code, '^GGS-', v_new || '-'),
           employee_code = regexp_replace(employee_code, '^GGS-', v_new || '-'),
           updated_at    = now()
     where company_id = v_cid::uuid
       and guard_code like 'GGS-%';

    -- 2. Keep the code-history audit log consistent.
    update public.employee_code_history
       set old_code = regexp_replace(old_code, '^GGS-', v_new || '-')
     where company_id = v_cid::uuid and old_code like 'GGS-%';
    update public.employee_code_history
       set new_code = regexp_replace(new_code, '^GGS-', v_new || '-')
     where company_id = v_cid::uuid and new_code like 'GGS-%';

    -- 3. Set the company's unified prefix (drives guard codes + invoice Ref).
    update public.companies
       set invoice_settings = coalesce(invoice_settings, '{}'::jsonb)
                              || jsonb_build_object('company_prefix', v_new),
           updated_at = now()
     where id = v_cid::uuid;
  end loop;

  alter table public.employees enable trigger trg_guard_code_immutable;
end $$;
