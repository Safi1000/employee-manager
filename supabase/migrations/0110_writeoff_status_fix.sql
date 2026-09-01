-- 0110 — align write-off with the capitalised invoice status vocabulary
--
-- RECOVERED from supabase_migrations.schema_migrations on 2026-08-31.
-- This migration was applied directly to the database (SQL editor / MCP) and
-- never written back to the repo. Committed verbatim so the repo records what
-- actually ran. See docs/MIGRATION_DIVERGENCE.md.

alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status = any (array['Pending','Delivered','Unpaid','Partly-Paid','Paid','Written-Off']));

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
     set status = 'Written-Off',
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
     where coalesce(i.status,'') <> 'Written-Off'
       and (coalesce(i.total_due, i.invoice_amount, 0) - coalesce(i.amount_received,0)) > 0
  )
  select o.company_id, o.owner_region as branch_id, b.name as region_name, o.workout_account,
         sum(o.outstanding)                                              as total_outstanding,
         sum(o.outstanding) filter (where o.age_days <= 30)              as bucket_current,
         sum(o.outstanding) filter (where o.age_days between 31 and 60)  as bucket_31_60,
         sum(o.outstanding) filter (where o.age_days between 61 and 90)  as bucket_61_90,
         sum(o.outstanding) filter (where o.age_days > 90)               as bucket_90_plus,
         round(coalesce(sum(o.outstanding * o.age_days) / nullif(sum(o.outstanding),0), 0), 1) as dso_weighted_days
    from open_inv o join public.branches b on b.id = o.owner_region
   group by o.company_id, o.owner_region, b.name, o.workout_account;

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
     where coalesce(i.status,'') not in ('Paid','Written-Off')
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
