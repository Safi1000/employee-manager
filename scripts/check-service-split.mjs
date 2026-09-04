// THE SERVICE-PERIOD PREVIEW, CHECKED. `node scripts/check-service-split.mjs`
//
// serviceSplit() in Expenses.tsx shows the operator which months a bill will
// land in before they commit to it. It POSTS NOTHING — release_prepaid_expenses
// (0347/0356) is the authority, and its own probe lives in 0356. This exists
// because the preview is date arithmetic and date arithmetic already went wrong
// once here: new Date("2026-03-31") parses as UTC while new Date(y, m, 0) is
// local, so in Pakistan (UTC+5) the month end compared as EARLIER than the
// period end, the final-month remainder branch never fired, and a three-month
// split came up a rupee short. It passed in UTC. Run it under a real zone.
//
// It LIFTS the two functions out of the shipped file rather than copying them,
// so a copy cannot drift from the original, and it throws if the lift fails.

import assert from "assert";
import fs from "fs";

// Lift serviceSplit + monthBounds straight out of the file so the check tests
// the shipped source, not a copy of it.
const src = fs.readFileSync("src/app/pages/super-admin/Expenses.tsx", "utf8");
const grab = (name) => {
  const i = src.indexOf(`const ${name} = `);
  const j = src.indexOf("\r\n};", i);
  return src
    .slice(i, j + 4)
    .replace(/: \[string, string\]/g, "")
    .replace(/: string/g, "")
    .replace(/: number/g, "")
    .replace(/: \{ key[^}]*\}\[\] = \[\]/, " = []");
};
const code = grab("monthBounds") + "\n" + grab("serviceSplit") + "\nexport { monthBounds, serviceSplit };";
const out = new URL("./_service-split-lifted.mjs", import.meta.url);
fs.writeFileSync(out, code);
const { monthBounds, serviceSplit } = await import("./_service-split-lifted.mjs");

assert.deepStrictEqual(monthBounds("2026-09-05"), ["2026-09-01", "2026-09-30"]);
assert.deepStrictEqual(monthBounds("2026-02-14"), ["2026-02-01", "2026-02-28"]);

// The brief's bill: 15 Aug – 15 Sep 2026, PKR 10,000.
// Aug holds 17 days (15..31), Sep holds 15 (1..15), total 32.
const s = serviceSplit("2026-08-15", "2026-09-15", 10000);
assert.strictEqual(s.length, 2);
assert.deepStrictEqual(s.map((x) => [x.key, x.days]), [["2026-08", 17], ["2026-09", 15]]);
assert.strictEqual(s[0].amount, 5312.5);            // 10000*17/32
assert.strictEqual(Math.round(s.reduce((a, b) => a + b.amount, 0) * 100) / 100, 10000); // last takes the remainder
assert.notStrictEqual(s[0].amount, s[1].amount);    // weighted, not halved

// Sums exactly on a period whose daily share does not round cleanly.
const t = serviceSplit("2026-01-01", "2026-03-31", 1000);
assert.strictEqual(t.length, 3);
assert.strictEqual(Math.round(t.reduce((a, b) => a + b.amount, 0) * 100) / 100, 1000);

// One month in, one month out.
assert.strictEqual(serviceSplit("2026-09-01", "2026-09-30", 500).length, 1);
assert.deepStrictEqual(serviceSplit("2026-09-30", "2026-09-01", 500), []);

console.log("serviceSplit / monthBounds: all checks passed");
