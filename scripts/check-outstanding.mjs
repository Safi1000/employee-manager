// check-outstanding.mjs — fail if invoice outstanding is computed anywhere but
// invoiceOutstanding().
//
// WHY THIS EXISTS
//
// Outstanding is GROSS: invoice_amount less amount_received. A1 settled it and
// 0221 removed the withholding deduction from record_invoice_payment.
// record_invoice_payment, run_auto_invoices and ar_control_equals_open_invoices
// all agree.
//
// The frontend did not. One helper and EIGHT open-coded copies subtracted
// withholding_tax as well, so every aging figure and receivables balance an
// operator read was understated while the ledger was right — two report
// families disagreeing because each computed independently, which is the defect
// this project was started to remove.
//
// The copies were deleted rather than corrected. THE NINTH COPY IS HOW THE
// TENTH GETS WRITTEN, so this script is the thing that fires on the tenth.
//
// THE BLIND SPOT THIS SCRIPT WAS BORN WITH, AND WHY RULE 2 EXISTS
//
// The first version matched the literal token `withholding_tax` beside
// `amount_received`. It passed a tree that still contained:
//
//     const wht = Number(inv.withholding_tax ?? 0);
//     const outstanding = Number(inv.invoice_amount) - wht - Number(inv.amount_received);
//
// One statement earlier, the deduction is bound to a local, and the token is
// gone. That copy was found by accident, not by this script, and it is exactly
// the ninth copy the script exists to catch. Rule 2 matches the SHAPE instead —
// invoice_amount and amount_received with a third subtracted term between them —
// so it does not care what the middle term is called.
//
// A checker that only recognises the spelling of the last bug it saw is a
// checker that will miss the next one (TENANT_GUARD_REPORT.md 9.6).
//
// WHAT IT CANNOT DO, STATED PLAINLY
//
// It is a lint, not a control. It cannot prove the frontend agrees with the
// ledger — ledger_checks runs in Postgres and this divergence lives in
// TypeScript, so no SQL check can see it. The real fix is prevention: expose
// outstanding from the database so there is no second implementation to
// diverge. This is the cheap guard that works today, and it is honest about
// being that.
//
// NOT COVERED, DELIBERATELY: the `total_due` question. Six database objects
// compute outstanding from coalesce(total_due, invoice_amount) while
// ar_control_equals_open_invoices uses invoice_amount, a 1,924,000.00
// divergence on crm-design. That is an open policy question, not a defect with
// a known correct side, and a lint must not encode a decision nobody has made.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");
const SRC = join(ROOT, "src");

