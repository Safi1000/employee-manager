-- 0492 — An expense names who approved it, and the database decides who that is.
--
-- Until now the Expenses screen sent approved_by = profile.id alongside
-- approved_at. That is the browser vouching for itself: nothing stopped a
-- caller sending someone else's id, or none. From here the column is stamped
-- from auth.uid() whenever an expense becomes approved, whatever the client
-- sends.
--
-- The NAME is stored too (approved_by_name), not only the id, because the
-- profiles policies let a user read their own row and nothing else unless they
-- are a super admin — so a joined name would show "—" to every approver who is
-- not. Captured at the moment of approval it is also the name as it was when
-- the decision was made, which is what an approval record should say.
--
-- The trigger is SECURITY INVOKER on purpose: the only profile it reads is the
-- caller's own (self_read), and a service-role caller (fixed-expense instance
-- path, cron) can read all of them.

alter table public.expenses
  add column if not exists approved_by_name text;

comment on column public.expenses.approved_by_name is
  'Display name of the account that approved this expense, captured at approval time by trg_expense_stamp_approver (0492). Set by the database; any value the client sends is overwritten.';

create or replace function public.stamp_expense_approver()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.approved_at is not null
     and (tg_op = 'INSERT' or old.approved_at is null) then
    new.approved_by := coalesce(auth.uid(), new.approved_by);
    new.approved_by_name := (
      select coalesce(nullif(btrim(p.full_name), ''), p.email)
      from public.profiles p
      where p.id = new.approved_by
    );
  end if;
  return new;
end;
$$;

comment on function public.stamp_expense_approver() is
  'Stamps approved_by from auth.uid() and approved_by_name from that profile when an expense becomes approved (0492).';

drop trigger if exists trg_expense_stamp_approver on public.expenses;
create trigger trg_expense_stamp_approver
  before insert or update of approved_at on public.expenses
  for each row execute function public.stamp_expense_approver();

-- Backfill the name for expenses already approved. A display column only: run
-- with triggers off so it does not re-journal, re-audit, or trip the period
-- lock on rows in closed months.
set local session_replication_role = replica;

update public.expenses e
set approved_by_name = coalesce(nullif(btrim(p.full_name), ''), p.email)
from public.profiles p
where p.id = e.approved_by
  and e.approved_at is not null
  and e.approved_by_name is null;

set local session_replication_role = origin;

do $$
declare v_missing int;
begin
  select count(*) into v_missing
  from public.expenses
  where approved_at is not null and approved_by is not null and approved_by_name is null;
  if v_missing > 0 then
    raise exception '0492: % approved expense(s) still have no approver name after backfill', v_missing;
  end if;
end $$;

do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
