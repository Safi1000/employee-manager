-- 0195: attendance_confirmations — scope the uniqueness key to the company.
--
-- THE BUG
--   attendance_confirmations_group_shift_date_uidx is
--
--       UNIQUE (group_key, shift_code, attendance_date)
--
--   with no company_id. For a CLIENT shift that is harmless: group_key is the
--   site's uuid, which is unique across the whole database, so two tenants can
--   never collide.
--
--   But a CATEGORY group (Office Staff, Relievers) keys on the literal string
--   'cat:<category>' — see AttendanceBoard.tsx, `group_key: 'cat:' + e.category`.
--   That string is IDENTICAL in every company. So the moment two tenants both
--   confirm office staff for the same date and shift, they collide on a key that
--   was never meant to be shared.
--
--   The board upserts with ON CONFLICT (group_key, shift_code, attendance_date).
--   When the conflicting row belongs to ANOTHER company it is invisible under the
--   `company_members` RLS policy (company_id = current_company_id()), and
--   PostgreSQL refuses the ON CONFLICT DO UPDATE with:
--
--       new row violates row-level security policy (USING expression)
--       for table "attendance_confirmations"
--
--   Reproduced: viewing SANDBOX TESTING ORG, confirming Office Staff for
--   2026-08-20 fails, because GUARDS AND GUIDES already holds
--   ('cat:office_staff','day','2026-08-20'). The same confirmation on a date no
--   other tenant has used succeeds. It is not specific to the sandbox — any
--   second company hits it, and the error is unfixable from the UI because the
--   blocking row cannot be seen or edited by the tenant hitting it.
--
-- THE FIX
--   Put company_id at the front of the key. This only ever RELAXES uniqueness —
--   every row that was unique before is still unique — so it cannot fail on
--   existing data and needs no clean-up.
--
--   The caller must be updated in lockstep: PostgREST infers the arbiter index
--   from the column list it is given, so AttendanceBoard.tsx must upsert with
--   onConflict: "company_id,group_key,shift_code,attendance_date". Without that
--   change the app would ask for an index that no longer exists and fail with
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--   specification".

drop index if exists public.attendance_confirmations_group_shift_date_uidx;

create unique index if not exists attendance_confirmations_company_group_shift_date_uidx
  on public.attendance_confirmations (company_id, group_key, shift_code, attendance_date);

-- Sanity check: no company should hold two confirmations for the same
-- group/shift/date. Returns nothing on a healthy database.
--
--   select company_id, group_key, shift_code, attendance_date, count(*)
--     from public.attendance_confirmations
--    group by 1,2,3,4 having count(*) > 1;
