// THE ATTENDANCE SHEET'S COLUMN INDEXING, CHECKED. `node scripts/check-attendance-window.mjs`
//
// buildAttendanceRows used to be month-only and keyed every mark by
// day-of-month. It now takes EITHER a month or an arbitrary range, and keys by
// column index, so the Attendance board's client export (which may span a month
// boundary: 20 Jul → 10 Aug) can share it with the Monthly Board.
//
// TWO THINGS THAT MUST HOLD, and neither is obvious from reading the diff:
//
//   1. For a whole month, column index + 1 IS day-of-month. AttendanceSheetModal's
//      grid reads cellsByEmp with the key `${i + 1}|${shift}` where i is the
//      0-based column. If that equivalence ever breaks, every cell in the viewer
//      shifts by a day and nothing throws.
//   2. Across a month boundary the indices are contiguous and never collide —
//      which is the whole reason the key stopped being day-of-month. 20 Jul and
//      20 Aug are both "20"; as columns they are 0 and 31.
//
// It LIFTS enumerateDates out of the shipped file rather than copying it, and
// throws if the lift fails. Run it under a real timezone as well as UTC: date
// arithmetic in this codebase has already been wrong that way once
// (scripts/check-service-split.mjs).

import assert from "assert";
import fs from "fs";

const src = fs.readFileSync("src/app/lib/attendanceSheet.ts", "utf8");
const i = src.indexOf("export function enumerateDates");
if (i < 0) throw new Error("enumerateDates not found in attendanceSheet.ts — the lift is broken, not the code");
const j = src.indexOf("\n}", i);
const code = src
  .slice(i, j + 2)
  .replace(/: string\[\]/g, "")
  .replace(/: string/g, "")
  ; // the lifted slice already carries its own `export function` declaration
const out = new URL("./_attendance-window-lifted.mjs", import.meta.url);
fs.writeFileSync(out, code);
const { enumerateDates } = await import("./_attendance-window-lifted.mjs");

// ---- 1. a whole month: column index + 1 === day-of-month, for every day ----
for (const [month, len] of [["2026-09", 30], ["2026-02", 28], ["2024-02", 29], ["2026-12", 31]]) {
  const dates = enumerateDates(`${month}-01`, `${month}-${String(len).padStart(2, "0")}`);
  assert.strictEqual(dates.length, len, `${month} produced ${dates.length} columns, expected ${len}`);
  dates.forEach((d, idx) => {
    assert.strictEqual(d.slice(0, 7), month, `${d} is outside ${month}`);
    assert.strictEqual(
      Number(d.slice(8, 10)), idx + 1,
      `${month}: column ${idx} is day ${d.slice(8, 10)} — the viewer's \`\${i + 1}|shift\` key would read the wrong cell`,
    );
  });
}

// ---- 2. across a month boundary: contiguous, unique, and NOT day-of-month ----
const span = enumerateDates("2026-07-20", "2026-08-10");
assert.strictEqual(span.length, 22);                       // 12 of July + 10 of August
assert.strictEqual(span[0], "2026-07-20");
assert.strictEqual(span[11], "2026-07-31");
assert.strictEqual(span[12], "2026-08-01");
assert.strictEqual(span[21], "2026-08-10");
assert.strictEqual(new Set(span).size, span.length, "dates repeat");
// THE COLLISION THE OLD KEY HAD, shown on a span that actually contains one:
// 20 July and 20 August are both labelled "20" and were both key 20. As columns
// they are 0 and 31, and a mark on either no longer overwrites the other.
const wide = enumerateDates("2026-07-20", "2026-08-25");
const twentieths = wide.map((d, idx) => [d, idx]).filter(([d]) => d.slice(8, 10) === "20");
assert.strictEqual(twentieths.length, 2, "expected two 20ths in 20 Jul – 25 Aug");
assert.deepStrictEqual(twentieths.map(([, idx]) => idx), [0, 31]);

// ---- 3. degenerate windows ----
assert.deepStrictEqual(enumerateDates("2026-09-05", "2026-09-05"), ["2026-09-05"]);
assert.deepStrictEqual(enumerateDates("2026-09-06", "2026-09-05"), []);

// ---- 4. a DST-shifted month still yields one column per calendar day. The
//         loop steps with setDate, which is calendar-correct; stepping by
//         86_400_000 ms would drop or double a day in a zone that shifts.
const dst = enumerateDates("2026-03-01", "2026-03-31");
assert.strictEqual(dst.length, 31);
assert.strictEqual(new Set(dst).size, 31);

console.log("attendance window / column indexing: all checks passed");
