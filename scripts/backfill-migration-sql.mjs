#!/usr/bin/env node
// Backfill supabase_migrations.schema_migrations.statements from the repo files.
//
//   node scripts/backfill-migration-sql.mjs --env dev [--apply]
//
// Without --apply it is a dry run and writes nothing.
//
// WHY
//
// Dev's ledger records names only: 257 rows, every one with `statements` NULL,
// every version in the short '0232' form rather than a timestamp. That is the
// signature of rows inserted by hand rather than applied by a runner — the CLI
// has never applied anything to dev. The consequence is that
// applied_migration_digests() returns NULL for every row, so the digest check
// silently verifies nothing on the environment everything now targets.
//
// WHAT THIS DOES AND DOES NOT BUY
//
// Be clear about this, because it is easy to oversell. Backfilling statements
// FROM the repo files makes every digest match BY CONSTRUCTION on day one. It
// proves nothing about what was actually run against dev in the past — that
// history is gone and cannot be recovered.
//
// What it does buy is that from this point on, drift is detectable: if someone
// applies something to dev out of band, or edits a migration file after it was
// applied, the digest stops matching and the check says so. That is the whole
// value, and it is worth having, but it is forward-looking only.
//
// MATCHING
//
// Dev's rows reconstruct directly to filenames: version || '_' || name || '.sql'
// ('0232' + 'drop_partners_basis'). Rows that do not resolve to a repo file are
// LEFT NULL and listed. Those are the one-off data operations that were never
// migrations (clone_org_guards_n_guides, sgc_backdate_postings_to_join_date and
// similar); inventing SQL for them would be worse than leaving them empty.
//
// CREDENTIALS
//
// Needs a service-role key: SUPABASE_DEV_URL / SUPABASE_DEV_SERVICE_ROLE_KEY,
// or PGURL for a direct psql-style connection. schema_migrations lives outside
// the exposed schema, so an anon key cannot reach it and neither can PostgREST
// by default — see the note at the foot of this file.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const migDir = join(here, "..", "supabase", "migrations");
const apply = process.argv.includes("--apply");
const envName = process.argv.includes("--env")
  ? process.argv[process.argv.indexOf("--env") + 1]
  : "dev";

const files = new Map();
for (const f of readdirSync(migDir).filter((f) => f.endsWith(".sql"))) {
  files.set(f.replace(/\.sql$/, ""), join(migDir, f));
}

const md5 = (s) => createHash("md5").update(s).digest("hex");

// ---------------------------------------------------------------- connection
const url = process.env[`SUPABASE_${envName.toUpperCase()}_URL`] ?? process.env.SUPABASE_URL;
const key = process.env[`SUPABASE_${envName.toUpperCase()}_SERVICE_ROLE_KEY`] ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    `No credentials for "${envName}". Set SUPABASE_${envName.toUpperCase()}_URL and ` +
    `SUPABASE_${envName.toUpperCase()}_SERVICE_ROLE_KEY.`,
  );
  process.exit(2);
}

// A single SECURITY DEFINER RPC is the only way in from PostgREST, because
// supabase_migrations is not an exposed schema. See the foot of this file.
async function rpc(fn, body) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  return res.json();
}

const rows = await rpc("applied_migration_digests");

let matched = 0, already = 0;
const unresolved = [];
const updates = [];

for (const r of rows) {
  // Dev stores version and name separately; applied_migration_digests returns
  // only the name, so try the name as-is first and then every file whose
  // stripped stem matches it.
  let stem = files.has(r.name) ? r.name : null;
  if (!stem) {
    const bare = r.name.replace(/^\d{4}[a-z]?_/, "");
    const hits = [...files.keys()].filter((f) => f.replace(/^\d{4}[a-z]?_/, "") === bare);
    // Only unambiguous matches. drop_partnership_allocation has six files and
    // must not be guessed at — see the multiset note in check-migrations.mjs.
    if (hits.length === 1) stem = hits[0];
    else if (hits.length > 1) { unresolved.push(`${r.name}  (ambiguous: ${hits.join(", ")})`); continue; }
  }
  if (!stem) { unresolved.push(`${r.name}  (no repo file)`); continue; }

  const sql = readFileSync(files.get(stem), "utf8");
  if (r.digest === md5(sql)) { already++; continue; }
  matched++;
  updates.push({ name: r.name, sql, expect: md5(sql) });
}

console.log(`[${envName}] ${rows.length} rows — ${already} already match, ${matched} to backfill, ${unresolved.length} unresolved`);
for (const u of unresolved) console.log(`   left NULL : ${u}`);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to write.");
  process.exit(0);
}

let ok = 0, bad = 0;
for (const u of updates) {
  const [res] = await rpc("set_migration_statements", { p_name: u.name, p_sql: u.sql });
  if (res?.digest === u.expect) ok++;
  else { bad++; console.error(`   MISMATCH after write: ${u.name} (got ${res?.digest}, want ${u.expect})`); }
}
console.log(`\nbackfilled ${ok}, failed ${bad}`);
process.exit(bad ? 1 : 0);

// ---------------------------------------------------------------------------
// set_migration_statements() must exist for --apply to work. It is deliberately
// NOT created by this script and NOT part of a normal migration, because a
// function that rewrites the migration ledger is exactly the kind of thing that
// should not sit in production waiting to be called. Create it for the run and
// drop it afterwards:
//
//   create or replace function public.set_migration_statements(p_name text, p_sql text)
//   returns table(digest text) language sql security definer as $$
//     update supabase_migrations.schema_migrations
//        set statements = array[p_sql] where name = p_name
//     returning md5(array_to_string(statements, E'\n'));
//   $$;
//
//   -- ... run the backfill ...
//
//   drop function public.set_migration_statements(text, text);
