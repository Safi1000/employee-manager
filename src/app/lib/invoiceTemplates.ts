import jsPDF from "jspdf";
import {
  amountInWords,
  CONTRACT_LINE_CATEGORY_LABEL,
  DEFAULT_INVOICE_SETTINGS,
  type Client,
  type Company,
  type Contract,
  type ContractLine,
  type ContractLineCategory,
  type Invoice,
  type InvoiceLine,
  type InvoiceTax,
  type TaxLine,
} from "./supabase";

/**
 * The three per-company invoice PDF templates (Fixed / SLA / Variable), chosen
 * automatically by the client's invoice_group. Layout follows the company's
 * real invoice designs; everything visual — logo, legal name, registration
 * line, footer, signature label, stamp, watermark — comes from the company's
 * Invoice Structure settings. Nothing is hardcoded.
 *
 * jsPDF hand-drawing (no autotable). Logos/stamps are base64 data URLs.
 *
 * Degradation: SLA cost columns read contract_lines.cost_components (salary,
 * total_expenses, admin_cost); where absent they fall back to unit_rate × count
 * with zero admin cost. Variable quantities use verified attendance when the
 * caller supplies it, else committed counts.
 */

export type InvoiceDocInput = {
  invoice: Invoice;
  client: Client | null;
  company: Company | null;
  contract?: Contract | null;
  contractLines?: ContractLine[];
  invoiceLines?: InvoiceLine[];
  taxes?: InvoiceTax[];
  attendanceByCategory?: Partial<Record<ContractLineCategory, number>>;
  save?: boolean; // default true
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MON_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const intFmt = (n: number) => Math.round(Number(n ?? 0)).toLocaleString("en-US");
const fixedMoney = (n: number) => `${intFmt(n)}/-`;

function ordSuffix(d: number): string {
  const v = d % 100;
  if (v >= 11 && v <= 13) return "th";
  return ["th", "st", "nd", "rd"][d % 10] || "th";
}
function parts(iso: string | null | undefined): [number, number, number] {
  const [y, m, d] = (iso ?? "").slice(0, 10).split("-").map(Number);
  return [y || 0, m || 0, d || 0];
}
function ordinalDate(iso: string | null | undefined): string {
  const [y, m, d] = parts(iso);
  if (!y) return "";
  return `${String(d).padStart(2, "0")}${ordSuffix(d)} ${MONTHS[m - 1]} ${y}`;
}
function shortDate(iso: string | null | undefined): string {
  const [y, m, d] = parts(iso);
  if (!y) return "";
  return `${d}${ordSuffix(d)} ${MON_SHORT[m - 1]} ${String(y).slice(2)}`;
}
function longDate(iso: string | null | undefined): string {
  const [y, m, d] = parts(iso);
  if (!y) return "";
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`;
}
function titleMonthYear(inv: Invoice): string {
  const [y, m] = parts(inv.invoice_date ?? inv.period_start);
  if (!y) return "";
  return `${MONTHS[m - 1].toUpperCase()} ${y}`;
}
function periodRange(inv: Invoice): string {
  const s = inv.period_start ?? inv.invoice_date;
  const e = inv.period_end ?? inv.period_start ?? inv.invoice_date;
  return `${ordinalDate(s)} to ${ordinalDate(e)}`;
}
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join("");
}
function imageFormat(dataUrl: string): "PNG" | "JPEG" | "WEBP" | null {
  const m = /^data:image\/(png|jpe?g|webp)/i.exec(dataUrl);
  if (!m) return null;
  const t = m[1].toLowerCase();
  return t === "png" ? "PNG" : t === "webp" ? "WEBP" : "JPEG";
}

type Ctx = {
  doc: jsPDF;
  pageW: number;
  pageH: number;
  margin: number;
  invoice: Invoice;
  client: Client | null;
  company: Company | null;
  settings: ReturnType<typeof mergeSettings>;
};

const mergeSettings = (company: Company | null) => ({
  ...DEFAULT_INVOICE_SETTINGS,
  ...(company?.invoice_settings ?? {}),
});

const legalNameOf = (c: Company | null) => c?.legal_name || c?.name || "Company";

// ── Faint centered watermark (company initials) ──
function drawWatermark(ctx: Ctx): void {
  const { doc, pageW, pageH, company } = ctx;
  const initials = initialsOf(legalNameOf(company));
  if (!initials) return;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(150);
  doc.setTextColor(238, 236, 231);
  doc.text(initials, pageW / 2, pageH / 2, { align: "center", baseline: "middle" });
  doc.setTextColor(0);
}

// ── Header: logo + legal name (bold, underlined) + registration line ──
function drawHeader(ctx: Ctx, yStart: number): number {
  const { doc, pageW, margin, company } = ctx;
  let y = yStart;
  const logo = company?.logo_url ?? null;
  const logoFmt = logo ? imageFormat(logo) : null;
  if (logo && logoFmt) {
    try {
      doc.addImage(logo, logoFmt, margin, y, 60, 60);
    } catch {
      /* skip bad image */
    }
  }
  const legal = legalNameOf(company);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(0);
  const nameY = y + 22;
  doc.text(legal, pageW / 2, nameY, { align: "center" });
  // underline
  const nw = doc.getTextWidth(legal);
  doc.setDrawColor(0);
  doc.setLineWidth(0.8);
  doc.line(pageW / 2 - nw / 2, nameY + 3, pageW / 2 + nw / 2, nameY + 3);
  doc.setLineWidth(0.2);

  if (company?.registration_line) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(60);
    doc.text(company.registration_line, pageW / 2, nameY + 18, { align: "center" });
    y = nameY + 30;
  } else {
    y = nameY + 16;
  }
  return Math.max(y, yStart + 66);
}

// ── Ref (left) | INVOICE {MONTH YEAR} (centre, bold, underlined) | Date (right) ──
function drawRefTitleDate(ctx: Ctx, yStart: number): number {
  const { doc, pageW, margin, invoice } = ctx;
  const y = yStart + 16;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(0);
  doc.text(`Ref: ${invoice.invoice_number ?? ""}`, margin, y);

  const title = `INVOICE ${titleMonthYear(invoice)}`;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(title, pageW / 2, y, { align: "center" });
  const tw = doc.getTextWidth(title);
  doc.line(pageW / 2 - tw / 2, y + 3, pageW / 2 + tw / 2, y + 3);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const dateStr = `Date: ${longDate(invoice.invoice_date)}`;
  doc.text(dateStr, pageW - margin - doc.getTextWidth(dateStr), y);
  return y + 16;
}

// ── Bordered key/value mini-table (client block, payment method) ──
function drawKvTable(
  ctx: Ctx,
  x: number,
  y: number,
  width: number,
  labelW: number,
  rows: [string, string][],
): number {
  const { doc } = ctx;
  const rowH = 20;
  doc.setDrawColor(120);
  doc.setLineWidth(0.5);
  rows.forEach((r, i) => {
    const ry = y + i * rowH;
    doc.rect(x, ry, width, rowH);
    doc.line(x + labelW, ry, x + labelW, ry + rowH);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(0);
    doc.text(r[0], x + 7, ry + 13);
    doc.setFont("helvetica", "normal");
    doc.text(doc.splitTextToSize(r[1] || "", width - labelW - 12)[0] ?? "", x + labelW + 7, ry + 13);
  });
  doc.setLineWidth(0.2);
  return y + rows.length * rowH;
}

function drawClientBlock(ctx: Ctx, yStart: number): number {
  const { pageW, invoice, client } = ctx;
  const width = 340;
  const x = (pageW - width) / 2;
  return drawKvTable(ctx, x, yStart, width, 100, [
    ["Client", client?.name ?? "—"],
    ["Address", client?.billing_address ?? "—"],
    ["Invoice No", invoice.invoice_number ?? "—"],
  ]);
}

function drawSalutationIntro(ctx: Ctx, yStart: number, intro: string): number {
  const { doc, pageW, margin } = ctx;
  let y = yStart + 22;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(0);
  doc.text("Dear Sir,", margin, y);
  y += 18;
  const lines = doc.splitTextToSize(intro, pageW - margin * 2);
  doc.text(lines, margin, y);
  return y + lines.length * 13 + 4;
}

function drawWordsLine(ctx: Ctx, yStart: number, prefix: string): number {
  const { doc, pageW, margin, invoice } = ctx;
  const total = Number(invoice.total_due ?? invoice.invoice_amount ?? 0);
  const words = amountInWords(total); // "Rupees ... Only"
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(0);
  const y = yStart + 14;
  const text = `${prefix} ${words}.`;
  const wrapped = doc.splitTextToSize(text, pageW - margin * 2);
  doc.text(wrapped, margin, y);
  return y + wrapped.length * 12;
}

function drawNotes(ctx: Ctx, yStart: number): number {
  const { doc, pageW, margin, invoice } = ctx;
  if (!invoice.notes) return yStart;
  let y = yStart + 12;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(0);
  doc.text("Note:", margin, y);
  const noteX = margin + doc.getTextWidth("Note: ") + 2;
  doc.setFont("helvetica", "normal");
  const wrapped = doc.splitTextToSize(invoice.notes, pageW - margin - noteX);
  doc.text(wrapped, noteX, y);
  return y + wrapped.length * 12 + 2;
}

// ── Payment Method (vertical bordered table; manually entered per invoice) ──
function drawPaymentMethod(ctx: Ctx, yStart: number): number {
  const { pageW, invoice } = ctx;
  const r = invoice.remit_account ?? null;
  const width = 340;
  const x = (pageW - width) / 2;
  return drawKvTable(ctx, x, yStart + 10, width, 130, [
    ["Payment Method", "Bank Transfer"],
    ["Account No.", r?.account_number ?? "—"],
    ["Account Title", r?.account_title ?? "—"],
    ["Bank Name", r?.bank_name ?? "—"],
  ]);
}

// ── Signature (stamp + label) + footer branding ──
function drawCenteredSegments(ctx: Ctx, segs: { t: string; b: boolean }[], y: number): void {
  const { doc, pageW } = ctx;
  const widths = segs.map((s) => {
    doc.setFont("helvetica", s.b ? "bold" : "normal");
    return doc.getTextWidth(s.t);
  });
  const total = widths.reduce((a, b) => a + b, 0);
  let x = (pageW - total) / 2;
  segs.forEach((s, i) => {
    doc.setFont("helvetica", s.b ? "bold" : "normal");
    doc.text(s.t, x, y);
    x += widths[i];
  });
}

function drawSignatureAndFooter(ctx: Ctx, yStart: number): void {
  const { doc, pageW, pageH, margin, company, settings } = ctx;
  const y = Math.min(yStart + 30, pageH - 150);

  const stamp = company?.stamp_url ?? null;
  const stampFmt = stamp ? imageFormat(stamp) : null;
  if (settings.general_show_stamp && stamp && stampFmt) {
    try {
      doc.addImage(stamp, stampFmt, pageW / 2 - 130, y, 80, 80);
    } catch {
      /* skip */
    }
  }
  // Signature label block (right of stamp).
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(0);
  doc.text(company?.signature_label || "Authorised Signatory", pageW / 2 - 20, y + 66);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(70);
  doc.text(company?.name || legalNameOf(company), pageW / 2 - 20, y + 80);

  // Footer branding (bold labels), centred at the bottom.
  const phones = company?.contact_phones?.length
    ? company.contact_phones.join(", ")
    : company?.contact_phone ?? "";
  doc.setDrawColor(180);
  doc.line(margin, pageH - 62, pageW - margin, pageH - 62);
  doc.setFontSize(8.5);
  doc.setTextColor(30);
  if (company?.legal_address) {
    drawCenteredSegments(ctx, [{ t: "Head Office: ", b: true }, { t: company.legal_address, b: false }], pageH - 48);
  }
  if (phones) {
    drawCenteredSegments(ctx, [{ t: "Contact: ", b: true }, { t: phones, b: false }], pageH - 36);
  }
  const line3: { t: string; b: boolean }[] = [];
  if (company?.contact_email) line3.push({ t: "Email: ", b: true }, { t: company.contact_email + "   ", b: false });
  if (company?.website) line3.push({ t: "Website: ", b: true }, { t: company.website, b: false });
  if (line3.length) drawCenteredSegments(ctx, line3, pageH - 24);
}

// ── FIXED / VARIABLE items table ──
function fixedLineRows(input: InvoiceDocInput, useAttendance: boolean) {
  return (input.invoiceLines ?? []).map((l) => {
    let qty = Number(l.quantity ?? 0);
    if (useAttendance && l.category && input.attendanceByCategory?.[l.category] != null) {
      qty = input.attendanceByCategory[l.category]!;
    }
    return { label: l.label, category: l.category, qty, rate: Number(l.unit_rate ?? 0), amount: qty * Number(l.unit_rate ?? 0) };
  });
}

function unitWord(rows: { category: ContractLineCategory | null }[]): string {
  const cats = rows.map((r) => r.category);
  if (cats.some((c) => c === "WEAPON" || c === "EQUIPMENT") && !cats.some((c) => c && c !== "WEAPON" && c !== "EQUIPMENT")) {
    return "Per Weapon";
  }
  return "Per Guard";
}

function drawFixedTable(
  ctx: Ctx,
  yStart: number,
  rows: { label: string; category: ContractLineCategory | null; qty: number; rate: number; amount: number }[],
  qtyHeader: string,
  showPrevBalance: boolean,
): number {
  const { doc, pageW, margin, invoice } = ctx;
  let y = yStart;
  const usable = pageW - margin * 2;
  const w = [28, 48, usable - 28 - 48 - 158 - 96 - 84, 158, 96, 84]; // Sr Qty Particular Period Rate Amount
  const xs: number[] = [];
  let acc = margin;
  for (const c of w) { xs.push(acc); acc += c; }

  // header (Monthly Rate has a 2nd line for the unit)
  const headH = 26;
  doc.setDrawColor(120);
  doc.setLineWidth(0.5);
  doc.setFillColor(244, 241, 232);
  doc.rect(margin, y, usable, headH, "FD");
  for (let i = 1; i < xs.length; i++) doc.line(xs[i], y, xs[i], y + headH);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(0);
  const hc = (i: number, t: string, dy: number) => doc.text(t, xs[i] + w[i] / 2, y + dy, { align: "center" });
  hc(0, "Sr.", 16);
  hc(1, "Qty", 16);
  hc(2, "Particular", 16);
  hc(3, "Period", 16);
  hc(4, "Monthly Rate", 12);
  hc(4, `(${unitWord(rows)})`, 22);
  hc(5, "Amount", 16);
  y += headH;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const period = periodRange(invoice);
  let subtotal = 0;
  const rowH = 18;
  rows.forEach((r, i) => {
    subtotal += r.amount;
    doc.rect(margin, y, usable, rowH);
    for (let k = 1; k < xs.length; k++) doc.line(xs[k], y, xs[k], y + rowH);
    doc.text(String(i + 1), xs[0] + w[0] / 2, y + 12, { align: "center" });
    doc.text(`${intFmt(r.qty)}x`, xs[1] + w[1] / 2, y + 12, { align: "center" });
    doc.text(doc.splitTextToSize(r.label || "—", w[2] - 10)[0] ?? "—", xs[2] + 5, y + 12);
    doc.setFontSize(8.5);
    doc.text(period, xs[3] + w[3] / 2, y + 12, { align: "center" });
    doc.setFontSize(9);
    doc.text(fixedMoney(r.rate), xs[4] + w[4] - 6, y + 12, { align: "right" });
    doc.text(fixedMoney(r.amount), xs[5] + w[5] - 6, y + 12, { align: "right" });
    y += rowH;
  });

  const prev = Number(invoice.previous_balance ?? 0);
  if (showPrevBalance && prev !== 0) {
    // "Previous Balance" right-aligned in the left span, value in Amount col.
    doc.rect(margin, y, usable, rowH);
    doc.line(xs[5], y, xs[5], y + rowH);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.text("Previous Balance", xs[5] - 8 - doc.getTextWidth("Previous Balance"), y + 12);
    doc.setFont("helvetica", "normal");
    doc.text(fixedMoney(prev), xs[5] + w[5] - 6, y + 12, { align: "right" });
    y += rowH;
  }

  const grand = Number(invoice.total_due ?? subtotal + prev);
  doc.rect(margin, y, usable, rowH);
  doc.line(xs[5], y, xs[5], y + rowH);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Total", (margin + xs[5]) / 2, y + 12, { align: "center" });
  doc.text(fixedMoney(grand), xs[5] + w[5] - 6, y + 12, { align: "right" });
  doc.setLineWidth(0.2);
  return y + rowH + 6;
}

function renderFixedFamily(input: InvoiceDocInput, useAttendance: boolean): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const ctx: Ctx = {
    doc,
    pageW: doc.internal.pageSize.getWidth(),
    pageH: doc.internal.pageSize.getHeight(),
    margin: 45,
    invoice: input.invoice,
    client: input.client,
    company: input.company,
    settings: mergeSettings(input.company),
  };
  drawWatermark(ctx);
  let y = drawHeader(ctx, ctx.margin);
  y = drawRefTitleDate(ctx, y);
  y = drawClientBlock(ctx, y + 10);
  const svc = ctx.company?.name || legalNameOf(ctx.company);
  const intro = `The monthly remuneration for the ${svc}, who are operating under your esteemed supervision, is as follows: -`;
  y = drawSalutationIntro(ctx, y, intro);
  const rows = fixedLineRows(input, useAttendance);
  const showPB = useAttendance ? !!ctx.settings.variable_show_previous_balance : !!ctx.settings.fixed_show_previous_balance;
  y = drawFixedTable(ctx, y, rows, useAttendance ? "Days" : "Qty", showPB);
  y = drawWordsLine(ctx, y, "Amount in words is");
  y = drawNotes(ctx, y);
  y = drawPaymentMethod(ctx, y);
  drawSignatureAndFooter(ctx, y);
  return doc;
}

// ── SLA items table (cost build-up + dynamic tax columns on admin cost) ──
function renderSla(input: InvoiceDocInput): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const ctx: Ctx = {
    doc,
    pageW: doc.internal.pageSize.getWidth(),
    pageH: doc.internal.pageSize.getHeight(),
    margin: 40,
    invoice: input.invoice,
    client: input.client,
    company: input.company,
    settings: mergeSettings(input.company),
  };
  drawWatermark(ctx);
  let y = drawHeader(ctx, ctx.margin);
  y = drawRefTitleDate(ctx, y);
  y = drawClientBlock(ctx, y + 10);
  y = drawSalutationIntro(ctx, y, `The monthly service charges for the period ${titleMonthYear(ctx.invoice)} are as follows: -`);

  const taxes: TaxLine[] =
    ctx.settings.sla_taxes_dynamic !== false
      ? input.client?.tax_profile ?? []
      : (input.client?.tax_profile ?? []).filter((t) => (ctx.settings.sla_tax_columns ?? []).includes(t.name));

  const conLines = input.contractLines ?? [];
  const cc = (l: ContractLine, key: string): number => {
    const v = l.cost_components as Record<string, unknown> | null;
    return v && typeof v[key] === "number" ? (v[key] as number) : 0;
  };

  const { doc: d, pageW, margin, invoice } = ctx;
  const usable = pageW - margin * 2;
  // Fixed columns then N tax columns then Grand Total.
  // Category | Salary&Exp | No. | Total Exp | Admin | Period(From|To) | Amount w/o GST | [tax..] | Grand Total
  const nTax = taxes.length;
  // Category | Salary&Exp | No | TotalExp | Admin | From | To | AmountWoGst, then
  // N tax columns, then Grand Total. Kept compact so 2 tax columns still get a
  // readable ~40pt each within the ~515pt usable width.
  const fixedW = [78, 46, 24, 52, 44, 40, 40, 52];
  const grandW = 52;
  const taxTotal = Math.max(0, usable - fixedW.reduce((a, b) => a + b, 0) - grandW);
  const taxW = nTax > 0 ? taxTotal / nTax : 0;
  const cols = [...fixedW, ...new Array(nTax).fill(taxW), grandW];
  const xs: number[] = [];
  let acc = margin;
  for (const c of cols) { xs.push(acc); acc += c; }
  const periodFromIdx = 5;
  const periodToIdx = 6;

  // Two-row header.
  const headH = 30;
  d.setDrawColor(120);
  d.setLineWidth(0.5);
  d.setFillColor(244, 241, 232);
  d.rect(margin, y, usable, headH, "FD");
  d.setFont("helvetica", "bold");
  d.setFontSize(7);
  d.setTextColor(0);
  const centerIn = (i: number, t: string, yy: number) => {
    const wrapped = d.splitTextToSize(t, cols[i] - 2);
    d.text(wrapped, xs[i] + cols[i] / 2, yy, { align: "center" });
  };
  // Vertical separators — full height except the From|To divider, which lives
  // only in the lower half so "Period" can span both above it.
  for (let i = 1; i < xs.length; i++) {
    if (i === periodToIdx) d.line(xs[i], y + headH / 2, xs[i], y + headH);
    else d.line(xs[i], y, xs[i], y + headH);
  }
  // "Period" super-header spanning From+To, with a divider under it.
  d.line(xs[periodFromIdx], y + headH / 2, xs[periodToIdx] + cols[periodToIdx], y + headH / 2);
  d.text("Period", xs[periodFromIdx] + (cols[periodFromIdx] + cols[periodToIdx]) / 2, y + 11, { align: "center" });
  centerIn(0, "Category", y + 18);
  centerIn(1, "Salary & Expenses", y + 15);
  centerIn(2, "No.", y + 18);
  centerIn(3, "Total Expenses", y + 15);
  centerIn(4, "Admin Cost", y + 15);
  d.text("From", xs[periodFromIdx] + cols[periodFromIdx] / 2, y + 25, { align: "center" });
  d.text("To", xs[periodToIdx] + cols[periodToIdx] / 2, y + 25, { align: "center" });
  centerIn(7, "Amount w/o GST", y + 15);
  taxes.forEach((t, k) => centerIn(8 + k, `${t.name} (${t.rate}%)`, y + 15));
  centerIn(cols.length - 1, "Grand Total", y + 15);
  y += headH;

  const fromS = shortDate(invoice.period_start);
  const toS = shortDate(invoice.period_end);
  const totals = new Array(cols.length).fill(0);
  d.setFont("helvetica", "normal");
  d.setFontSize(7);
  const rowH = 16;
  for (const l of conLines) {
    const count = Number(l.committed_count ?? 0);
    const salary = cc(l, "salary") || Number(l.unit_rate ?? 0);
    const totalExp = cc(l, "total_expenses") || salary * count;
    const admin = cc(l, "admin_cost");
    const amountWoGst = totalExp + admin;
    // Per the company's SLA format, GST/WHT are levied on the admin cost.
    const taxVals = taxes.map((t) => (admin * Number(t.rate || 0)) / 100);
    const grand = amountWoGst + taxVals.reduce((s, v) => s + v, 0);

    d.rect(margin, y, usable, rowH);
    for (let i = 1; i < xs.length; i++) d.line(xs[i], y, xs[i], y + rowH);
    d.text(d.splitTextToSize(CONTRACT_LINE_CATEGORY_LABEL[l.category], cols[0] - 4)[0] ?? "", xs[0] + 3, y + 11);
    const rightN = (i: number, val: number) => d.text(intFmt(val), xs[i] + cols[i] - 3, y + 11, { align: "right" });
    rightN(1, salary);
    d.text(intFmt(count), xs[2] + cols[2] / 2, y + 11, { align: "center" });
    rightN(3, totalExp);
    rightN(4, admin);
    d.text(fromS, xs[periodFromIdx] + cols[periodFromIdx] / 2, y + 11, { align: "center" });
    d.text(toS, xs[periodToIdx] + cols[periodToIdx] / 2, y + 11, { align: "center" });
    rightN(7, amountWoGst);
    taxVals.forEach((v, k) => rightN(8 + k, v));
    rightN(cols.length - 1, grand);

    totals[2] += count; totals[3] += totalExp; totals[4] += admin; totals[7] += amountWoGst;
    taxVals.forEach((v, k) => (totals[8 + k] += v));
    totals[cols.length - 1] += grand;
    y += rowH;
  }
  // Total row
  d.setFont("helvetica", "bold");
  d.rect(margin, y, usable, rowH + 2);
  for (let i = 1; i < xs.length; i++) d.line(xs[i], y, xs[i], y + rowH + 2);
  d.text("Total", xs[0] + 3, y + 11);
  d.text(intFmt(totals[2]), xs[2] + cols[2] / 2, y + 11, { align: "center" });
  [3, 4, 7, ...taxes.map((_, k) => 8 + k), cols.length - 1].forEach((i) =>
    d.text(intFmt(totals[i]), xs[i] + cols[i] - 3, y + 11, { align: "right" }),
  );
  d.setLineWidth(0.2);
  y += rowH + 8;

  y = drawWordsLine(ctx, y, "Amount in words:");
  y = drawNotes(ctx, y);
  y = drawPaymentMethod(ctx, y);

  // Employer / Service Provider + NTN block.
  d.setFont("helvetica", "bold");
  d.setFontSize(9);
  d.setTextColor(0);
  d.text(`Employer: ${input.client?.name ?? "—"}`, margin, y + 6);
  d.text(`Service Provider: ${legalNameOf(input.company)}`, pageW / 2, y + 6);
  d.setFont("helvetica", "normal");
  d.setFontSize(8.5);
  d.text(`NTN No: ${input.client?.ntn ?? "—"}`, margin, y + 20);
  d.text(`NTN No: ${input.company?.tax_ntn ?? "—"}`, pageW / 2, y + 20);
  y += 30;

  drawSignatureAndFooter(ctx, y);
  return doc;
}

/**
 * Render + download the correct template for this invoice, chosen by the
 * client's invoice_group. FIXED/unknown → Fixed, SLA → SLA, VARIABLE → Variable.
 */
export function generateInvoiceDocument(input: InvoiceDocInput): jsPDF {
  const group = input.client?.invoice_group ?? "FIXED";
  const doc = group === "SLA" ? renderSla(input) : renderFixedFamily(input, group === "VARIABLE");
  if (input.save !== false) {
    doc.save(`invoice_${input.invoice.invoice_number ?? input.invoice.id}.pdf`);
  }
  return doc;
}
