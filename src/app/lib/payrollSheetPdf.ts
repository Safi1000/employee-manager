import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { drawBrandedHeader, drawBrandedFooter, hexToRgb, type PdfBranding } from "./pdfBranding";
import type { PayrollExportRow } from "./excel";

/**
 * SALARY SHEETS (2026-10-26). The page a supervisor carries to a site: every
 * guard, what he is owed, and a box he signs (or thumbs) when the cash is put
 * in his hand — then the page comes back to the office as the receipt.
 *
 * Salaries already paid from the office (bank, cheque, card) are printed as
 * PAID with no box: nobody at the site hands them anything.
 *
 *   "site"   — per client: a summary page, then one page (or more) per site,
 *              each with its own total and its own hand-over block, so a site's
 *              page can travel alone.
 *   "client" — per client: one list, site shown on each row, one total.
 *
 * Every figure is the payroll row's own; nothing is recomputed here.
 */

export type SheetClient = { name: string; rows: PayrollExportRow[] };
export type SheetMode = "site" | "client";

const L = 12, R = 198, W = R - L;
const money = (n: number) => Math.round(Number(n || 0)).toLocaleString();
const deductionsOf = (r: PayrollExportRow) => r.advance + r.eobi + r.incomeTax + r.deductions;
const paidFromOffice = (r: PayrollExportRow) =>
  r.status === "Disbursed" && /^(bank|cheque|card)$/i.test(r.paymentMode || "");
const NO_SITE = "No site";

type Col = { key: string; title: string; w: number; align?: "right" | "center" };

