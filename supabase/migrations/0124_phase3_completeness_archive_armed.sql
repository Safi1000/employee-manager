-- 0124: Phase 3E/3G + reader repoint — completeness engine, archive, armed block.
--
--  * guard_completeness(employee): the 4 COMPUTED tiers (§5) + missing items,
--    reading documents from guard_documents (the single source, §3B). Waivers:
--    a waivable doc counts as satisfied when status='waived'; never-waivable
--    docs (CNIC, photograph, police verification, medical cert, references,
--    signed data form, joining date, payment method) require on_file/verified.
--  * v_guard_completeness: per-guard tier flags for list badges.
--  * archive_employee(): §3G Delete→Archive — reason required, logged, never
--    removes rows (sets lifecycle_state='archived').
--  * armed_post_blockers(): repointed to also require weapon_licence (unexpired)
--    and discharge_certificate (ex-servicemen) from guard_documents.

-- ---------------------------------------------------------------------------
-- 1. Completeness function
-- ---------------------------------------------------------------------------
create or replace function public.guard_completeness(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e   public.employees%rowtype;
  st  jsonb;
  t1 boolean; t2 boolean; t3 boolean; t4 boolean;
begin
  select * into e from public.employees where id = p_employee_id;
  if e.id is null then return null; end if;

  select coalesce(jsonb_object_agg(doc_type::text, status::text), '{}'::jsonb)
    into st from public.guard_documents where employee_id = p_employee_id;

  -- Tier 1 — Created
  t1 := e.full_name is not null
    and e.father_or_husband_name is not null
    and e.cnic_number is not null
    and length(regexp_replace(e.cnic_number, '\D', '', 'g')) = 13
    and e.date_of_birth is not null
    and coalesce(st->>'photograph','missing') in ('on_file','verified')
    and e.phone is not null
    and e.permanent_address is not null;

  -- Tier 2 — Deployable
  t2 := t1
    and e.join_date is not null
    and e.designation is not null
    and e.blood_group is not null
    and exists (select 1 from public.guard_contacts g where g.employee_id=e.id and g.role='emergency_1')
    and exists (select 1 from public.guard_contacts g where g.employee_id=e.id and g.role='next_of_kin')
    and exists (select 1 from public.guard_contacts g where g.employee_id=e.id and g.role='reference_1')
    and exists (select 1 from public.guard_contacts g where g.employee_id=e.id and g.role='reference_2')
    and coalesce(st->>'cnic_copy','missing') in ('on_file','verified')
    and coalesce(st->>'photograph','missing') in ('on_file','verified')
    and coalesce(st->>'police_verification','missing') in ('on_file','verified')
    and (coalesce(st->>'character_certificate','missing') in ('on_file','verified','waived')
         or coalesce(st->>'halaf_nama','missing') in ('on_file','verified','waived'))
    and coalesce(st->>'medical_certificate','missing') in ('on_file','verified')
    and coalesce(st->>'signed_data_form','missing') in ('on_file','verified')
    and not exists (select 1 from public.guard_documents gd
                    where gd.employee_id=e.id and gd.status='expired'
                      and gd.doc_type in ('cnic_copy','photograph','police_verification',
                          'character_certificate','halaf_nama','medical_certificate','signed_data_form'))
    and e.record_state >= 'ops_verified';

  -- Tier 3 — Payable
  t3 := t2
    and ( (e.account_title is not null and e.bank_name is not null and e.bank_branch_code is not null
           and e.bank_account is not null and e.iban is not null)
          or (e.cash_payment_flag and e.cash_payment_approved_by is not null) )
    and e.probation_period_months is not null
    and e.pay_fixed_on_probation is not null
    and e.final_pay is not null
    and e.eobi_registration_number is not null
    and e.social_security_status is not null
    and e.company_id_card_number is not null
    and e.record_state >= 'finance_approved';

  -- Tier 4 — Armed post eligible (only for armed/gunman)
  if e.category::text in ('armed','gunman') then
    t4 := t3
      and e.nadra_verisys_status = 'cleared'
      and coalesce(st->>'weapon_licence','missing') in ('on_file','verified')
      and not exists (select 1 from public.guard_documents gd
                      where gd.employee_id=e.id and gd.doc_type='weapon_licence' and gd.status='expired')
      and e.weapons_certified
      and (not coalesce(e.is_ex_serviceman,false)
           or coalesce(st->>'discharge_certificate','missing') in ('on_file','verified'));
  else
    t4 := null;   -- not applicable
  end if;

  return jsonb_build_object(
    'tier1', t1, 'tier2', t2, 'tier3', t3, 'tier4', t4,
    'highest', case when t3 then 3 when t2 then 2 when t1 then 1 else 0 end,
    'armed', (e.category::text in ('armed','gunman'))
  );
end;
$$;

grant execute on function public.guard_completeness(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. List view of tier flags (for the completeness badges on the list).
-- ---------------------------------------------------------------------------
create or replace view public.v_guard_completeness with (security_invoker = true) as
select e.id as employee_id, e.company_id,
       (public.guard_completeness(e.id)) as tiers
from public.employees e;

-- ---------------------------------------------------------------------------
-- 3. archive_employee(): §3G — Delete is replaced by logged Archive-with-reason.
--    Never removes rows.
-- ---------------------------------------------------------------------------
create or replace function public.archive_employee(p_employee_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_from    employee_lifecycle_state;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Archiving requires a reason';
  end if;
  select company_id, lifecycle_state into v_company, v_from
    from public.employees where id = p_employee_id;
  if v_company is null then raise exception 'Employee % not found', p_employee_id; end if;

  update public.employees
     set lifecycle_state = 'archived', status = 'Inactive', updated_at = now()
   where id = p_employee_id;

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, changed_by)
  values (v_company, p_employee_id, v_from, 'archived', p_reason, auth.uid());
end;
$$;

grant execute on function public.archive_employee(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. armed_post_blockers(): repointed to read documents from guard_documents.
--    Keeps the vetting-status checks (those are employee fields, not documents)
--    and ADDS weapon-licence (present + unexpired) and discharge-certificate
--    (for ex-servicemen) requirements sourced from guard_documents.
-- ---------------------------------------------------------------------------
create or replace function public.armed_post_blockers(p_employee_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select array_remove(array[
    case when e.lifecycle_state <> 'active' then 'not in active service' end,
    case when e.police_verification_status = 'pending' then 'police verification pending' end,
    case when e.police_verification_status = 'adverse' then 'police verification adverse' end,
    case when e.nadra_verisys_status = 'pending' then 'NADRA Verisys pending' end,
    case when e.nadra_verisys_status = 'adverse' then 'NADRA Verisys adverse' end,
    case when not e.weapons_certified then 'not weapons-certified' end,
    case when e.weapons_certified and e.weapons_cert_expiry is not null
              and e.weapons_cert_expiry < current_date then 'weapons certification expired' end,
    case when e.blacklisted then 'blacklisted' end,
    -- documents (guard_documents = single source)
    case when not exists (select 1 from public.guard_documents gd
                          where gd.employee_id = e.id and gd.doc_type = 'weapon_licence'
                            and gd.status in ('on_file','verified'))
         then 'weapon licence not on file' end,
    case when exists (select 1 from public.guard_documents gd
                      where gd.employee_id = e.id and gd.doc_type = 'weapon_licence' and gd.status = 'expired')
         then 'weapon licence expired' end,
    case when coalesce(e.is_ex_serviceman,false)
              and not exists (select 1 from public.guard_documents gd
                              where gd.employee_id = e.id and gd.doc_type = 'discharge_certificate'
                                and gd.status in ('on_file','verified'))
         then 'discharge certificate missing' end
  ], null)
  from public.employees e where e.id = p_employee_id;
$$;
