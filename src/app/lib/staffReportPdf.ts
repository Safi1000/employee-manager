import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { brandingFromCompany } from "./pdfBranding";
import type { Company } from "./supabase";
import { INK, LH, M, Page, RED, SOFT, W, footer, heading, letterhead, refOf, signOff } from "./dailyBriefPdf";

/**
 * STAFF REPORT (Shayan, 6 Nov 2026) — the Daily / Attendance report's letter
 * style, for the people on the books: client by client, who is there, what is
 * missing from each record and what needs attention first (an expired CNIC
 * before a missing date of birth).
 *
 * Every line reads the employee record or its document checklist; nothing is
 * inferred. A blank field is reported as missing, never guessed.
 */
export type StaffRecord = {
  id: string;
  name: string;
  code: string;
  group: string;            // client name, or "Office staff" / "Relievers" / "Not posted"
  designation: string | null;
  joinDate: string | null;
  phone: string | null;
  cnic: string | null;
  cnicExpiry: string | null;
  dob: string | null;
  emergencyPhone: string | null;
  hasBank: boolean;
  cashPaid: boolean;
  policeVerification: string | null;
  nadraVerisys: string | null;
  guardLicenceExpiry: string | null;
  weaponLicenceExpiry: string | null;
  medicalExpiry: string | null;
  weaponsCertExpiry: string | null;
  probationEnd: string | null;
  pendingTerminationReview: boolean;
  /** Document checklist: doc_type → on file? Missing key = no checklist row. */
  docs: Record<string, boolean> | null;
};

type Issue = { text: string; level: "critical" | "attention" | "missing" };

const KEY_DOCS: [string, string][] = [["cnic_copy", "CNIC copy"], ["photograph", "photograph"], ["police_verification", "police verification letter"], ["medical_certificate", "medical certificate"]];
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function issuesOf(r: StaffRecord, todayIso: string): Issue[] {
  const out: Issue[] = [];
  const soon = new Date(`${todayIso}T00:00:00`); soon.setDate(soon.getDate() + 30);
  const soonIso = soon.toISOString().slice(0, 10);
  const expiry = (label: string, iso: string | null) => {
    if (!iso) return;
    if (iso < todayIso) out.push({ level: "critical", text: `${label} expired ${day(iso)}` });
    else if (iso <= soonIso) out.push({ level: "attention", text: `${label} expires ${day(iso)}` });
  };
  if (!r.cnic) out.push({ level: "critical", text: "no CNIC number" });
  expiry("CNIC", r.cnicExpiry);
  expiry("guard service licence", r.guardLicenceExpiry);
  expiry("weapon licence", r.weaponLicenceExpiry);
  expiry("medical fitness", r.medicalExpiry);
  expiry("weapons certification", r.weaponsCertExpiry);
  if (r.pendingTerminationReview) out.push({ level: "critical", text: "termination review pending" });
  if (r.policeVerification !== "cleared") out.push({ level: "attention", text: "police verification pending" });
  if (r.nadraVerisys !== "cleared") out.push({ level: "attention", text: "NADRA Verisys pending" });
  if (!r.hasBank && !r.cashPaid) out.push({ level: "attention", text: "no bank details" });
  if (r.probationEnd && r.probationEnd >= todayIso && r.probationEnd <= soonIso) out.push({ level: "attention", text: `probation ends ${day(r.probationEnd)}` });
  if (r.docs) {
    const miss = KEY_DOCS.filter(([k]) => r.docs![k] === false).map(([, l]) => l);
    if (miss.length) out.push({ level: "missing", text: `documents missing: ${miss.join(", ")}` });
  } else out.push({ level: "missing", text: "no document checklist" });
  if (!r.phone) out.push({ level: "missing", text: "no phone" });
  if (!r.emergencyPhone) out.push({ level: "missing", text: "no emergency contact" });
  if (!r.cnicExpiry && r.cnic) out.push({ level: "missing", text: "no CNIC expiry date" });
  if (!r.dob) out.push({ level: "missing", text: "no date of birth" });
  if (!r.joinDate) out.push({ level: "missing", text: "no joining date" });
  return out;
}

