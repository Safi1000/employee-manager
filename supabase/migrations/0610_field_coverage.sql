-- 0610 — field coverage: every site, its guards, and who supervises it
--
-- Shayan, 30 Oct 2026: field logins get "a separate page … give proper clients
-- then sites, show how many people are under each supervisor … in depth". The
-- Field accounts card (0607) lists logins and their site names only; it cannot
-- say how many guards a supervisor answers for, or which sites nobody covers.
--
--   admin_field_coverage()   one row per site of the caller's company: client,
--                            region, guards on the site, how many carry an
--                            expired document, and the field logins covering it.
--
-- The guard count is field_site_roster(site) counted — the same function the
-- phone reads — so the page and the supervisor's phone cannot disagree about
-- who is at a site. Restating the roster rule here (site on the contract line,
-- or the client's only/default site for lines that name none) would give it a
-- second copy, and the second copy is where the disagreement lives.
-- field_site_roster already lets a super admin read any site of the company.
-- 68 sites took 92 ms on 30 Oct.
--
-- A guard is on at most one site's roster (a line names one site, or none and
-- then only the default site takes it), so a supervisor's guard total is the sum
-- over their sites. Super admins only, like the rest of admin_field_*.
--
-- Asserted with Shayan's identity and the HR login (rolled back by a sentinel
-- whose message is checked): every site of the company comes back once; each
-- site's guard count equals field_site_roster counted; a field login with a site
-- is listed on exactly that site; the HR login is refused with the admin message.

create or replace function public.admin_field_coverage()
returns table (site_id uuid, site_name text, location text, client_id uuid, client_name text,
               region text, guards int, flagged int, supervisors jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0610. Every site of the caller's company with its guard count and the field logins covering it.
  begin
    if not exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin') then
      raise exception 'Only a super admin can manage field accounts.' using errcode = '42501';
    end if;
    return query
    select s.id, s.name, s.location, c.id, c.name, b.name,
           r.guards, r.flagged,
           coalesce((select jsonb_agg(jsonb_build_object('user_id', p.id, 'name', coalesce(nullif(btrim(p.full_name), ''), p.email),
                                                         'disabled', p.disabled_at is not null) order by p.full_name)
                       from public.profiles p
                      where p.company_id = s.company_id and p.user_type = 'site_supervisor' and s.id = any (p.site_scope)), '[]'::jsonb)
      from public.sites s
      join public.clients c on c.id = s.client_id
      left join public.branches b on b.id = c.branch_id
      cross join lateral (select count(*)::int as guards, count(*) filter (where cardinality(x.flags) > 0)::int as flagged
                            from public.field_site_roster(s.id) x) r
     where s.company_id = public.current_company_id()
     order by c.name, s.name;
  end $$;
comment on function public.admin_field_coverage() is
  'TENANT GUARD EXEMPT: no argument; the caller''s company only, super admins only (0610). Guard counts are field_site_roster(site) counted, so they match the phone.';

revoke all on function public.admin_field_coverage() from public, anon;
grant execute on function public.admin_field_coverage() to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('admin_field_coverage', '{users.manage}', '0610: field coverage page, super admins (checked inside)')
on conflict (function_name) do nothing;

do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site uuid; v_n int; v_bad int; v_msg text; v_type text; v_scope uuid[];
begin
  begin
    -- the HR login, made a field login of one site for the test
    select s.id into v_site from public.sites s where s.company_id = v_co order by s.name limit 1;
    select user_type::text, site_scope into v_type, v_scope from public.profiles where id = v_hr;
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;

    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select count(*), count(*) - count(distinct site_id) into v_n, v_bad from public.admin_field_coverage();
    if v_n <> (select count(*) from public.sites where company_id = v_co) or v_bad <> 0 then
      raise exception '0610 REFUSED: % rows (% repeated) for % sites.', v_n, v_bad, (select count(*) from public.sites where company_id = v_co);
    end if;
    select count(*) into v_bad from public.admin_field_coverage() c
     where c.guards <> (select count(*) from public.field_site_roster(c.site_id));
    if v_bad <> 0 then raise exception '0610 REFUSED: % sites disagree with field_site_roster.', v_bad; end if;
    select count(*) into v_n from public.admin_field_coverage() c where c.supervisors @> jsonb_build_array(jsonb_build_object('user_id', v_hr));
    if v_n <> 1 or not exists (select 1 from public.admin_field_coverage() c where c.site_id = v_site and c.supervisors @> jsonb_build_array(jsonb_build_object('user_id', v_hr))) then
      raise exception '0610 REFUSED: the test login is listed on % sites, not exactly its own.', v_n;
    end if;

    update public.profiles set user_type = v_type, site_scope = v_scope where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.admin_field_coverage(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Only a super admin can manage field accounts.' then raise exception '0610 REFUSED: the HR login got "%".', v_msg; end if;
    raise exception '0610-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0610-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0610 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0610 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
