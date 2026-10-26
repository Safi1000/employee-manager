import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { drawBrandedHeader, drawBrandedFooter, type PdfBranding } from "./pdfBranding";

/**
 * Partnership PDFs (2026-10-26): one partner's statement for a month, and the
 * whole month's report. Every figure is the posted run's own, as returned by
 * partnership_month_view — nothing is recomputed here.
 */

export type PartnerLine = { client: string | null; net: number; pct: number; share: number };
export type PartnerStatement = {
  name: string; kind: "equity" | "regional"; region: string | null; pct: number | null; amount: number;
  clients: PartnerLine[]; equity_regions: { region: string | null; amount: number; pct: number | null }[];
  drawings_month: number; closing_balance: number;
};
export type RegionRow = {
  region: string | null; own_profit: number; ho_allocated: number; base: number; regional: number; to_equity: number;
  regional_partners: { name: string; pct: number }[]; outside: boolean; declared: number | null;
};
export type ClientRow = { client: string; region: string | null; revenue: number; cost: number; overhead: number; net: number };

const acct = (n: number) => { const v = Math.round(Number(n || 0)); return v < 0 ? `(${Math.abs(v).toLocaleString()})` : v.toLocaleString(); };

function lines(doc: jsPDF) {
  let y = 0;
  const set = (v: number) => { y = v; };
  const need = (h: number) => { if (y + h > 280) { doc.addPage(); y = 20; } };
  const section = (t: string) => { need(14); y += 4; doc.setDrawColor(220); doc.line(14, y, 196, y); y += 6; doc.setFontSize(9); doc.setTextColor(110); doc.text(t.toUpperCase(), 14, y); y += 6; };
  const row = (label: string, value: string, opts: { bold?: boolean; sub?: string; indent?: number } = {}) => {
    need(7);
    doc.setFontSize(opts.bold ? 11 : 10); doc.setTextColor(opts.bold ? 0 : 40);
    doc.text(label, 14 + (opts.indent ?? 0), y);
    if (opts.sub) { doc.setFontSize(8); doc.setTextColor(130); doc.text(opts.sub, 14 + (opts.indent ?? 0) + doc.getTextWidth(label) + 3, y); }
    doc.setFontSize(opts.bold ? 11 : 10); doc.setTextColor(0); doc.text(value, 196, y, { align: "right" });
    y += opts.bold ? 7 : 6;
  };
  return { get y() { return y; }, set, section, row };
}

function statementBody(doc: jsPDF, L: ReturnType<typeof lines>, p: PartnerStatement) {
  if (p.kind === "regional") {
    L.section(`Regional share · ${p.region ?? ""} · ${p.pct ?? ""}%`);
    for (const c of p.clients) L.row(c.client ?? "Client", acct(c.share), { sub: `${c.pct}% of ${acct(c.net)}` });
    const sum = p.clients.reduce((n, c) => n + Number(c.share), 0);
    L.row("Head office and region adjustments", acct(p.amount - sum));
  } else {
    L.section(`Equity share · ${p.pct ?? ""}% of what each region leaves`);
    for (const e of p.equity_regions) L.row(e.region ?? "—", acct(e.amount));
  }
  L.row("Share this month", acct(p.amount), { bold: true });
  L.section("Account");
  L.row("Drawn this month (cash, fuel, transfers)", acct(-p.drawings_month));
  L.row("Closing balance", acct(p.closing_balance), { bold: true });
}

export function generatePartnerStatementPdf(o: { branding: PdfBranding; monthLabel: string; status: string; partner: PartnerStatement }) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const L = lines(doc);
  L.set(drawBrandedHeader(doc, o.branding, "Partner statement", `${o.monthLabel}  ·  ${o.partner.name}`) + 8);
  doc.setFontSize(9); doc.setTextColor(110); doc.text(o.status, 14, L.y); L.set(L.y + 4);
  statementBody(doc, L, o.partner);
  drawBrandedFooter(doc, o.branding, "System-generated from the partnership run as posted.");
  void savePdf(doc, `Partner statement ${o.monthLabel} — ${o.partner.name}.pdf`);
}

