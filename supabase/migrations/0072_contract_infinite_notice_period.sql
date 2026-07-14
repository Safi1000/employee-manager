-- 0072: Infinite (open-ended) contracts + notice period.
--
-- A contract can now run indefinitely instead of expiring on a fixed end_date.
-- When `is_infinite` is set, `end_date` carries no meaning and the client must
-- instead give `notice_period_days` of advance notice to terminate.
--
-- `end_date` was already nullable, so an infinite contract simply leaves it null.
-- The flag is stored explicitly rather than inferred from `end_date is null`
-- because a null end_date already occurs on legacy rows that were never given
-- one — those are NOT deliberate open-ended contracts and must keep reading as
-- ordinary contracts with an unknown end.
--
-- Additive only: no data is rewritten. Existing contracts get is_infinite=false
-- and a null notice period.

alter table public.contracts
  add column if not exists is_infinite        boolean not null default false,
  add column if not exists notice_period_days integer;

-- A notice period is only meaningful on an infinite contract, and must be positive.
alter table public.contracts
  drop constraint if exists contracts_notice_period_days_check;

alter table public.contracts
  add constraint contracts_notice_period_days_check
  check (
    notice_period_days is null
    or (is_infinite = true and notice_period_days > 0)
  );

comment on column public.contracts.is_infinite is
  'Contract runs indefinitely; end_date is ignored. Termination is governed by notice_period_days.';
comment on column public.contracts.notice_period_days is
  'Advance notice (in days) the client must give to end an infinite contract. Null on fixed-term contracts.';