// The one place outstanding is allowed to be computed.
const ALLOWED = ["src/app/lib/supabase.ts"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// Comments are stripped first: this file and supabase.ts both DESCRIBE the
// defect in prose, and a checker that trips over its own explanation is a
// checker someone disables.
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// The minus must be a SPACED arithmetic operator. An unspaced hyphen is a
// className (`text-right`, `px-2`), and matching those made the first run of
// rule 2 red on a JSX table that computes nothing.

// Rule 1 — the deduction, spelled out.
const NAMED = /withholding_tax[\s\S]{0,120}?\s-\s[\s\S]{0,120}?amount_received|amount_received[\s\S]{0,120}?\s-\s[\s\S]{0,120}?withholding_tax/;

// Rule 2 — the SHAPE: invoice_amount, then a subtracted middle term, then
// amount_received. Catches the local-variable form rule 1 missed.
const SHAPE = /invoice_amount[\s\S]{0,80}?\s-\s[\s\S]{0,80}?\s-\s[\s\S]{0,80}?amount_received/;

// Rule 3 — THE AGGREGATE FORM, added by 0316.
//
// Rules 1 and 2 both look for a PER-INVOICE calculation, and both are anchored
// on a token that only appears there. Three further copies were sitting in the
// tree the whole time, in the client-ledger aggregate:
//
//     openingForMonth + total_invoiced - total_withholding - total_received
//     Number(c.opening_balance ?? 0) + total_invoiced - total_withholding - total_received
//     fmtPkr(amt - wht - received)
//
// No `invoice_amount`, no `withholding_tax` — the sums are named for what they
// are, so rule 1 saw no token and rule 2 saw no anchor. That is the same
// failure that produced rule 2: a checker anchored on the SPELLING of the last
// bug it saw. Rule 3 anchors on the RELATIONSHIP instead — a withholding-ish
// term SUBTRACTED in a statement that is computing something received or
// outstanding — so it does not care what any of the three are called.
//
// The "received or outstanding" requirement is what keeps it off the DOCUMENT
// arithmetic. InvoiceGenerate computes `gross - manualWithholding + carried`
// for the printed Total Due, which is presentation and legitimately net of
// withholding (0313). It subtracts withholding and stays green, because it is
// not computing a balance.
const AGG =
  /\s-\s[^;]{0,60}?(withholding|wht)[^;]{0,160}?(received|outstanding)|(received|outstanding)[^;]{0,160}?\s-\s[^;]{0,60}?(withholding|wht)/i;

export function scan(text) {
  const src = stripComments(text);
  const hits = [];
  let offset = 0;
  // Statement-sized windows, so a match is a real expression rather than two
  // unrelated lines that happen to sit near each other. The offset is tracked
  // cumulatively rather than with indexOf, so identical statements do not all
  // report the position of the first.
  for (const stmt of src.split(";")) {
    const start = offset;
    offset += stmt.length + 1;
    const named = NAMED.test(stmt);
    const shape = SHAPE.test(stmt);
    const agg = AGG.test(stmt);
    if (!named && !shape && !agg) continue;
    // Point at the token itself, not the statement start — a statement begins
    // after the PREVIOUS semicolon, which can be several lines back.
    const token = named ? "withholding_tax" : shape ? "invoice_amount" : "-";
    const hit = start + Math.max(0, stmt.indexOf(token));
    hits.push({
      line: src.slice(0, hit).split("\n").length,
      rule: named
        ? "withholding_tax subtracted"
        : shape
          ? "third term subtracted"
          : "withholding subtracted from a balance",
      text: src.slice(Math.max(0, hit - 40), hit + 110).replace(/\s+/g, " ").trim(),
    });
  }
  return hits;
}

// --- self-check: the checker must be able to fail -------------------------
// A checker that has never gone red is indistinguishable from one that cannot.
// Both rules are asserted red, and an innocent literal asserted green, before
// the real run.
{
  const NAMED_COPY =
    "const outstanding = Number(inv.invoice_amount) - Number(inv.withholding_tax ?? 0) - Number(inv.amount_received);";
  const LOCAL_COPY =
    "const outstanding = Number(inv.invoice_amount) - wht - Number(inv.amount_received);";
  const AGG_COPY =
    "const outstanding = openingForMonth + total_invoiced - total_withholding - total_received;";
  const PDF_COPY = "return fmtPkr(amt - wht - received);";
  const INNOCENT = "const row = { invoice_amount: 0, withholding_tax: 0, amount_received: 0 };";
  const GOOD = "const outstanding = Number(inv.invoice_amount ?? 0) - Number(inv.amount_received ?? 0);";
  // The DOCUMENT total, which is legitimately net of withholding (0313) and
  // must stay green — otherwise rule 3 is a rule someone deletes.
  const DOCUMENT = "const lineTotal = subtotal + addedTotal - withheldTotal + carried;";
  const AGG_GOOD = "const outstanding = openingForMonth + total_invoiced - total_received;";
  const fail = [];
  if (scan(NAMED_COPY).length === 0) fail.push("rule 1 did not detect a named copy");
  if (scan(LOCAL_COPY).length === 0) fail.push("rule 2 did not detect a local-variable copy");
  if (scan(AGG_COPY).length === 0) fail.push("rule 3 did not detect the aggregate copy");
  if (scan(PDF_COPY).length === 0) fail.push("rule 3 did not detect the locals-only copy");
  if (scan(INNOCENT).length > 0) fail.push("an object literal was flagged");
  if (scan(GOOD).length > 0) fail.push("the correct two-term form was flagged");
  if (scan(DOCUMENT).length > 0) fail.push("the document total was flagged");
  if (scan(AGG_GOOD).length > 0) fail.push("the corrected aggregate was flagged");
  if (fail.length) {
    console.error("check-outstanding: SELF-CHECK FAILED —");
    for (const f of fail) console.error("  " + f);
    process.exit(2);
  }
}

const files = walk(SRC);
const violations = [];
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
  if (ALLOWED.includes(rel)) continue;
  for (const h of scan(readFileSync(file, "utf8"))) violations.push({ file: rel, ...h });
}

if (violations.length > 0) {
  console.error(`\ncheck-outstanding: ${violations.length} open-coded outstanding calculation(s).\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  [${v.rule}]\n    ${v.text}\n`);
  console.error(
    "Outstanding is GROSS: invoice_amount - amount_received. Use invoiceOutstanding()\n" +
      "from src/app/lib/supabase.ts. See A1 and migration 0221.\n",
  );
  process.exit(1);
}

console.log(
  `check-outstanding: ${files.length} files scanned, self-check passed all eight ways, no open-coded outstanding calculations.`,
);