export function generatePayrollSheetsPdf(o: {
  branding: PdfBranding; monthLabel: string; clients: SheetClient[]; mode: SheetMode;
}) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const [br, bg, bb] = hexToRgb(o.branding.brandColor);
  let y = 0;
  let first = true;

  const newPage = (title: string, subtitle: string) => {
    if (!first) doc.addPage();
    first = false;
    y = drawBrandedHeader(doc, o.branding, title, subtitle) + 4;
  };

  const cols = (withSite: boolean): Col[] => [
    { key: "n", title: "#", w: 7, align: "center" },
    { key: "code", title: "Code", w: 19 },
    { key: "name", title: "Name", w: withSite ? 34 : 50 },
    ...(withSite ? [{ key: "site", title: "Site", w: 30 } as Col] : []),
    { key: "days", title: "P / L / A", w: 17, align: "center" },
    { key: "gross", title: "Gross", w: 18, align: "right" },
    { key: "ded", title: "Deduct.", w: 16, align: "right" },
    { key: "net", title: "Net pay", w: 20, align: "right" },
    { key: "sign", title: "Signature / thumb", w: 0 },
  ];
  const layout = (c: Col[]) => {
    const fixed = c.reduce((n, x) => n + x.w, 0);
    return c.map((x) => (x.key === "sign" ? { ...x, w: W - fixed } : x));
  };

  const header = (c: Col[]) => {
    doc.setFillColor(br, bg, bb);
    doc.rect(L, y, W, 7, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(255, 255, 255);
    let x = L;
    for (const col of c) {
      const tx = col.align === "right" ? x + col.w - 1.5 : col.align === "center" ? x + col.w / 2 : x + 1.5;
      doc.text(col.title, tx, y + 4.7, { align: col.align ?? "left" });
      x += col.w;
    }
    y += 7;
  };

  const row = (c: Col[], r: PayrollExportRow, i: number, title: string, subtitle: string) => {
    const h = 9.5;
    if (y + h > 262) { newPage(title, subtitle + " (continued)"); header(c); }
    if (i % 2 === 1) { doc.setFillColor(246, 248, 251); doc.rect(L, y, W, h, "F"); }
    doc.setDrawColor(226, 232, 240); doc.line(L, y + h, R, y + h);
    const office = paidFromOffice(r);
    const vals: Record<string, string> = {
      n: String(i + 1), code: r.employeeCode || r.guardCode, name: r.name, site: r.site || NO_SITE,
      days: r.hasPayslip ? `${r.presentDays} / ${r.leaveDays} / ${r.absentDays}` : "—",
      gross: r.hasPayslip ? money(r.finalSalary) : "—",
      ded: r.hasPayslip && deductionsOf(r) ? money(deductionsOf(r)) : "",
      net: r.hasPayslip ? money(r.netSalary) : "not run",
    };
    let x = L;
    for (const col of c) {
      if (col.key === "sign") {
        if (office) {
          doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(21, 128, 61);
          doc.text(`PAID · ${r.paymentMode.toUpperCase()}`, x + 2, y + 6);
        } else {
          doc.setDrawColor(203, 213, 225); doc.rect(x + 1.5, y + 1.3, col.w - 3, h - 2.6);
        }
      } else {
        const bold = col.key === "net" || col.key === "name";
        doc.setFont("helvetica", bold ? "bold" : "normal");
        doc.setFontSize(col.key === "name" ? 8.5 : 8);
        doc.setTextColor(col.key === "code" || col.key === "site" ? 100 : 15, col.key === "code" || col.key === "site" ? 116 : 23, col.key === "code" || col.key === "site" ? 139 : 42);
        let v = vals[col.key] ?? "";
        while (v.length > 2 && doc.getTextWidth(v) > col.w - 3) v = v.slice(0, -2) + "…";
        const tx = col.align === "right" ? x + col.w - 1.5 : col.align === "center" ? x + col.w / 2 : x + 1.5;
        doc.text(v, tx, y + 6, { align: col.align ?? "left" });
      }
      x += col.w;
    }
    y += h;
  };

  const totals = (rows: PayrollExportRow[], label: string) => {
    const net = rows.reduce((n, r) => n + r.netSalary, 0);
    const office = rows.filter(paidFromOffice).reduce((n, r) => n + r.netSalary, 0);
    if (y + 20 > 270) { doc.addPage(); y = 20; }
    y += 2;
    doc.setFillColor(241, 245, 249); doc.rect(L, y, W, 15, "F");
    const cell = (k: string, v: string, x: number, strong = false) => {
      doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(100, 116, 139); doc.text(k.toUpperCase(), x, y + 5);
      doc.setFont("helvetica", "bold"); doc.setFontSize(strong ? 12 : 10);
      if (strong) doc.setTextColor(br, bg, bb); else doc.setTextColor(15, 23, 42);
      doc.text(v, x, y + 11.5);
    };
    cell(label, `${rows.length} ${rows.length === 1 ? "guard" : "guards"}`, L + 4);
    cell("Net payable", `PKR ${money(net)}`, L + 44);
    cell("Paid from office", `PKR ${money(office)}`, L + 94);
    cell("Cash to hand over", `PKR ${money(net - office)}`, L + 142, true);
    y += 19;
  };

  const handover = () => {
    if (y + 24 > 278) { doc.addPage(); y = 20; }
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(71, 85, 105);
    const line = (label: string, x: number, w: number) => {
      doc.text(label, x, y);
      doc.setDrawColor(148, 163, 184); doc.line(x, y + 7, x + w, y + 7);
    };
    line("Cash handed over by (name & signature)", L, 84);
    line("Date", L + 92, 30);
    line("Received back & checked by (office)", L + 130, W - 130);
    y += 14;
    doc.setFontSize(7); doc.setTextColor(148, 163, 184);
    doc.text("Each guard signs or puts his thumb impression only when the cash is in his hand. Return this page to the office.", L, y);
    y += 6;
  };

  const sorted = (rows: PayrollExportRow[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name));

  for (const cl of o.clients) {
    if (!cl.rows.length) continue;
    const bySite = new Map<string, PayrollExportRow[]>();
    for (const r of cl.rows) { const k = r.site || NO_SITE; bySite.set(k, [...(bySite.get(k) ?? []), r]); }
    const sites = [...bySite.keys()].sort((a, b) => (a === NO_SITE ? 1 : b === NO_SITE ? -1 : a.localeCompare(b)));

    if (o.mode === "client" || sites.length === 1) {
      const title = "Salary sheet";
      const sub = `${cl.name}  ·  ${o.monthLabel}${sites.length === 1 && sites[0] !== NO_SITE ? `  ·  ${sites[0]}` : ""}`;
      newPage(title, sub);
      const c = layout(cols(sites.length > 1));
      header(c);
      sorted(cl.rows).sort((a, b) => (a.site || NO_SITE).localeCompare(b.site || NO_SITE)).forEach((r, i) => row(c, r, i, title, sub));
      totals(cl.rows, cl.name);
      handover();
      continue;
    }

    // Summary: one line per site.
    newPage("Salary sheets — summary", `${cl.name}  ·  ${o.monthLabel}  ·  ${sites.length} sites`);
    const sc: Col[] = [
      { key: "site", title: "Site", w: 70 }, { key: "n", title: "Guards", w: 22, align: "right" },
      { key: "net", title: "Net payable", w: 32, align: "right" }, { key: "office", title: "Paid from office", w: 32, align: "right" },
      { key: "cash", title: "Cash to hand over", w: W - 156, align: "right" },
    ];
    header(sc);
    sites.forEach((s, i) => {
      const rs = bySite.get(s)!;
      const net = rs.reduce((n, r) => n + r.netSalary, 0);
      const office = rs.filter(paidFromOffice).reduce((n, r) => n + r.netSalary, 0);
      if (i % 2 === 1) { doc.setFillColor(246, 248, 251); doc.rect(L, y, W, 8, "F"); }
      const v: Record<string, string> = { site: s, n: String(rs.length), net: money(net), office: money(office), cash: money(net - office) };
      let x = L;
      for (const col of sc) {
        doc.setFont("helvetica", col.key === "cash" ? "bold" : "normal"); doc.setFontSize(8.5); doc.setTextColor(15, 23, 42);
        const tx = col.align === "right" ? x + col.w - 1.5 : x + 1.5;
        doc.text(v[col.key], tx, y + 5.5, { align: col.align ?? "left" });
        x += col.w;
      }
      y += 8;
    });
    totals(cl.rows, "Whole client");

    // One page per site.
    for (const s of sites) {
      const title = "Salary sheet";
      const sub = `${cl.name}  ·  ${s}  ·  ${o.monthLabel}`;
      newPage(title, sub);
      const c = layout(cols(false));
      header(c);
      sorted(bySite.get(s)!).forEach((r, i) => row(c, r, i, title, sub));
      totals(bySite.get(s)!, s);
      handover();
    }
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    drawBrandedFooter(doc, o.branding, `Salary sheet · ${o.monthLabel} · page ${p} of ${pages}`);
  }
  const who = o.clients.filter((c) => c.rows.length).length === 1 ? o.clients.find((c) => c.rows.length)!.name : "Payroll";
  void savePdf(doc, `${who} salary sheets ${o.monthLabel}${o.mode === "site" ? " (by site)" : ""}.pdf`);
}
