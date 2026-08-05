-- 0166: don't meter AI for companies that never bought a plan.
--
-- 0165 gave every company ai_credit_monthly = 0. Taken literally that means
-- every EXISTING company has no AI credit, and the gate added to the ai-chat
-- function would switch the assistant off for all of them the moment it is
-- deployed — for orgs that were never sold AI credit in the first place and
-- are invoiced outside the app entirely.
--
-- The test for "this company is on a self-serve plan" is already established
-- by the guard cap: guard_limit is not null. Reuse it rather than invent a
-- second flag that can disagree with the first.

create or replace function public.ai_credit_status(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    -- False for a company created by hand by a super-super-admin: it has no
    -- plan, so there is no allowance to run out of and nothing to charge.
    'enforced', c.guard_limit is not null,
    'available', public.ai_credit_available(c.id),
    'monthly', c.ai_credit_monthly,
    'used', c.ai_credit_used,
    'topup', c.ai_credit_topup
  )
  from public.companies c
  where c.id = p_company
$function$;

comment on function public.ai_credit_status(uuid) is
  'AI credit state for a company. enforced=false means no self-serve plan: do not gate or bill.';

grant execute on function public.ai_credit_status(uuid) to authenticated;
