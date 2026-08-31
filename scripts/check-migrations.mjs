#!/usr/bin/env node
// Migration ledger audit — BOTH directions, EVERY environment, BY COUNT.
//
// Three defects have been found in this script, each of the same shape: it
// passed while being wrong.
//
//   1. It checked one direction (applied-but-not-in-repo) against one
//      environment (dev). Production was wrong the whole time — 0231, 0231b and
//      0232 had been applied through the SQL editor, which records no
//      schema_migrations row — and was never checked at all.
//
//   2. It compared migration stems as SETS. Three stems are not unique in the
//      repo, and one of them is not unique by a wide margin:
//
//        6  drop_partnership_allocation   (0179c 0182c 0203b 0205b 0224b 0231b)
//        2  change_category_enum_cast     (0148 0184)
//        2  fix_cheque_treasury_company_scope
//
//      Production records drop_partnership_allocation ONCE. Set comparison sees
//      one match on each side and reports zero discrepancy in both directions.
//      Five missing migrations were invisible. Comparison is now by COUNT.
//
//   3. It reported nothing about environments that record no SQL. Dev's
//      schema_migrations has `statements` NULL on all 257 rows, so digests come
//      back NULL and the digest check silently verifies nothing. It now says so.
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

// Count occurrences of each key, remembering which originals produced them, so
// a shortfall can name the specific files rather than just a number.
function tally(items, toKey) {
  const m = new Map();
  for (const it of items) {
    const k = toKey(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

// ---------------------------------------------------------------- repo side
const files = readdirSync(join(here, "..", "supabase", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.replace(/\.sql$/, ""));

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
const baseline = new Set(
  existsSync(join(here, "migration-baseline.txt"))
    ? readFileSync(join(here, "migration-baseline.txt"), "utf8")
        .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : [],
);

// Repo keys, already translated through the alias map, so both sides of the
// comparison speak the applied-name vocabulary.
const repoKey = (f) => {
  const k = key(f);
  return aliases.has(k) ? aliases.get(k) : k;
};
const repoTally = tally(files, repoKey);

// --------------------------------------------------------------- env config
//
// THE PROJECT REF IS PINNED, NOT INFERRED.
//
// An environment used to be whatever URL happened to be in the shell. Nothing
// checked that SUPABASE_PROD_URL pointed at production: a copy-pasted dev URL
// under the prod name produces a clean, confident, entirely wrong report, and
// the failure mode is the dangerous direction — "prod is fine" when prod was
// never contacted. Same shape as the FORCE RLS pre-check that tested the wrong
// role and passed.
//
// The refs below are the identity of each environment. A URL that does not
// carry the expected ref is refused rather than audited.
//
// `default` is deliberately unpinned: it is the escape hatch for a throwaway or
// branch database. It is also reported as UNPINNED in the output, because an
// environment nobody can name is not evidence about the environments that
// matter.
const PROJECT_REFS = {
  prod: "mmkfpnshxjcyijhuydgr", // crm-design
  dev: "wlyhbvunvdsropqzlpwx", // crm-design-dev
};

const refOf = (url) => {
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in)/i.exec(url.trim());
  return m ? m[1] : null;
};

function environments() {
  const out = [];
  for (const [name, u, k] of [
    ["prod", "SUPABASE_PROD_URL", "SUPABASE_PROD_SERVICE_ROLE_KEY"],
    ["dev", "SUPABASE_DEV_URL", "SUPABASE_DEV_SERVICE_ROLE_KEY"],
    ["default", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  ]) {
    if (!process.env[u] || !process.env[k]) continue;
    const url = process.env[u];
    const expected = PROJECT_REFS[name];
    const actual = refOf(url);
    if (expected) {
      if (actual !== expected) {
        console.error(
          `\n${name}: ${u} points at project '${actual ?? "unrecognised"}' but ${name} is '${expected}'.\n` +
            `A misaimed environment reports confidently about a database it never read.\n` +
            `Fix the variable, or update PROJECT_REFS in scripts/check-migrations.mjs if the project genuinely moved.\n`,
        );
        process.exit(2);
      }
    }
    out.push({ name, url, key: process.env[k], ref: actual, pinned: Boolean(expected) });
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

// A run that audits one of the two real environments is not a clean bill of
// health for both, and the report must not read like one. prod and dev have
// diverged before and will again.
const audited = new Set(envs.map((e) => e.name));
const unaudited = ["prod", "dev"].filter((n) => !audited.has(n));
if (unaudited.length && !process.argv.includes("--env")) {
  console.warn(`\nNOT AUDITED: ${unaudited.join(", ")} — no URL/key pair configured. This run says nothing about ${unaudited.length === 1 ? "it" : "them"}.`);
}

let bad = 0;
for (const env of envs) {
  const rows = await applied(env);
  const appliedTally = tally(rows, (r) => key(r.name));

  const shortfalls = [];   // repo has more copies than the ledger records
  const excesses = [];     // ledger records more than the repo has files for

  for (const [k, fs] of repoTally) {
    if (baseline.has(k)) continue;
    const have = appliedTally.get(k)?.length ?? 0;
    if (have < fs.length) {
      // Name the files, and say plainly when the shortfall is a count rather
      // than an absence — that is the case set comparison used to miss.
      shortfalls.push(
        have === 0
          ? `${fs.join(", ")}  (not recorded at all)`
          : `${fs.join(", ")}  (${fs.length} files, only ${have} recorded)`,
      );
    }
  }

  for (const [k, rs] of appliedTally) {
    if (baseline.has(k)) continue;
    const want = repoTally.get(k)?.length ?? 0;
    if (rs.length > want) {
      const names = rs.map((r) => r.name).join(", ");
      excesses.push(
        want === 0
          ? `${names}  (no repo file)`
          : `${names}  (${rs.length} recorded, only ${want} file${want === 1 ? "" : "s"})`,
      );
    }
  }

  // An environment whose ledger stores no SQL cannot be digest-checked. Dev is
  // in exactly that state: every row was hand-inserted with version and name
  // only, so `statements` is NULL and md5(NULL) comes back NULL. Say it out
  // loud rather than letting a check that verifies nothing report success.
  const withDigest = rows.filter((r) => r.digest).length;
  const digestNote =
    withDigest === 0
      ? "NO recorded SQL — digest checking unavailable in this environment"
      : withDigest < rows.length
        ? `${rows.length - withDigest} of ${rows.length} rows carry no SQL — those cannot be digest-checked`
        : null;

  const ok = shortfalls.length === 0 && excesses.length === 0;
  if (!ok) bad++;
  console.log(`\n[${env.name}${env.pinned ? ` ${env.ref}` : " UNPINNED"}] ${rows.length} applied, ${files.length} files — ` +
    (ok ? "OK" : `${shortfalls.length} in repo not recorded, ${excesses.length} recorded not in repo`));
  if (!env.pinned) console.log(`   note: not pinned to a project ref — this proves nothing about prod or dev`);
  if (digestNote) console.log(`   note: ${digestNote}`);
  for (const n of shortfalls) console.log(`   in repo, NOT recorded : ${n}`);
  for (const n of excesses)   console.log(`   recorded, NOT in repo : ${n}`);
}

if (bad) {
  console.error(`
Resolve each one. Applied but unrecorded -> re-run it through the migration
runner (it should be idempotent) or insert the schema_migrations row so the
ledger describes reality. Recorded but absent from the repo -> export it and
commit the file:

  select array_to_string(statements, E';\n\n') || ';'
    from supabase_migrations.schema_migrations where name = '<name>';

A count mismatch ("6 files, only 1 recorded") is NOT a naming problem and an
alias will not fix it — five migrations really are missing from that ledger.

If a number is already taken, add a letter suffix (0109b, 0152b). If the two
names are the same migration under different spellings, add the pair to
scripts/migration-aliases.txt — never to silence a failure you have not checked.
`);
  process.exit(1);
}
console.log("\nAll environments consistent with the repo.");
