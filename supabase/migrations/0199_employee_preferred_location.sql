-- 0199: employees.preferred_location — where an applicant would like to be posted.
--
-- Asked on the short intake form used for applicants and waiting-list entries,
-- who are not employees yet: at that point the office knows a name, a number,
-- roughly where they want to work and what they have done before, and nothing
-- else. Free text rather than a locations FK — the old location_id is deprecated
-- (Phase 3H) and an applicant's answer is "Rawalpindi" or "near Saddar", not a
-- row in a table we control.
--
-- Nullable: a hired employee is posted through Assignments & Pay and never needs
-- this, and every record that predates the field has none.

alter table public.employees
  add column if not exists preferred_location text;

comment on column public.employees.preferred_location is
  'Applicant-stated preferred posting area. Captured on the waiting-list intake form; not used for posting, which is set on Assignments & Pay.';
