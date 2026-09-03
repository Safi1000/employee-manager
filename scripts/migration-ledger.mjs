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

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
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
// apply_migration is the BARE name; the repo stores it NUMBERED —
// `NNNN[a-z]_name.sql`, per CLAUDE.md. The first version of this looked only for
// `<name>.sql`, which no correctly-named file in this repo has ever matched: it
// blocked on every applied migration and could only be satisfied by writing an
// UNNUMBERED file, which is itself the divergence this script exists to stop.
// A guard that can only be satisfied by doing the wrong thing is worse than no
// guard, because it teaches people to route around it.
//
// So: the numbered form is the one that counts, and the bare form is still
// accepted for the handful of unnumbered files that predate the convention.
const hasFile = (name) => {
  if (existsSync(join(migrationsDir, `${name}.sql`))) return true;
  const suffix = `_${name}.sql`;
  try {
    return readdirSync(migrationsDir).some(
      (f) => f.endsWith(suffix) && /^\d{4}[a-z]?_/.test(f),
    );
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// guard (PreToolUse): refuse an apply_migration whose SQL does not assert that
// tenant_guard_gaps() is empty.
//
// FOUR REGRESSIONS, ONE CAUSE. 0348 fixed two guard gaps introduced by 0345 and
// 0347, 0352 fixed one from 0349, 0363 fixed a fourth from 0361. Every one was a
// guard that was CORRECT and simply never checked against the detector — and
// tenant_guard_covered() matches on the parameter name appearing inside the
// guard call, so being right is not the same as being visible.
//
// "Remember to check" failed four times, so this stops being remembered. The
// assertion is cheap (a pure read), every migration can run it, and it fires in
// the same transaction as the change — so a migration that opens a gap rolls
// itself back instead of leaving one for the next session to find.
//
// THE ESCAPE HATCH IS A SENTENCE, NOT A FLAG. A migration that genuinely cannot
// assert says so in its own text with a reason. Skipping then costs a written
// justification that survives in the recorded SQL, which is the difference
// between a decision and an omission.
// ---------------------------------------------------------------------------
const ASSERTION_RE = /tenant_guard_gaps\s*\(\s*\)/;
const OPT_OUT_RE = /TENANT GUARD ASSERTION NOT APPLICABLE:\s*\S/;

if (mode === "guard") {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    process.exit(0);
  }
  const sql = payload?.tool_input?.query;
  // Not a string means not a shape this understands. Never crash the session.
  if (typeof sql !== "string" || !sql) process.exit(0);
  if (ASSERTION_RE.test(sql) || OPT_OUT_RE.test(sql)) process.exit(0);

  const reason =
    `This migration does not assert that tenant_guard_gaps() is empty, so it can ` +
    `open a cross-tenant hole and report success.\n\n` +
    `That has happened four times: 0348 fixed two gaps from 0345/0347, 0352 one ` +
    `from 0349, 0363 a fourth from 0361 — every one a guard that was written ` +
    `correctly and never checked against the detector that has to be able to READ ` +
    `it.\n\n` +
    `Add this before applying (it is the tail of scripts/migration-template.sql):\n\n` +
    `  do $$\n` +
    `  declare v_n int; v_who text;\n` +
    `  begin\n` +
    `    select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')\n` +
    `      into v_n, v_who\n` +
    `      from public.tenant_guard_gaps() g;\n` +
    `    if v_n <> 0 then\n` +
    `      raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;\n` +
    `    end if;\n` +
    `  end $$;\n\n` +
    `If it genuinely does not apply, say so IN THE MIGRATION with a reason:\n` +
    `  -- TENANT GUARD ASSERTION NOT APPLICABLE: <why>\n` +
    `A written justification survives in the recorded SQL; an omission does not.`;

  // Both shapes, so this works whichever the harness reads. `deny` and `block`
  // mean the same thing here: the apply does not happen.
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

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

  // NNNN in the suggested path, not a bare name. The message is the only
  // instruction anybody reads at this moment, so it must name the convention
  // the check actually accepts.
  const list = stillOwed.map((n) => `  supabase/migrations/NNNN_${n}.sql`).join("\n");
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