export function generateStaffReportPdf(o: {
  company: Company | null | undefined;
  records: StaffRecord[];
  contracted: Map<string, number>;   // group name → contracted guards
  regionLabel: string | null;
  extractedBy: string;
}) {
  const b = brandingFromCompany(o.company);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const p = new Page(doc, b);
  const today = new Date().toISOString().slice(0, 10);
  const ref = refOf("SFR", today);
  letterhead(p, "Staff Report", today, o.regionLabel, ref, "Human Resources");

  const para = (t: string, color = INK, style: "normal" | "bold" | "italic" = "normal", size = 10.5, indent = 0) => {
    p.font(style, size); p.color(color);
    p.wrap(t, W - indent).forEach((ln) => { p.need(LH); doc.text(ln, M + indent, p.y); p.y += LH; });
  };

  const withIssues = o.records.map((r) => ({ r, issues: issuesOf(r, today) }));
  const groups = new Map<string, typeof withIssues>();
  for (const x of withIssues) groups.set(x.r.group, [...(groups.get(x.r.group) ?? []), x]);
  const order = [...groups.keys()].sort((a, b) => {
    const rank = (g: string) => (g === "Office staff" ? 2 : g === "Relievers" ? 3 : g === "Not posted" ? 4 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const complete = withIssues.filter((x) => !x.issues.length).length;
  const clientsN = order.filter((g) => !["Office staff", "Relievers", "Not posted"].includes(g)).length;

  para(`${o.records.length} active employees across ${clientsN} client${clientsN === 1 ? "" : "s"}${groups.has("Office staff") ? `, ${groups.get("Office staff")!.length} office staff` : ""}${groups.has("Relievers") ? `, ${groups.get("Relievers")!.length} relievers` : ""}. ${complete} record${complete === 1 ? " is" : "s are"} complete with nothing outstanding; ${o.records.length - complete} need attention or have something missing.`);
  p.y += 3;

  // ── 1. Matters requiring attention ─────────────────────────────────────
  heading(p, "1. Matters requiring attention");
  const tally = new Map<string, { level: Issue["level"]; who: string[] }>();
  const keyOf = (t: string) => t.replace(/ expired \d.*$/, " expired").replace(/ expires \d.*$/, " expires within 30 days").replace(/^probation ends .*/, "probation ends within 30 days");
  for (const x of withIssues) for (const i of x.issues) {
    if (i.level === "missing") continue;
    const k = keyOf(i.text);
    const cur = tally.get(k) ?? { level: i.level, who: [] };
    cur.who.push(`${x.r.name} (${x.r.code}${x.r.group ? `, ${x.r.group}` : ""})`);
    tally.set(k, cur);
  }
  const ordered = [...tally].sort((a, b) => (a[1].level === b[1].level ? b[1].who.length - a[1].who.length : a[1].level === "critical" ? -1 : 1));
  if (!ordered.length) para("Nothing requires attention.", SOFT, "italic");
  ordered.forEach(([k, v], i) => {
    const label = k.charAt(0).toUpperCase() + k.slice(1);
    p.font("bold", 10.5); p.color(v.level === "critical" ? RED : INK);
    p.need(LH); doc.text(`${i + 1}.`, M + 2, p.y);
    p.wrap(`${label} — ${v.who.length}`, W - 10).forEach((ln) => { p.need(LH); doc.text(ln, M + 10, p.y); p.y += LH; });
    const names = v.who.length > 18 ? [...v.who.slice(0, 18), `and ${v.who.length - 18} more (listed under each client below)`] : v.who;
    para(names.join("; ") + ".", SOFT, "normal", 9.5, 10);
    p.y += 1.5;
  });
  p.y += 3;

  // ── 2. Summary by client ────────────────────────────────────────────────
  heading(p, "2. Summary by client");
  order.forEach((g, i) => {
    const xs = groups.get(g)!;
    const c = o.contracted.get(g);
    const crit = xs.filter((x) => x.issues.some((y) => y.level === "critical")).length;
    const miss = xs.filter((x) => x.issues.some((y) => y.level === "missing")).length;
    p.font("bold", 10.5); p.color(INK); p.need(LH);
    doc.text(`${i + 1}.`, M + 2, p.y);
    doc.text(g, M + 10, p.y);
    p.font("normal", 10.5);
    doc.text(`${xs.length}${c ? ` of ${c} contracted` : ""} · ${xs.filter((x) => !x.issues.length).length} complete`, M + W, p.y, { align: "right" });
    p.y += LH;
    const bits = [crit ? `${crit} with an expired or missing ID / licence or review pending` : "", miss ? `${miss} with data or documents missing` : ""].filter(Boolean);
    if (c && xs.length < c) bits.unshift(`${c - xs.length} short of the contract`);
    if (c && xs.length > c) bits.unshift(`${xs.length - c} over the contract`);
    if (bits.length) para(bits.join("; ") + ".", crit ? RED : SOFT, "normal", 9.5, 10);
  });
  p.y += 3;

  // ── 3. Client-wise detail ───────────────────────────────────────────────
  heading(p, "3. Client-wise detail");
  order.forEach((g, gi) => {
    const xs = groups.get(g)!.slice().sort((a, b) => b.issues.filter((i) => i.level === "critical").length - a.issues.filter((i) => i.level === "critical").length || a.r.name.localeCompare(b.r.name));
    const c = o.contracted.get(g);
    p.need(LH * 4);
    p.y += 2;
    p.font("bold", 11); p.color(INK);
    doc.text(`3.${gi + 1}  ${g} — ${xs.length} ${xs.length === 1 ? "person" : "people"}${c ? ` (contracted ${c})` : ""}`, M, p.y);
    p.y += LH + 0.5;
    // What is missing across the group, by field — the to-do list for whoever fills records in.
    const counts = new Map<string, number>();
    for (const x of xs) for (const i of x.issues) if (i.level === "missing") {
      for (const part of i.text.replace(/^documents missing: /, "").split(", ")) {
        const k = i.text.startsWith("documents missing") ? `${part}` : part.replace(/^no /, "");
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    if (counts.size) para(`Missing: ${[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ")}`, SOFT, "italic", 9.5);
    p.y += 1;
    xs.forEach((x, i) => {
      const r = x.r;
      const facts = [r.designation, r.joinDate ? `joined ${day(r.joinDate)}` : null, r.cnic ? `CNIC ${r.cnic}` : null, r.phone].filter(Boolean).join(" · ");
      p.need(LH * 2);
      p.font("bold", 10); p.color(INK);
      doc.text(`${i + 1}.`, M + 2, p.y);
      const label = `${r.name}  (${r.code})`;
      doc.text(label, M + 10, p.y);
      const w = doc.getTextWidth(label);   // measured in the bold 10 it was drawn in
      p.font("normal", 9); p.color(SOFT);
      if (facts) doc.text(p.wrap(facts, W - 14 - w)[0] ?? "", M + 10 + w + 3, p.y);
      p.y += LH - 0.4;
      const urgent = x.issues.filter((y) => y.level !== "missing");
      const missing = x.issues.filter((y) => y.level === "missing");
      if (urgent.length) para(urgent.map((y) => y.text).join("; "), urgent.some((y) => y.level === "critical") ? RED : INK, "normal", 9, 10);
      if (missing.length) para(missing.map((y) => y.text).join("; "), SOFT, "italic", 9, 10);
      if (!x.issues.length) para("Record complete.", SOFT, "italic", 9, 10);
      p.y += 0.8;
    });
  });

  const by = o.extractedBy.trim();
  p.extractedBy = "";
  signOff(p, "Extracted by", by ? [by] : []);
  footer(doc, b, ref);
  void savePdf(doc, `Staff report${o.regionLabel ? ` ${o.regionLabel}` : ""} ${today}.pdf`);
}
