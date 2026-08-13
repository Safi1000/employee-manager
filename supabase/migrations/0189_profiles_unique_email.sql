-- 0189: one user per email address.
--
-- profiles had NO uniqueness on email at all. auth.users enforces it for the
-- normal path, so the create-user function usually failed anyway — but it
-- failed LATE and badly: admin.auth.admin.createUser() returned a raw provider
-- message, the edge function wrapped it as a generic "create_failed", and the
-- operator saw a string that did not say "that email is already in use".
--
-- Worse, the profiles row is written separately from the auth user, so any path
-- that inserts a profile directly — the signup flow, a repair script, a manual
-- fix in the dashboard — could put two rows with the same email in the table
-- with nothing to stop it. Then "who is this login?" has two answers.
--
-- This is the backstop that cannot be bypassed by any code path. The friendly
-- error lives in the create-user edge function, which now checks first and
-- returns email_taken; this index is what makes that check honest rather than
-- advisory.
--
-- lower(trim(...)) because "Info@Guardsandguides.com " and
-- "info@guardsandguides.com" are the same mailbox, and an operator retyping an
-- address will not reproduce the original casing. The edge function already
-- normalises with .trim().toLowerCase() before insert, so this matches it.
--
-- Partial on a non-blank email: rows with no email are not in conflict with
-- each other. None exist today; the guard costs nothing and stops a future
-- blank-email path from tripping over this index.
--
-- Verified before applying: zero duplicate emails in public.profiles and zero
-- in auth.users, so this index builds without a backfill.

create unique index if not exists profiles_email_unique
  on public.profiles (lower(trim(email)))
  where email is not null and trim(email) <> '';

comment on index public.profiles_email_unique is
  'One profile per email address, case- and whitespace-insensitive. See migration 0189.';
