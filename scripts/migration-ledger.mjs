#!/usr/bin/env node
// Close the apply-without-committing loop at the moment the divergence is made.
//
// WHY THIS EXISTS WHEN check-migrations.mjs ALREADY DOES
//
// check-migrations.mjs compares the database against the repo. It is correct and
// it has never once run: it needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and
// scripts/pre-push — the thing meant to run it — skips itself when those are
// absent and is only installed if somebody remembers `git config core.hooksPath
// scripts`. Both holes were open in this clone. Meanwhile 0237..0252 were
// applied and, for a while, existed only as schema_migrations rows.
//
// So this is not another detector. It fires at the instant apply_migration is
// called, in the session that called it, and needs no secrets and no network:
//
//   record   append the applied migration name to the ledger (PostToolUse)
//   check    fail if any ledgered name has no file in supabase/migrations/ (Stop)
//
// The ledger is per-project and gitignored. `check` prunes names once their
// file exists, so a session that writes the file before finishing sees nothing.
//
// Both modes read the hook's JSON payload on stdin and must never crash the
// session: on unexpected input they exit 0 silently. The one thing they will do
// loudly is block on a real, verifiable gap.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const ledgerPath = join(root, ".claude", "applied-migrations.log");
const migrationsDir = join(root, "supabase", "migrations");

const mode = process.argv[2];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readLedger() {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// A migration is "written" if a file of that name exists. The name recorded by
// apply_migration is the bare name; the repo stores it with a .sql suffix.
const hasFile = (name) => existsSync(join(migrationsDir, `${name}.sql`));

if (mode === "record") {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    process.exit(0);
  }
  const name = payload?.tool_input?.name;
  if (typeof name !== "string" || !name) process.exit(0);

  // Only record a successful apply. A failed one changed nothing, and recording
  // it would block the session over a migration that does not exist anywhere.
  const res = payload?.tool_response;
  const ok = res === undefined || res?.success !== false;
  if (!ok) process.exit(0);

  const existing = readLedger();
  if (!existing.includes(name)) {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, [...existing, name].join("\n") + "\n");
  }
  process.exit(0);
}

if (mode === "check") {
  const ledger = readLedger();
  if (ledger.length === 0) process.exit(0);

  const missing = ledger.filter((n) => !hasFile(n));

  // Prune the ones that now have files, so the ledger stays a live list of what
  // is still owed rather than a growing history.
  const stillOwed = missing;
  if (stillOwed.length !== ledger.length) {
    writeFileSync(ledgerPath, stillOwed.length ? stillOwed.join("\n") + "\n" : "");
  }

  if (stillOwed.length === 0) process.exit(0);

  const list = stillOwed.map((n) => `  supabase/migrations/${n}.sql`).join("\n");
  const reason =
    `${stillOwed.length} migration(s) were applied to the database this session ` +
    `with no file in the repo:\n\n${list}\n\n` +
    `This is the exact mechanism that produced docs/MIGRATION_DIVERGENCE.md and, ` +
    `later, the 0237-0252 gap. Write each file before finishing. To recover the ` +
    `SQL as applied:\n\n` +
    `  select array_to_string(statements, E';\\n\\n') || ';'\n` +
    `    from supabase_migrations.schema_migrations where name = '<name>';\n\n` +
    `The ledger is .claude/applied-migrations.log; entries clear themselves once ` +
    `the file exists.`;

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

process.stderr.write("usage: migration-ledger.mjs record|check\n");
process.exit(2);
