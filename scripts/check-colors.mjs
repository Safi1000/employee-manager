#!/usr/bin/env node
// One colour system (2026-10-21). Every screen reads the theme's named
// colours (bg-card, text-foreground, border-border, brand/success/danger/
// warning/info, and the fixed tones in theme.css: ink, up, down, heed…).
//
// This fails the build on the shapes that bypass the theme, so the sweep that
// removed ~5,000 of them cannot quietly come undone:
//   - stock neutrals:  slate-*, gray-*, zinc-*, neutral-*, stone-*, bg-white
//   - stock accents:   blue-*, indigo-*, emerald-*, amber-*, red-* … (the
//                      theme's names for those are brand/success/danger/…)
//   - raw hex in a class: text-[#…], bg-[#…]
//   - accent shades the theme does not define (300, 400, 800, 900, 950),
//     which render with no colour at all
//
// Colours inside theme.css, and hex strings handed to charts, PDFs and
// exports (which cannot read CSS variables), are outside its reach on purpose.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const STOCK = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTIL = "text|bg|border|border-[trblxy]|divide|ring|ring-offset|outline|from|via|to|fill|stroke|placeholder|accent|caret|decoration|shadow";
const RULES = [
  { what: "stock Tailwind colour", re: new RegExp(`(?<![\\w-])(?:[a-z-]+:)*(?:${UTIL})-(?:${STOCK})-\\d{2,3}\\b`, "g") },
  { what: "bg-white (use bg-card)", re: /(?<![\w-])(?:[a-z-]+:)*bg-white\b/g },
  { what: "raw hex in a class", re: /(?<![\w-])(?:[a-z-]+:)*[a-z-]+-\[#[0-9a-fA-F]{3,8}\]/g },
  { what: "double opacity suffix", re: /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|divide|ring)-[a-z-]+\/\d+\/\d+/g },
  { what: "undefined accent shade", re: /(?<![\w-])(?:[a-z-]+:)*[a-z-]+-(?:brand|success|danger|warning|info)-(?:300|400|800|900|950)\b/g },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx|ts|jsx|js)$/.test(name)) yield p;
  }
}

const hits = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const r of RULES) for (const m of line.matchAll(r.re)) hits.push(`${relative(process.cwd(), file)}:${i + 1}  ${m[0]}  (${r.what})`);
  });
}

if (hits.length) {
  console.error(`check-colors: ${hits.length} colour(s) outside the theme:\n`);
  for (const h of hits.slice(0, 60)) console.error("  " + h);
  if (hits.length > 60) console.error(`  … and ${hits.length - 60} more`);
  console.error("\nUse the theme's names instead — see the header of scripts/check-colors.mjs.");
  process.exit(1);
}
console.log("check-colors: every colour reads the theme.");
