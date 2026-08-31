#!/usr/bin/env node
// Fail if the database has applied a migration the repo does not carry.
//
// This is the loop-closer for docs/MIGRATION_DIVERGENCE.md. Ten migrations were
// applied straight to the database (SQL editor / MCP apply_migration) and never
// written back, which is invisible until someone builds a fresh environment and
// gets a different schema than production. Five of the ten were follow-up
// patches written minutes after an apply — the exact moment nobody is thinking
// about the repo.
//
//   node scripts/check-migrations.mjs
//
// Needs SUPABASE_DB_URL (a direct postgres:// connection string) or
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment. Exits 1 on drift.
//
// Matching rule: migrations before ~0109 are recorded in the database WITHOUT a
// number prefix (repo `0002_multitenant_redesign.sql` = db `multitenant_redesign`),
// so both sides are compared on the name with any leading `NNNN[a-z]_` stripped.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const strip = (n) => n.replace(/^\d{4}[a-z]?_/, "");

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, "..", "supabase", "migrations");
const repo = new Set(
  readdirSync(repoDir).filter((f) => f.endsWith(".sql")).map((f) => strip(f.replace(/\.sql$/, ""))),
);

// Pre-0109 migrations are recorded under names that don't quite match their repo
// filename (init_employee_manager_schema = 0001_init.sql). That history can't be
// resolved by name, so it's baselined — the check's job is to catch NEW drift.
const baseline = new Set(
  readFileSync(join(here, "migration-baseline.txt"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")),
);

// Suffixed migrations (0109b, 0152b) exist because two numbers meant different
// things in the repo and the database. They are only safe if they sort between
// their base number and the next one. Under plain lexical order they do ('_' is
// 0x5F, 'b' is 0x62). Under a digits-only order 0109b reduces to 0109 and
// collides — so assert the property rather than trusting it.
function checkSuffixOrdering(files) {
  const problems = [];
  const sorted = [...files].sort();
  for (const f of files) {
    const m = /^(\d{4})([a-z])_/.exec(f);
    if (!m) continue;
    const base = m[1];
    const i = sorted.indexOf(f);
    const before = sorted.slice(0, i).filter((x) => /^\d{4}/.test(x)).pop();
    const after = sorted.slice(i + 1).find((x) => /^\d{4}/.test(x));
    if (before && before.slice(0, 4) > base) {
      problems.push(`${f} sorts after ${before} — it must follow ${base}`);
    }
    if (after && after.slice(0, 4) < base) {
      problems.push(`${f} sorts before ${after} — it must follow ${base}`);
    }
  }
  return problems;
}

async function dbNames() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role — this reads a system schema).",
    );
    process.exit(2);
  }
  const res = await fetch(`${url}/rest/v1/rpc/applied_migration_digests`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    console.error(`Could not read applied migrations (${res.status}). Is applied_migration_digests() installed? See migration 0229.`);
    process.exit(2);
  }
  // digests are recorded so a file edited in place after being applied is
  // detectable; existence alone would leave that a permanent blind spot for the
  // 34 baselined pre-0109 names.
  const rows = await res.json();
  return rows.map((r) => r.name);
}

const files = readdirSync(repoDir).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, ""));
const orderProblems = checkSuffixOrdering(files);
if (orderProblems.length) {
  console.error("\nMigration ordering is wrong:\n");
  for (const p of orderProblems) console.error(`  ${p}`);
  process.exit(1);
}

const applied = await dbNames();
const missing = applied.filter((n) => !repo.has(strip(n)) && !baseline.has(strip(n)));

if (missing.length === 0) {
  console.log(`OK — all ${applied.length} applied migrations have a repo file; suffix ordering verified.`);
  process.exit(0);
}

console.error(`\n${missing.length} migration(s) applied to the database but MISSING from the repo:\n`);
for (const n of missing) console.error(`  ${n}`);
console.error(`
Export each one and commit it:

  select array_to_string(statements, E';\\n\\n') || ';'
    from supabase_migrations.schema_migrations where name = '<name>';

If its number is already taken in the repo, append a letter suffix (0109b, 0152b)
so both keep their identity and ordering is preserved. See docs/MIGRATION_DIVERGENCE.md.
`);
process.exit(1);
