#!/usr/bin/env node
// Migration ledger audit — BOTH directions, EVERY environment.
//
// The first version of this script checked one direction (applied-but-not-in-
// repo) against one environment (dev). It passed clean while production was
// wrong: 0231, 0231b and 0232 had been applied there through the SQL editor,
// which records no schema_migrations row. In-repo-but-unrecorded was invisible
// to it, and production was never checked at all.
//
//   npm run check:migrations              # every configured environment
//   npm run check:migrations -- --env dev # one of them
//
// Configure per environment, e.g.
//   SUPABASE_DEV_URL  / SUPABASE_DEV_SERVICE_ROLE_KEY
//   SUPABASE_PROD_URL / SUPABASE_PROD_SERVICE_ROLE_KEY
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are accepted as an unnamed default.
//
// LEDGER FORMATS DIFFER, which is why they must be normalised before comparison:
//   prod  version = '20260831063626'  name = '0230_partner_remuneration_basis'
//   dev   version = '0230'            name = 'partner_remuneration_basis'
// Stripping a leading NNNN[a-z]_ from both the repo filename and the recorded
// name reduces the two to the same key. Without this, a naive count of dev came
// back as zero matches and looked like total divergence.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const key = (n) => n.replace(/^\d{4}[a-z]?_/, "");

// ---------------------------------------------------------------- repo side
const files = readdirSync(join(here, "..", "supabase", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.replace(/\.sql$/, ""));
const repoKeys = new Set(files.map(key));

// Suffixed migrations (0109b, 0152b) only work if they sort between their base
// number and the next. Plain lexical order gives that ('_' 0x5F < 'b' 0x62); a
// digits-only sort collapses 0109b onto 0109. Assert rather than assume.
function suffixOrderProblems() {
  const problems = [];
  const sorted = [...files].sort();
  for (const f of files) {
    const m = /^(\d{4})([a-z])_/.exec(f);
    if (!m) continue;
    const i = sorted.indexOf(f);
    const before = sorted.slice(0, i).filter((x) => /^\d{4}/.test(x)).pop();
    const after = sorted.slice(i + 1).find((x) => /^\d{4}/.test(x));
    if (before && before.slice(0, 4) > m[1]) problems.push(`${f} sorts after ${before}`);
    if (after && after.slice(0, 4) < m[1]) problems.push(`${f} sorts before ${after}`);
  }
  return problems;
}

function loadPairs(file) {
  const p = join(here, file);
  if (!existsSync(p)) return new Map();
  const out = new Map();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [l, r] = t.split("=").map((s) => s && s.trim());
    if (l && r) out.set(l, r);
  }
  return out;
}
const aliases = loadPairs("migration-aliases.txt");          // repo -> applied
const aliasApplied = new Set(aliases.values());
const baseline = new Set(
  existsSync(join(here, "migration-baseline.txt"))
    ? readFileSync(join(here, "migration-baseline.txt"), "utf8")
        .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : [],
);

// --------------------------------------------------------------- env config
function environments() {
  const out = [];
  for (const [name, u, k] of [
    ["prod", "SUPABASE_PROD_URL", "SUPABASE_PROD_SERVICE_ROLE_KEY"],
    ["dev", "SUPABASE_DEV_URL", "SUPABASE_DEV_SERVICE_ROLE_KEY"],
    ["default", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  ]) {
    if (process.env[u] && process.env[k]) out.push({ name, url: process.env[u], key: process.env[k] });
  }
  const only = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : null;
  return only ? out.filter((e) => e.name === only) : out;
}

async function applied(env) {
  const res = await fetch(`${env.url}/rest/v1/rpc/applied_migration_digests`, {
    method: "POST",
    headers: { apikey: env.key, authorization: `Bearer ${env.key}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`${env.name}: cannot read applied migrations (${res.status}). Is applied_migration_digests() installed? See migration 0229.`);
  return await res.json();
}

// -------------------------------------------------------------------- audit
const orderProblems = suffixOrderProblems();
if (orderProblems.length) {
  console.error("\nMigration ordering is wrong:\n");
  for (const p of orderProblems) console.error(`  ${p}`);
  process.exit(1);
}

const envs = environments();
if (envs.length === 0) {
  console.error("No environment configured. Set SUPABASE_{PROD,DEV}_URL and the matching SERVICE_ROLE_KEY.");
  process.exit(2);
}

let bad = 0;
for (const env of envs) {
  const rows = await applied(env);
  const appliedKeys = new Set(rows.map((r) => key(r.name)));

  // repo -> ledger. THIS is the direction that was missing, and the one that
  // production failed: a file that has been applied but recorded nowhere.
  const notRecorded = files.filter((f) => {
    const k = key(f);
    if (appliedKeys.has(k)) return false;
    if (aliases.has(k) && appliedKeys.has(aliases.get(k))) return false;
    return !baseline.has(k);
  });

  // ledger -> repo. Applied out of band and never written back.
  const notInRepo = rows.filter((r) => {
    const k = key(r.name);
    return !repoKeys.has(k) && !aliasApplied.has(k) && !baseline.has(k);
  }).map((r) => r.name);

  const ok = notRecorded.length === 0 && notInRepo.length === 0;
  if (!ok) bad++;
  console.log(`\n[${env.name}] ${rows.length} applied, ${files.length} files — ` +
    (ok ? "OK" : `${notRecorded.length} in repo not recorded, ${notInRepo.length} recorded not in repo`));
  for (const n of notRecorded) console.log(`   in repo, NOT recorded : ${n}`);
  for (const n of notInRepo)   console.log(`   recorded, NOT in repo : ${n}`);
}

if (bad) {
  console.error(`
Resolve each one. Applied but unrecorded -> re-run it through the migration
runner (it should be idempotent) or insert the schema_migrations row so the
ledger describes reality. Recorded but absent from the repo -> export it and
commit the file:

  select array_to_string(statements, E';\n\n') || ';'
    from supabase_migrations.schema_migrations where name = '<name>';

If a number is already taken, add a letter suffix (0109b, 0152b). If the two
names are the same migration under different spellings, add the pair to
scripts/migration-aliases.txt — never to silence a failure you have not checked.
`);
  process.exit(1);
}
console.log("\nAll environments consistent with the repo.");
