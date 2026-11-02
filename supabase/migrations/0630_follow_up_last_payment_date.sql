-- 0630 — the last payment date on the follow-up list and report.
--
-- DECIDED by Shayan, 2 Nov 2026: the Payment Follow-up report shows when each
-- client last paid. The date and the mode (cash / bank / cheque) are not
-- figures, so an ops login (receivables.follow_up) sees them; the amount of that
-- payment is returned only to a login that can see amounts, like every other
-- figure on this list.
--
-- RESTATED: client_followup_list has one author (0628) and is restated here
-- behind the digest of the body it replaces; its return type gains three
-- columns, so it is dropped and recreated. Its body is 0628's, unchanged apart
-- from those three columns.

do $pre$
begin
  if md5(pg_get_functiondef('public.client_followup_list()'::regprocedure)) <> 'df1e177c343effefb6ce301672f6b562' then
    raise exception '0630 REFUSED: client_followup_list is not the body 0628 wrote — someone edited it since. Amend by surgery instead.';
  end if;
end $pre$;

drop function public.client_followup_list();
create function public.client_followup_list()
returns table (
  client_id        uuid,
  client_name      text,
  branch_id        uuid,
  region_name      text,
  usual_pay_day    smallint,
  is_late          boolean,
  late_since       date,
  days_late        int,
  from_before_bastion boolean,
  balance          numeric,
  overdue          numeric,
  last_contact_on  date,
  last_contact_channel text,
  last_contact_note text,
  promised_by      date,
  promised_amount  numeric,
  next_follow_up   date,
  next_step        text,
  next_step_assignee uuid,
  next_step_assignee_name text,
  next_step_followup_id uuid,
  next_step_done   boolean,
  last_paid_on     date,
  last_paid_mode   text,
  last_paid_amount numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_amounts boolean;
  v_after   int;
  v_branch  uuid := case when public.is_branched_user() and not public.is_super_super_admin() then public.current_branch_id() end;
begin
  perform public.require_follow_up_access(false);
  v_amounts := public.can_see_receivable_amounts();
  select coalesce(followup_after_days, 7) into v_after from public.finance_settings where company_id = public.current_company_id();
  v_after := coalesce(v_after, 7);

  return query
  with t as (
    select * from public.client_receivables_base() r
     where v_branch is null or r.branch_id = v_branch
  ),
  due as (
    select t.*, c.usual_pay_day as pay_day,
           case
             when t.owed_before_bastion > 0.5 then null::date
             when t.oldest_open_date is null then null::date
             when c.usual_pay_day is null then t.oldest_open_date + v_after
             else (
               -- The first occurrence of the pay day on or after the invoice date
               -- (a 31st in a short month falls on its last day).
               select case when m1 >= t.oldest_open_date then m1 else m2 end
                 from (select make_date(extract(year from t.oldest_open_date)::int, extract(month from t.oldest_open_date)::int,
                                        least(c.usual_pay_day::int, extract(day from (date_trunc('month', t.oldest_open_date) + interval '1 month - 1 day'))::int)) m1,
                              make_date(extract(year from t.oldest_open_date + interval '1 month')::int, extract(month from t.oldest_open_date + interval '1 month')::int,
                                        least(c.usual_pay_day::int, extract(day from (date_trunc('month', t.oldest_open_date + interval '1 month') + interval '1 month - 1 day'))::int)) m2) x
             )
           end as due_on
      from t join public.clients c on c.id = t.client_id
  ),
  last_step as (
    select distinct on (f.client_id) f.client_id as cid, f.id, f.next_step, f.next_step_assignee, f.next_follow_up, f.next_step_done_at
      from public.client_followups f
     where f.next_step is not null
     order by f.client_id, f.contacted_on desc, f.created_at desc
  )
  select d.client_id, d.client_name, d.branch_id, b.name,
         d.pay_day,
         d.balance > 0.5 and (d.owed_before_bastion > 0.5 or (d.due_on is not null and current_date > d.due_on)),
         d.due_on,
         case when d.due_on is not null and current_date > d.due_on then (current_date - d.due_on)::int end,
         d.owed_before_bastion > 0.5,
         case when v_amounts then d.balance end,
         case when v_amounts then d.overdue end,
         d.last_contact_on, d.last_contact_channel, d.last_contact_note,
         d.promised_by,
         case when v_amounts then d.promised_amount end,
         d.next_follow_up,
         ls.next_step, ls.next_step_assignee, p.full_name, ls.id, ls.next_step_done_at is not null,
         -- 0630: when they last paid and how — a date and a mode, not a figure,
         -- so an ops login sees them; the amount only with a finance key.
         d.last_paid_on, d.last_paid_mode,
         case when v_amounts then d.last_paid_amount end
    from due d
    left join public.branches b on b.id = d.branch_id
    left join last_step ls on ls.cid = d.client_id
    left join public.profiles p on p.id = ls.next_step_assignee
   where d.balance > 0.5;
end $$;
comment on function public.client_followup_list() is
  '0628/0630 (DECIDED 2 Nov 2026): every client who owes money, with the date and mode of their last payment (amount for finance only), with whether they are LATE (past their usual pay day for their oldest unpaid invoice, or followup_after_days after it when no day is set; anything from before Bastion is always late), the last contact, promise date, and the open next step. Amounts are NULL unless the caller holds a finance read key. Definer, scoped here to the caller''s company and region; gate receivables.follow_up or a finance read key.';

revoke all on function public.client_followup_list() from public, anon;
grant execute on function public.client_followup_list() to authenticated;

-- ── Tests (rolled back) ──
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_msg text; v_ran int := 0; r record; v_expected record;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    -- Finance: Dolmen City's last payment as client_receivables_today reports it, amount included.
    select last_paid_on, last_paid_mode, last_paid_amount into v_expected from public.client_receivables_today() where client_name = 'Dolmen City';
    select * into r from public.client_followup_list() where client_name = 'Dolmen City';
    if r.last_paid_on is distinct from v_expected.last_paid_on or r.last_paid_mode is distinct from v_expected.last_paid_mode
       or r.last_paid_amount is distinct from v_expected.last_paid_amount or r.last_paid_on is null then
      raise exception '0630 REFUSED: finance sees Dolmen''s last payment as %, expected %.', row_to_json(r), row_to_json(v_expected);
    end if;
    v_ran := v_ran + 1;

    -- Ops: the same date and mode, and no amount.
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['receivables.follow_up'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    select * into r from public.client_followup_list() where client_name = 'Dolmen City';
    if r.last_paid_on is distinct from v_expected.last_paid_on or r.last_paid_mode is distinct from v_expected.last_paid_mode
       or r.last_paid_amount is not null or r.balance is not null then
      raise exception '0630 REFUSED: an ops login sees Dolmen''s last payment as %.', row_to_json(r);
    end if;
    v_ran := v_ran + 1;

    if v_ran <> 2 then raise exception '0630 REFUSED: % of 2 assertions ran.', v_ran; end if;
    raise exception '0630-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0630-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0630 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0630 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