export function generatePartnershipMonthPdf(o: {
  branding: PdfBranding; monthLabel: string; status: string; total: number | null;
  partners: PartnerStatement[]; regions: RegionRow[]; clients: ClientRow[];
}) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const L = lines(doc);
  L.set(drawBrandedHeader(doc, o.branding, "Partnership", `${o.monthLabel}${o.total != null ? `  ·  profit divided ${acct(o.total)}` : ""}`) + 8);
  doc.setFontSize(9); doc.setTextColor(110); doc.text(o.status, 14, L.y); L.set(L.y + 4);

  L.section("Who gets what");
  for (const p of o.partners) L.row(p.name, acct(p.amount), { sub: p.kind === "regional" ? `regional · ${p.region ?? ""} ${p.pct ?? ""}%` : `equity ${p.pct ?? ""}%` });

  L.section("Where the profit came from");
  for (const r of o.regions) {
    L.row(r.region ?? "—", acct(r.own_profit), { bold: true, sub: r.outside ? `outside the partnership${r.declared != null ? ` · declared ${acct(r.declared)}` : ""}` : undefined });
    if (r.ho_allocated) L.row("Head office", acct(r.ho_allocated), { indent: 4 });
    if (r.regional) L.row(`Regional partner (${r.regional_partners.map((x) => `${x.name} ${x.pct}%`).join(", ")})`, acct(-r.regional), { indent: 4 });
    L.row("To equity", acct(r.to_equity), { indent: 4 });
    for (const c of o.clients.filter((x) => x.region === r.region)) {
      L.row(c.client, acct(c.net), { indent: 8, sub: `${acct(c.revenue)} − ${acct(c.cost)} − ${acct(c.overhead)}` });
    }
  }

  for (const p of o.partners) { doc.addPage(); L.set(20); doc.setFontSize(13); doc.setTextColor(0); doc.text(p.name, 14, L.y); L.set(L.y + 4); statementBody(doc, L, p); }
  drawBrandedFooter(doc, o.branding, "System-generated from the partnership run as posted.");
  void savePdf(doc, `Partnership ${o.monthLabel}.pdf`);
}

export type LedgerLine = { entry_date: string; particulars: string; cash_paid: number; remuneration: number; balance: number };

/** A partner's account over a range, line by line, as partner_ledger gives it. */
export function generatePartnerLedgerPdf(o: {
  branding: PdfBranding; partnerName: string; rangeLabel: string; opening: number; rows: LedgerLine[]; closing: number;
}) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = drawBrandedHeader(doc, o.branding, "Partner account", `${o.partnerName}  ·  ${o.rangeLabel}`) + 6;
  const head = () => {
    doc.setFillColor(241, 245, 249); doc.rect(14, y - 4.5, 182, 7, "F");
    doc.setFontSize(8); doc.setTextColor(100);
    doc.text("Date", 16, y); doc.text("Particulars", 38, y);
    doc.text("Paid / drawn", 140, y, { align: "right" }); doc.text("Profit share", 168, y, { align: "right" }); doc.text("Balance", 194, y, { align: "right" });
    y += 7;
  };
  head();
  doc.setFontSize(9); doc.setTextColor(40);
  doc.text("Opening balance", 38, y); doc.text(acct(o.opening), 194, y, { align: "right" }); y += 6;
  for (const r of o.rows) {
    if (y > 278) { doc.addPage(); y = 20; head(); doc.setFontSize(9); doc.setTextColor(40); }
    let p = r.particulars ?? "";
    while (p.length > 3 && doc.getTextWidth(p) > 82) p = p.slice(0, -2);
    if (p !== (r.particulars ?? "")) p += "…";
    doc.text(r.entry_date, 16, y); doc.text(p, 38, y);
    if (Number(r.cash_paid)) doc.text(acct(r.cash_paid), 140, y, { align: "right" });
    if (Number(r.remuneration)) doc.text(acct(r.remuneration), 168, y, { align: "right" });
    doc.text(acct(r.balance), 194, y, { align: "right" });
    y += 5.5;
  }
  y += 2; doc.setDrawColor(200); doc.line(14, y, 196, y); y += 6;
  doc.setFontSize(11); doc.setTextColor(0); doc.text("Closing balance", 38, y); doc.text(acct(o.closing), 194, y, { align: "right" });
  drawBrandedFooter(doc, o.branding, "System-generated from the partner ledger.");
  void savePdf(doc, `${o.partnerName} account ${o.rangeLabel}.pdf`);
}
