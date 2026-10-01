-- 0490: the confirmed month-end lock starts on the 3rd, not the 1st.
--
-- A confirmed attendance day used to lock the moment its month ended (the 1st
-- of the next month). Ops need the first two days of the new month to finish
-- the previous one, so the lock now starts on the 3rd: September's confirmed
-- days stay editable through 2 October and lock from 3 October.
--
-- Two places state the rule and both move together:
--   - enforce_confirmed_month_end_lock()  the trigger that refuses the write
--   - attendance_gate()                   the gate that tells a screen 'blocked'
--
-- Both have been edited by several migrations, so this is surgery against the
-- live definition, each anchor asserted to appear exactly once.
--
-- Unchanged: the OPS-Verify month lock (enforce_attendance_month_lock) and the
-- rolling backfill cutoff (is_attendance_locked). Applying this on 1 October
-- unlocks September's confirmed days until the 3rd; no September month was
-- OPS-verified when it was applied.

do $mig$
declare
  v_def text;
  v_old text;
  v_new text;
  v_n   int;
begin
  -- 1. The trigger.
  v_def := pg_get_functiondef('public.enforce_confirmed_month_end_lock()'::regprocedure);
  v_old := $a$if (date_trunc('month', v_date) + interval '1 month')::date > current_date then$a$;
  v_new := $a$if (date_trunc('month', v_date) + interval '1 month' + interval '2 days')::date > current_date then$a$;
  if position(v_new in v_def) = 0 then
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0490: enforce_confirmed_month_end_lock anchor found % times, expected 1', v_n;
    end if;
    execute replace(v_def, v_old, v_new);
  end if;

  -- 2. The gate.
  v_def := pg_get_functiondef('public.attendance_gate(uuid,date,integer)'::regprocedure);
  v_old := $a$if (date_trunc('month', p_date) + interval '1 month')::date <= current_date$a$;
  v_new := $a$if (date_trunc('month', p_date) + interval '1 month' + interval '2 days')::date <= current_date$a$;
  if position(v_new in v_def) = 0 then
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0490: attendance_gate anchor found % times, expected 1', v_n;
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end
$mig$;

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
