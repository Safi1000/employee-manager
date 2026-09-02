-- 0311 — RBAC enforcement, layer 2: guard the SECURITY DEFINER money/approval
-- RPCs. These run as their definer and therefore BYPASS the table RLS added in
-- 0310, so a permission-less caller could still move money or approve payroll
-- through them. Add a has_perm() precondition at the top of each.
--
-- Method: surgical insertion against the LIVE definition (anchored on the body's
-- first `begin`), never a restatement — these functions have many authors.
-- require_perm() raises 42501 when the caller lacks the key (super_admin/SSA pass
-- via has_perm). Idempotent: skips any function already carrying the guard.
--
-- run_auto_invoices is deliberately NOT guarded: it iterates every company as a
-- batch/cron job with no per-user auth context; a has_perm() gate would break it.
create or replace function public.require_perm(p_perm text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_perm(p_perm) then
    raise exception 'permission denied: % required', p_perm using errcode = '42501';
  end if;
end $$;

do $$
declare m record; v_def text; v_new text;
begin
  for m in select * from (values
    ('disburse_payroll_run(uuid)',                                             'perform public.require_perm(''payroll.edit'');'),
    ('payroll_run_attach(uuid)',                                               'perform public.require_perm(''payroll.edit'');'),
    ('record_invoice_payment(uuid,numeric,date,text,uuid,text,numeric,uuid,uuid)', 'perform public.require_perm(''invoices.edit'');'),
    ('write_off_receivable(uuid,text)',                                        'perform public.require_perm(''invoices.edit'');'),
    ('record_cash_deposit(uuid,numeric,date,text)',                            'perform public.require_perm(''accounting.edit'');'),
    ('record_bank_to_custodian(uuid,uuid,numeric,date,text)',                  'perform public.require_perm(''accounting.edit'');'),
    ('transition_payroll_run(uuid,payroll_run_status,text)',
       'if p_to = ''approved'' then perform public.require_perm(''payroll.approve''); else perform public.require_perm(''payroll.edit''); end if;')
  ) as t(sig, guard)
  loop
    v_def := pg_get_functiondef(('public.' || m.sig)::regprocedure);
    if position('require_perm' in v_def) > 0 then
      continue;  -- already guarded
    end if;
    v_new := regexp_replace(v_def, E'begin\n', E'begin\n  ' || m.guard || E'\n');
    if v_new = v_def then
      raise exception 'guard anchor (body begin) not found for %', m.sig;
    end if;
    execute v_new;
  end loop;
end $$;
