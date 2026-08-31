# Rollback captures

Byte-exact captures of production object definitions, taken immediately before a
deployment that rewrites them in place.

**There is no `drop` that undoes a function-body rewrite.** `0242` replaces 133
bodies via `pg_get_functiondef` surgery; the pre-guard bodies exist nowhere else
once it has run. These files are the only rollback.

---

## `prod_secdef_functions_20260901.sql`

Every `SECURITY DEFINER` function in `public` on **`crm-design`
(`mmkfpnshxjcyijhuydgr`)**, captured 2026-09-01, before the tenant-guard
deployment described in `docs/PROD_TENANT_GUARD_DEPLOYMENT.md`.

| | |
|---|---|
| functions | **257** |
| characters | 326,065 |
| bytes | 326,140 (the difference is multi-byte UTF-8) |
| md5 of the file | `28cbd4912d69b3cf96f5378bea585dd1` |
| embedded CR characters | 123 |

### It was never transcribed, and that was not a convenience

Postgres base64-encoded the dump, the tool layer wrote the encoded result to
disk, and it was decoded locally. Nothing passed through a hand-copy.

That matters because of the 123 CR characters. Several bodies —
`stamp_attendance_marker` among them — carry `\r\n` line endings *inside*
`prosrc`. A hand-copied dump would have dropped them silently, produced a file
that looked right, restored functions that differed from the ones captured, and
failed nothing until someone needed it. The md5 below is the check that this did
not happen: it is the md5 **Postgres computed over its own text**, not one
computed after the fact over whatever arrived.

### Verifying the capture still matches production

```sql
with d as (
  select string_agg('-- ===FUNC ' || p.oid || ' ' || p.proname || '('
                    || pg_get_function_identity_arguments(p.oid) || ')' || E'\n'
                    || pg_get_functiondef(p.oid) || '-- ===END ' || p.oid,
                    E'\n' order by p.oid) as t
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef)
select md5(t) from d;
```

Against the file:

```
md5sum supabase/rollback/prod_secdef_functions_20260901.sql
```

Equal means production is still in its pre-deployment state. **After the
deployment they will differ, and that is the expected result** — the capture is
a photograph of a moment, not a check that runs forever.

### Format

```
-- ===FUNC <oid> <name>(<identity args>)
CREATE OR REPLACE FUNCTION ...
$function$
-- ===END <oid>
```

Ordered by `oid`. Each definition is exactly what `pg_get_functiondef` returned,
so it is directly executable: every attribute — `STRICT`, `PARALLEL`, `COST`,
the `SET search_path` — is carried, which is why the capture uses
`pg_get_functiondef` rather than reassembly from catalogue columns. `0242`'s own
generator makes the same choice for the same reason.

### Restoring

Selectively, which is almost always what is wanted — extract the block between
the `===FUNC` and `===END` markers for the function in question and run it. It is
`CREATE OR REPLACE`, so it needs no drop and breaks no dependency.

Restoring all 257 is possible and rarely right: it would also revert anything
legitimately changed since the capture.

**This is not the first lever to reach for in an outage.** If the deployed guard
is refusing legitimate traffic, reverting `assert_same_company` to return
unconditionally disables all 135 guards in one statement without touching a
single rewritten body. That restores the leak, deliberately — it is an emergency
lever for "the product is broken", not a rollback. Use this capture when a
specific body is wrong and has to go back to what it was.

### Line endings

`.gitattributes` marks this directory `-text -diff`. `core.autocrlf` is `true` in
this checkout and would otherwise normalise the embedded CRs on commit and
re-expand every LF on checkout, breaking the md5 and the fidelity it certifies.
Do not remove that entry.
