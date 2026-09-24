-- 0481 — Addendums carry no shift.
--
-- DECIDED (2026-09-24, asked while building the addendum form): "remove shifts
-- from addendums". The addendum
-- form no longer asks for a shift; headcount it adds belongs to the category at
-- the site, which is already the unit the cap measures (0457: category + site,
-- across shifts; 0478/0479 add addendum headcount to that same group). A
-- reduction or rate change still names its LINE, and a line has a shift of its
-- own, so nothing about a line's shift moves here.
--
-- Three consequences:
--
-- 1. DATA. MEASURED BEFORE (prod): 2 addendums carry a shift — CON-0005 +1 Guard
--    (day, Nova Islamabad) and CON-0023 −1 Guard (day, contract-wide, legacy).
--    Both are cleared; the column stays, null, so older reads keep working.
--
-- 2. SHIFT DEFINITIONS. 0478 created a site's (site, shift) definition from the
--    addendum's shift. With no shift, a site opened by addendum would get none.
--    Replaced: an addendum naming a site that has NO shift definitions gives it
--    day and night, at save_contract's default hours. A site that already has
--    shifts (from its lines) is left exactly as it is. The 0478 function is
--    dropped rather than restated — this is a different rule, not an edit.
--    DEFERRED: which shifts an addendum-only site should get was not asked.
--    Day + night is a stand-in so attendance has something to mark against.
--    If the answer differs, change the VALUES list in addendum_site_gets_shifts
--    (evening is ('evening', 16:00, 00:00, 8, true), as in save_contract).
--
-- 3. save_contract's clean-up (0478) spared a shift an addendum staffed BY
--    SHIFT. With no shift that test never matches, and the clean-up would delete
--    an addendum-only site's day/night. Amended by surgery: a site any addendum
--    on a live contract staffs keeps its shifts.

-- ── 2. the new rule, before the data update fires anything ──────────────────
drop trigger if exists trg_contract_addendums_staff_shift on public.contract_addendums;
drop function if exists public.addendum_staffs_its_shift();

create or replace function public.addendum_site_gets_shifts()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.site_id is null then
    return new;
  end if;
  -- A site that already has shifts keeps exactly those.
  if exists (select 1 from public.shift_definitions sd where sd.site_id = new.site_id) then
    return new;
  end if;
  -- save_contract's default hours, so a shift reads the same whichever path made it.
  insert into public.shift_definitions (company_id, site_id, shift_code, start_time, end_time, duration_hours, crosses_midnight)
  select new.company_id, new.site_id, w.code::public.shift_code,
         w.start_time, w.end_time, w.duration_hours, w.crosses_midnight
    from (values ('day',   time '08:00', time '20:00', 12::numeric, false),
                 ('night', time '20:00', time '08:00', 12::numeric, true))
         w (code, start_time, end_time, duration_hours, crosses_midnight)
  on conflict (site_id, shift_code) do nothing;
  return new;
end
$function$;

comment on function public.addendum_site_gets_shifts() is
  'An addendum naming a site with NO shift definitions gives it day and night at save_contract''s '
  'default hours; a site with shifts already is untouched. Addendums carry no shift (0481, DECIDED). '
  'Which shifts such a site gets is DEFERRED — day + night is a stand-in (see 0481).';

create trigger trg_contract_addendums_site_shifts
  after insert or update of site_id on public.contract_addendums
  for each row execute function public.addendum_site_gets_shifts();

-- ── 1. data ──────────────────────────────────────────────────────────────────
update public.contract_addendums set shift_code = null where shift_code is not null;

comment on column public.contract_addendums.shift_code is
  'Unused since 0481 (DECIDED: addendums carry no shift). Always null; kept so older reads do not break.';

-- Backfill: a site an addendum staffs with no shifts at all.
insert into public.shift_definitions (company_id, site_id, shift_code, start_time, end_time, duration_hours, crosses_midnight)
select distinct a.company_id, a.site_id, w.code::public.shift_code,
       w.start_time, w.end_time, w.duration_hours, w.crosses_midnight
  from public.contract_addendums a
  cross join (values ('day',   time '08:00', time '20:00', 12::numeric, false),
                     ('night', time '20:00', time '08:00', 12::numeric, true))
       w (code, start_time, end_time, duration_hours, crosses_midnight)
 where a.site_id is not null
   and not exists (select 1 from public.shift_definitions sd where sd.site_id = a.site_id)
on conflict (site_id, shift_code) do nothing;

-- ── 3. save_contract spares every shift at a site an addendum staffs ────────
do $mig$
declare
  v_def text;
  v_old text;
  v_n   int;
begin
  v_def := pg_get_functiondef('public.save_contract'::regproc);
  if position('0481:' in v_def) = 0 then
    v_old := E'        where a.site_id = sd.site_id\n'
          || E'          and a.shift_code::text = sd.shift_code::text\n';
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0481: save_contract anchor found % times, expected 1', v_n;
    end if;
    execute replace(v_def, v_old,
         E'        where a.site_id = sd.site_id\n'
      || E'          -- 0481: addendums carry no shift; a site one staffs keeps all its shifts.\n');
  end if;
  v_def := pg_get_functiondef('public.save_contract'::regproc);
  if (length(v_def) - length(replace(v_def, '0481:', ''))) / 5 <> 1 then
    raise exception '0481: save_contract marker missing or doubled';
  end if;
end $mig$;

do $$
declare v_n int;
begin
  select count(*) into v_n from public.contract_addendums where shift_code is not null;
  if v_n <> 0 then
    raise exception '0481: % addendum(s) still carry a shift', v_n;
  end if;
  select count(*) into v_n
    from public.contract_addendums a
   where a.site_id is not null
     and not exists (select 1 from public.shift_definitions sd where sd.site_id = a.site_id);
  if v_n <> 0 then
    raise exception '0481: % addendum(s) staff a site with no shifts', v_n;
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
