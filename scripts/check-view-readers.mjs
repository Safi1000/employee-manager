#!/usr/bin/env node
// Does uninvoked_controls() call a view dead that src/ actually reads?
//
// WHAT THIS CATCHES, AND WHY IT EXISTS
//
// every_control_is_invoked reports views that nothing reads. It cannot see
// src/, so 0294 gave it a hand-written map of "views the application reads",
// each entry naming the reading file. That is the right design given the
// constraint — but the map goes stale the moment a new consumer appears, and
// nothing re-greps.
//
// It went stale within a day of being written. The map was established by grep
// on 2026-09-01; JournalView.tsx was pointed at public.journal_lines_regional
// after that, and the check spent the next day reporting the LEDGER DRILL-DOWN
// as a view nothing reads. 0334 added the entry. This script is what would have
// said so on the day.
//
// THE INVERSION IS THE POINT. It does NOT rebuild the map — a second copy would
// drift from the first, and then there would be two things to keep true. It
// tests the CHECK'S OUTPUT against src/:
//
//     for every view uninvoked_controls() calls dead
//       if any file under src/ or supabase/functions/ does .from("<name>")
//         that is a false positive, and this script fails
//
// Three properties follow, and they are the reason this is worth having:
//
//   * IT CANNOT CRY WOLF. A `.from("x")` is a read. Every failure is real.
//     A checker that produces false alarms is a checker nobody reads, which is
//     the warning CLAUDE.md attaches to migration-aliases.txt.
//   * IT IS BOUNDED BY THE FAILURE, NOT THE SCHEMA. It greps only the handful
//     of names the check currently reports, not all sixty-odd views.
//   * THE MAP STAYS WHERE 0294 PUT IT. This script holds no copy of it, so the
//     two cannot disagree.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS SCRIPT IS INTERACTIVE-ONLY. CI IS NOT COVERING THIS.
//
// It has to call uninvoked_controls(), which is SECURITY DEFINER, and 0241
// revoked EXECUTE from anon. The anon keys in .env.local and
// .env.development.local therefore cannot drive it, and there is NO read-only
// production service credential — the same limitation that keeps
// check-migrations.mjs out of CI, recorded in CLAUDE.md under Credentials.
//
// So this runs when an operator runs it, with a service-role key in the
// environment. Do not assume a green pipeline means this passed; nothing in the
// pipeline calls it. If a read-only prod credential is ever issued, this and
// check-migrations.mjs both become CI jobs on the same day and this paragraph
// should be deleted.
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT IT DELIBERATELY DOES NOT CHECK
//
// The other direction — a view that STOPS being read but stays in the map — is
// not caught here. That is a false silence rather than a false alarm, so it
// fails in the safe direction, and catching it would mean parsing the map out
// of pg_proc.prosrc: more fragile than the thing it protects. Decided, not
// overlooked.
//
// It also only sees a literal `.from("name")`. A view read through a variable
// or a template string is invisible to it, and would keep reporting as dead
// until someone adds the map entry by hand. That is the same blind spot the
// grep that built the map had.
//
//   npm run check:view-readers
//   node scripts/check-view-readers.mjs --env prod
//   node scripts/check-view-readers.mjs --self-test   # no database needed
//
// Configure as for check-migrations.mjs:
//   SUPABASE_PROD_URL / SUPABASE_PROD_SERVICE_ROLE_KEY
//   SUPABASE_DEV_URL  / SUPABASE_DEV_SERVICE_ROLE_KEY

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// The project ref IS the identity of an environment, pinned rather than
// inferred — a dev URL under the prod name produces a confident report about a
// database that was never contacted. Same reasoning, same table, as
// check-migrations.mjs.
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
    if (expected && actual !== expected) {
      console.error(
        `\n${name}: ${u} points at project '${actual ?? "unrecognised"}' but ${name} is '${expected}'.\n` +
          `A misaimed environment reports confidently about a database it never read.\n`,
      );
      process.exit(2);
    }
    out.push({ name, url, key: process.env[k], ref: actual, pinned: Boolean(expected) });
  }
  const only = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : null;
  return only ? out.filter((e) => e.name === only) : out;
}

// ------------------------------------------------------------------ sources
const SOURCE_DIRS = ["src", join("supabase", "functions")];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SOURCE_EXT.test(e.name)) out.push(p);
    }
  };
  for (const d of SOURCE_DIRS) {
    const p = join(root, d);
    if (existsSync(p) && statSync(p).isDirectory()) walk(p);
  }
  return out;
}

