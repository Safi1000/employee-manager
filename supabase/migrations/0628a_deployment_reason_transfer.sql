-- 0628a — 'transfer' as a posting reason.
--
-- 0629 records a move between clients as reason 'transfer' (it used to be
-- written as a separation plus a 'new_hire', which reset the guard's joining
-- date). deployment_reason is an enum, and a value added to an enum cannot be
-- used in the transaction that adds it, so the value is added here, on its own,
-- and 0629 runs after it. Adding a label changes no existing row.
alter type public.deployment_reason add value if not exists 'transfer';
