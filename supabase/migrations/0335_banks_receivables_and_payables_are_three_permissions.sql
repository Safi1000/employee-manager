-- 0335 — accounting.view becomes banks.view, receivables.view, payables.view.
--
-- WHY. The Banks & Ledgers screen has had four tabs for a long time — Client
-- Receivables, Accounts Payable, Bank Accounts, Cash Custody — and ONE
-- permission opened all of them. So "let the accounts clerk see what we owe
-- suppliers" also meant "let them see what every client owes us, by name and
-- amount". Those are different things to be trusted with, and the screen was
-- already shaped to separate them.
--
-- The split follows the tabs rather than inventing a taxonomy:
--
--   banks.view        Bank Accounts + Cash Custody
--   receivables.view  Client Receivables
--   payables.view     Accounts Payable
--
-- accounting.edit is unchanged and continues to imply all three, because
-- someone who may edit banks, transfers and reconciliation can already see
-- everything on the screen.
--
-- WHAT THIS FILE TOUCHES, AND WHAT IT DOES NOT
--
-- accounting.view appears in NO RLS policy — checked, not assumed. It is a
-- frontend gate plus one database default, so the surface is small:
--
--   * department_default_permissions('finance') hands out the key to every new
--     finance-department user. It is amended here.
--   * profiles.permissions is a text[] holding granted keys. Existing holders
--     are migrated here.
--   * everything else is src/, and is in the same commit as this file.
--
-- NOBODY LOSES ACCESS. That is the property this migration is really about, and
-- it is asserted rather than assumed: every profile holding accounting.view
-- before must hold all three keys after. A permission split that silently locks
-- someone out of a screen they had yesterday is indistinguishable, from their
-- side, from the application being broken.

-- ---------------------------------------------------------------------------
-- 0. Who holds what BEFORE, so "nobody lost access" can be checked rather than
--    hoped for. Read, not written as a literal — dev and production do not have
--    the same users.
-- ---------------------------------------------------------------------------
create temp table _0335_before on commit drop as
  select id, email, permissions
    from public.profiles
   where 'accounting.view' = any(permissions);

-- ---------------------------------------------------------------------------
-- 1. The finance department's defaults hand out the three keys.
-- ---------------------------------------------------------------------------
do $defaults$
declare
  v_src  text;
  v_hits int;
  v_anchor constant text := $a$      'accounting.view','accounting.edit',$a$;
  v_new    constant text := $a$      'banks.view','receivables.view','payables.view','accounting.edit',$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'department_default_permissions';

  if v_src is null then
    raise exception '0335 FAILED: public.department_default_permissions does not exist';
  end if;

  if position('receivables.view' in v_src) > 0 then
    raise notice '0335: the finance defaults already carry the split keys, leaving them alone';
    return;
  end if;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      '0335 FAILED: the finance default row appears % times, expected exactly 1 — do not guess which department to edit', v_hits;
  end if;

  execute replace(v_src, v_anchor, v_new);
end
$defaults$;

-- ---------------------------------------------------------------------------
-- 2. Existing holders keep everything they had, expressed in the new keys.
--
-- Additive first, subtractive second, and both in one statement: a profile that
-- gained the three keys but kept accounting.view would still work, whereas one
-- that lost accounting.view before gaining the others would be locked out for
-- the width of the transaction. Order matters less inside a transaction than
-- the habit does.
-- ---------------------------------------------------------------------------
update public.profiles
   set permissions = array(
         select distinct unnest(
           array_remove(permissions, 'accounting.view')
           || array['banks.view','receivables.view','payables.view']))
 where 'accounting.view' = any(permissions);

-- ---------------------------------------------------------------------------
-- PROOF
--
-- (a) NOBODY LOST ACCESS. Every profile that held accounting.view now holds all
--     three replacements. This is the assertion the migration exists for.
-- (b) Nobody kept the retired key, so the catalogue in src/ and the data agree.
--     A key no screen reads is a grant that looks meaningful and is not.
-- (c) NOBODY GAINED ANYTHING ELSE. Compared permission-by-permission against
--     the captured before-state: the only difference for any profile is
--     accounting.view leaving and the three arriving. Without this, an update
--     that widened a WHERE clause would satisfy (a) and (b) while handing out
--     permissions nobody granted.
-- (d) The finance defaults hand out the three and no longer hand out the old
--     key — checked by CALLING the function, not by reading its text.
-- (e) No OTHER department's defaults changed. Same reason as (c): the anchor
--     was one row of a CASE and the edit must not have reached the others.
-- ---------------------------------------------------------------------------
do $proof$
declare
  r        record;
  v_n      int;
  v_fin    text[];
  v_ops    text[];
  v_hr     text[];
