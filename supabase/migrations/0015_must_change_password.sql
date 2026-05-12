-- ADDITIVE migration. No data loss.
-- Adds must_change_password flag to profiles. When true, the frontend will
-- force the user to set a new password before they can use the app.
-- Defaults to false so existing users are unaffected.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