// Every `.from("x")` / `.from('x')` in the tree, as name -> [file:line].
function readersByRelation(files) {
  const map = new Map();
  const re = /\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        const name = m[1];
        if (!map.has(name)) map.set(name, []);
        map.get(name).push(`${relative(root, f).replace(/\\/g, "/")}:${i + 1}`);
      }
    }
  }
  return map;
}

async function uninvoked(env) {
  const res = await fetch(`${env.url}/rest/v1/rpc/uninvoked_controls`, {
    method: "POST",
    headers: {
      apikey: env.key,
      authorization: `Bearer ${env.key}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${env.name}: not permitted to call uninvoked_controls() (${res.status}). ` +
        `This needs a service-role key — 0241 revoked EXECUTE from anon, and the keys in ` +
        `.env.local are anon keys. See the header of this file.`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `${env.name}: cannot call uninvoked_controls() (${res.status}). Is it installed? See migration 0288/0294.`,
    );
  }
  return await res.json();
}

// --------------------------------------------------------------------- run
const files = sourceFiles();
const readers = readersByRelation(files);

// --self-test: prove the detector still detects, without a database.
//
// This script's whole value is one comparison, and every environment that can
// run it needs a service-role key nobody has in CI. A script that cannot be
// exercised is a script that quietly stops working — the same failure as a test
// suite whose silence cannot distinguish "passed" from "never ran" (CLAUDE.md).
// So: feed the real source scan a fixture list with one name src/ demonstrably
// reads and one it cannot, and require exactly one hit.
if (process.argv.includes("--self-test")) {
  const mustHit = "journal_lines_regional"; // JournalView.tsx reads it (0319, 0334)
  const mustMiss = "a_view_no_file_reads_zzzq";
  const hit = readers.get(mustHit);
  const miss = readers.get(mustMiss);
  const problems = [];
  if (!hit || hit.length === 0) {
    problems.push(
      `expected to find .from("${mustHit}") in src/ and found none — either the scanner is broken ` +
        `or JournalView.tsx stopped reading the view, and both matter`,
    );
  }
  if (miss && miss.length) problems.push(`found a reader for "${mustMiss}", which cannot exist`);
  if (problems.length) {
    console.error(`\nSELF-TEST FAILED (${files.length} files scanned):`);
    for (const p of problems) console.error(`   ${p}`);
    process.exit(1);
  }
  console.log(
    `\nSELF-TEST OK: scanned ${files.length} files; "${mustHit}" found at ${hit.join(", ")}; ` +
      `"${mustMiss}" correctly absent. The comparison this script performs is working — ` +
      `only the database half is untested here.`,
  );
  process.exit(0);
}

const envs = environments();
if (envs.length === 0) {
  console.error(
    "No environment configured. Set SUPABASE_{PROD,DEV}_URL and the matching SERVICE_ROLE_KEY.\n" +
      "Note: anon keys will NOT work — see the header of this file.",
  );
  process.exit(2);
}

console.log(`Scanned ${files.length} source files under ${SOURCE_DIRS.join(", ")}.`);

let bad = false;

for (const env of envs) {
  let rows;
  try {
    rows = await uninvoked(env);
  } catch (e) {
    console.error(`\n${e.message}`);
    bad = true;
    continue;
  }

  const views = rows.filter((r) => r.kind === "view");
  const wrong = [];
  for (const v of views) {
    const hits = readers.get(v.object_name);
    if (hits && hits.length) wrong.push({ name: v.object_name, hits });
  }

  const label = `${env.name} (${env.ref}${env.pinned ? "" : ", UNPINNED"})`;
  if (wrong.length === 0) {
    console.log(
      `\n${label}: OK — ${views.length} view(s) reported unread, and none of them is read in src/.`,
    );
  } else {
    bad = true;
    console.error(`\n${label}: ${wrong.length} FALSE POSITIVE(S) — the check calls these dead and src/ reads them:\n`);
    for (const w of wrong) {
      console.error(`   ${w.name}`);
      for (const h of w.hits) console.error(`      read at ${h}`);
    }
  }
}

if (bad) {
  console.error(
    `
Add each view above to the view_exempt map inside uninvoked_controls(), naming
the file that reads it, in a new migration. 0307 and 0334 are the precedent:
surgery against the live definition with the map row asserted to appear exactly
once, and the resulting count read before the edit rather than written as a
literal.

Do NOT silence this by removing the view from the check's reach. The entry is a
claim someone can verify with one grep, and that is the only thing keeping the
map from becoming a silencing mechanism.
`,
  );
  process.exit(1);
}

console.log("\nEvery view reported unread is genuinely unread in src/.");
