import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import type { Company } from "./supabase";
import { brandingFromCompany, drawBrandedFooter, drawBrandedHeader } from "./pdfBranding";

/**
 * FUEL EXPENSE SHEET (0582, Shayan 2026-10-28) — the monthly sheet each card
 * holder signs, in the layout of the Excel sheet it replaces: Sr, Date,
 * Detail, Client, KM, Petrol price, Avg (Rs/km), Amount, Balance; the month's
 * total; the holder's signature. Every figure is read from
 * fuel_card_statement — nothing here adds a balance up.
 */

export type FuelSheetRow = {
  entry_date: string | null; kind: string; detail: string | null; client_name: string | null;
  km: number | null; km_per_litre: number | null; petrol_price: number | null;
  loaded: number | null; spent: number | null; balance: number;
};

const money = (n: number | null | undefined) =>
  n == null ? "" : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (iso: string | null) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

export function generateFuelSheetPdf(o: {
  company: Company | null | undefined;
  cardLabel: string; cardLast4: string | null; holder: string | null;
  monthLabel: string; from: string; to: string;
  rows: FuelSheetRow[];
}) {
  const b = brandingFromCompany(o.company);
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
  const W = doc.internal.pageSize.getWidth();
  const M = 12;
  let y = drawBrandedHeader(doc, b, "Fuel Expense Sheet",
    `${o.cardLast4 ? `Card ••${o.cardLast4}` : o.cardLabel}${o.holder ? ` (${o.holder})` : ""} · ${day(o.from)} to ${day(o.to)}`) + 6;

  // columns: Sr, Date, Detail, Client, KM, Petrol Pr, Avg, Amount, Balance
  const cols = [
    { h: "Sr", w: 10, a: "left" }, { h: "Date", w: 22, a: "left" }, { h: "Detail", w: 92, a: "left" },
    { h: "Client", w: 46, a: "left" }, { h: "KM", w: 14, a: "right" }, { h: "Petrol Pr", w: 20, a: "right" },
    { h: "Avg (Rs/km)", w: 22, a: "right" }, { h: "Amount", w: 24, a: "right" }, { h: "Balance", w: 23, a: "right" },
  ] as const;
  const xs: number[] = []; let x = M;
  for (const c of cols) { xs.push(x); x += c.w; }
  const cell = (i: number, text: string) => {
    const c = cols[i];
    if (c.a === "right") doc.text(text, xs[i] + c.w - 1.5, y, { align: "right" });
    else doc.text(text, xs[i] + 1.5, y);
  };
  const head = () => {
    doc.setFillColor(240, 240, 240); doc.rect(M, y - 4.5, W - 2 * M, 6.5, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(30);
    cols.forEach((c, i) => cell(i, c.h));
    y += 6;
  };
  head();

  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
  let sr = 0; let spent = 0; let loaded = 0;
  const opening = o.rows.find((r) => r.kind === "OPENING_BALANCE");
  for (const r of o.rows) {
    const lines = doc.splitTextToSize(r.kind === "OPENING_BALANCE" ? "Balance brought forward" : (r.detail ?? ""), cols[2].w - 3) as string[];
    const h = Math.max(1, lines.length) * 4.2 + 1.6;
    if (y + h > doc.internal.pageSize.getHeight() - 22) { doc.addPage(); y = 16; head(); doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); }
    doc.setTextColor(30);
    if (r.kind === "OPENING_BALANCE") {
      doc.setFont("helvetica", "italic");
      cell(2, "Balance brought forward"); cell(8, money(r.balance));
      doc.setFont("helvetica", "normal");
    } else {
      sr += 1;
      cell(0, String(sr)); cell(1, day(r.entry_date));
      lines.forEach((ln, k) => doc.text(ln, xs[2] + 1.5, y + k * 4.2));
      cell(3, (r.client_name ?? (r.kind === "TOP-UP" ? "" : "General")).slice(0, 30));
      if (r.km != null) cell(4, String(Number(r.km)));
      if (r.petrol_price != null) cell(5, money(r.petrol_price));
      if (r.petrol_price != null && r.km_per_litre) cell(6, money(Number(r.petrol_price) / Number(r.km_per_litre)));
      if (r.kind === "TOP-UP") cell(7, `+${money(r.loaded)}`); else cell(7, money(r.spent));
      cell(8, money(r.balance));
      spent += Number(r.spent ?? 0); loaded += Number(r.loaded ?? 0);
    }
    y += h;
    doc.setDrawColor(225); doc.line(M, y - 3.4, W - M, y - 3.4);
  }

  y += 2;
  doc.setFont("helvetica", "bold"); doc.setFontSize(9);
  doc.text("Total spent", xs[2] + 1.5, y);
  cell(7, money(spent));
  const closing = o.rows.length ? o.rows[o.rows.length - 1].balance : 0;
  cell(8, money(closing));
  if (loaded) { y += 5; doc.setFont("helvetica", "normal"); doc.text(`Topped up in the period: ${money(loaded)}`, xs[2] + 1.5, y); }
  if (opening) { y += 5; doc.setFont("helvetica", "normal"); doc.text(`Opening ${money(opening.balance)} · closing ${money(closing)}`, xs[2] + 1.5, y); }

  // signature
  y += 18;
  if (y > doc.internal.pageSize.getHeight() - 24) { doc.addPage(); y = 30; }
  doc.setDrawColor(120); doc.line(W - M - 70, y, W - M, y);
  doc.setFont("helvetica", "bold"); doc.setFontSize(9);
  doc.text((o.holder ?? "Card holder").toUpperCase(), W - M - 35, y + 5, { align: "center" });

  drawBrandedFooter(doc, b, "Fuel Expense Sheet — from Bastion's card statement.");
  void savePdf(doc, `Fuel Expense Sheet ${o.monthLabel} — ${o.holder ?? o.cardLabel}.pdf`);
}
