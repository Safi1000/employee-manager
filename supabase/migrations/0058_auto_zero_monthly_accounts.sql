-- Item 3: some bank accounts must "roll over to 0" at the end of every month —
-- whatever balance remains is treated as withdrawn (no destination) via an
-- adjusting ledger entry dated at month-end. Currently used for the
-- "Shayan Ahmed" account.
--
-- Mechanism: a flag on the account + an idempotent function that zeroes every
-- COMPLETED month that hasn't been zeroed yet. It's safe to call repeatedly
-- (e.g. on page load), so the rollover happens automatically once a month has
-- elapsed without needing a scheduler. (If you enable pg_cron you can also
-- schedule select apply_monthly_account_zeroing(); on the 1st of each month.)

alter table public.bank_accounts
  add column if not exists auto_zero_monthly boolean not null default false,
  -- First day of the most recent completed month already zeroed for this account.
  add column if not exists last_zeroed_month date;

-- Flag the Shayan Ahmed account(s).
update public.bank_accounts
  set auto_zero_monthly = true
  where bank_name ilike 'shayan ahmed';

create or replace function public.apply_monthly_account_zeroing()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acct record;
  m date;
  cur_month date := date_trunc('month', now())::date;  -- first day of the current (incomplete) month
  start_m date;
  net numeric(14,2);
begin
  for acct in
    select id, last_zeroed_month, created_at
    from public.bank_accounts
    where auto_zero_monthly = true
  loop
    -- Start from the month after the last one we zeroed, otherwise from the
    -- account's first activity month.
    if acct.last_zeroed_month is not null then
      start_m := (acct.last_zeroed_month + interval '1 month')::date;
    else
      start_m := date_trunc('month', coalesce(
        (select min(created_at) from public.bank_transactions where bank_account_id = acct.id),
        acct.created_at,
        now()
      ))::date;
    end if;

    m := start_m;
    while m < cur_month loop
      -- Net account movement within month m. Because every prior month has been
      -- zeroed, the start-of-month balance is 0, so this equals the end-of-month
      -- balance that needs to be removed.
      select coalesce(sum(account_delta), 0) into net
      from public.bank_transactions
      where bank_account_id = acct.id
        and created_at >= m
        and created_at < (m + interval '1 month');

      if net <> 0 then
        insert into public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, created_at)
        values
          (acct.id, 'adjustment', abs(net), 0, -net,
           'Month-end auto-zero (' || to_char(m, 'Mon YYYY') || ')',
           (m + interval '1 month' - interval '1 second'));
      end if;

      m := (m + interval '1 month')::date;
    end loop;

    -- Recompute the live balance from the full ledger (= activity in the current,
    -- still-open month) and record how far we've zeroed.
    update public.bank_accounts b
      set balance = coalesce(
            (select sum(account_delta) from public.bank_transactions where bank_account_id = b.id),
            0),
          last_zeroed_month = (cur_month - interval '1 month')::date,
          updated_at = now()
      where b.id = acct.id;
  end loop;
end;
$$;

grant execute on function public.apply_monthly_account_zeroing() to authenticated;