begin
  -- (a) and (b)
  for r in select * from _0335_before loop
    if not exists (select 1 from public.profiles p where p.id = r.id
                    and 'banks.view' = any(p.permissions)
                    and 'receivables.view' = any(p.permissions)
                    and 'payables.view' = any(p.permissions)) then
      raise exception
        '0335 FAILED: % held accounting.view and does not hold all three replacements — that user just lost a screen', r.email;
    end if;
    if exists (select 1 from public.profiles p where p.id = r.id
                and 'accounting.view' = any(p.permissions)) then
      raise exception '0335 FAILED: % still holds the retired accounting.view key', r.email;
    end if;
  end loop;

  select count(*) into v_n from public.profiles where 'accounting.view' = any(permissions);
  if v_n <> 0 then
    raise exception '0335 FAILED: % profile(s) still hold accounting.view', v_n;
  end if;

  -- (c) the ONLY change to any profile is the intended one
  for r in
    select p.email,
           array(select unnest(p.permissions)
                 except select unnest(b.permissions)
                 except select unnest(array['banks.view','receivables.view','payables.view'])) as gained,
           array(select unnest(b.permissions)
                 except select unnest(p.permissions)
                 except select unnest(array['accounting.view'])) as lost
      from _0335_before b join public.profiles p on p.id = b.id
  loop
    if array_length(r.gained, 1) is not null then
      raise exception '0335 FAILED: % gained % beyond the split', r.email, r.gained;
    end if;
    if array_length(r.lost, 1) is not null then
      raise exception '0335 FAILED: % lost % beyond the split', r.email, r.lost;
    end if;
  end loop;

  -- and no profile OUTSIDE the before-set was touched at all
  select count(*) into v_n
    from public.profiles p
   where p.id not in (select id from _0335_before)
     and ('banks.view' = any(p.permissions)
       or 'receivables.view' = any(p.permissions)
       or 'payables.view' = any(p.permissions));
  if v_n <> 0 then
    raise exception
      '0335 FAILED: % profile(s) that never held accounting.view now hold a split key — the update reached further than its WHERE clause', v_n;
  end if;

  -- (d) the defaults, by calling the function
  v_fin := public.department_default_permissions('finance');
  if not ('banks.view' = any(v_fin) and 'receivables.view' = any(v_fin) and 'payables.view' = any(v_fin)) then
    raise exception '0335 FAILED: the finance defaults do not hand out all three keys: %', v_fin;
  end if;
  if 'accounting.view' = any(v_fin) then
    raise exception '0335 FAILED: the finance defaults still hand out the retired key';
  end if;
  if not ('accounting.edit' = any(v_fin)) then
    raise exception '0335 FAILED: the finance defaults lost accounting.edit — the anchor swallowed more than it should have';
  end if;

  -- (e) no other department moved
  v_ops := public.department_default_permissions('operations');
  v_hr  := public.department_default_permissions('hr');
  if 'banks.view' = any(v_ops) or 'receivables.view' = any(v_ops) or 'payables.view' = any(v_ops) then
    raise exception '0335 FAILED: the operations defaults gained a finance key: %', v_ops;
  end if;
  if 'banks.view' = any(v_hr) or 'receivables.view' = any(v_hr) or 'payables.view' = any(v_hr) then
    raise exception '0335 FAILED: the hr defaults gained a finance key: %', v_hr;
  end if;

  raise notice
    '0335 OK: % profile(s) migrated from accounting.view to banks.view + receivables.view + payables.view with no other change; the finance defaults hand out the three and no longer the old key; operations and hr untouched.',
    (select count(*) from _0335_before);
end
$proof$;

comment on function public.department_default_permissions(department) is
  'Default permission set granted to a new user by department. 0335: the finance default hands out banks.view / receivables.view / payables.view in place of the single accounting.view, which opened all four tabs of Banks & Ledgers at once.';
