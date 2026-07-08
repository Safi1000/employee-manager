import jsPDF from "jspdf";
import type {
  Client,
  Company,
  Invoice,
  InvoiceLine,
  InvoiceTax,
  InvoiceTemplateField,
  InvoiceTemplateItem,
} from "./supabase";

// Header fields go in the top block, totals at the bottom, everything else
// (description, notes) in the middle. Fields not in the company's template
// are omitted entirely.
const HEADER_FIELDS: InvoiceTemplateField[] = [
  "invoice_number",
  "invoice_date",
  "client_name",
  "client_code",
  "client_email",
  "client_phone",
  "contract_period",
  "status",
];
const TOTAL_FIELDS: InvoiceTemplateField[] = [
  "subtotal",
  "withholding_tax",
  "total",
  "amount_received",
  "balance_due",
];

const fmtPkr = (n: number) => `PKR ${Number(n ?? 0).toLocaleString()}`;

function valueFor(
  field: InvoiceTemplateField,
  inv: Invoice,
  client: Client | null,
): string {
  const amt = Number(inv.invoice_amount ?? 0);
  const wht = Number(inv.withholding_tax ?? 0);
  const received = Number(inv.amount_received ?? 0);
  switch (field) {
    case "invoice_number":
      return inv.invoice_number ?? "—";
    case "invoice_date":
      return inv.invoice_date ?? "—";
    case "client_name":
      return client?.name ?? "—";
    case "client_code":
      return client?.client_code ?? "—";
    case "client_email":
      return client?.email ?? "—";
    case "client_phone":
      return client?.phone ?? "—";
    case "contract_period":
      return client?.contract_start || client?.contract_end
        ? `${client?.contract_start ?? "—"} → ${client?.contract_end ?? "—"}`
        : "—";
    case "description":
      return inv.notes?.trim() ? inv.notes : "Services rendered";
    case "subtotal":
      return fmtPkr(amt);
    case "withholding_tax":
      return fmtPkr(wht);
    case "total":
      return fmtPkr(amt - wht);
    case "amount_received":
      return fmtPkr(received);
    case "balance_due":
      return fmtPkr(amt - wht - received);
    case "status":
      return inv.status ?? "—";
    case "notes":
      return inv.notes ?? "—";
  }
}

export function generateInvoicePdf(
  inv: Invoice,
  client: Client | null,
  company: Company | null,
  template: InvoiceTemplateItem[],
  // Phase 6: when provided, a richer itemized body (lines + taxes + previous
  // balance + total due + amount in words + remit account) is rendered in place
  // of the plain template body.
  detail?: { lines?: InvoiceLine[]; taxes?: InvoiceTax[] },
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(company?.name ?? "Invoice", margin, y);
  y += 22;

  if (company?.contact_email || company?.contact_phone) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(110);
    const contactLine = [company?.contact_email, company?.contact_phone]
      .filter(Boolean)
      .join("  ·  ");
    doc.text(contactLine, margin, y);
    y += 14;
  }

  doc.setDrawColor(220);
  doc.line(margin, y, pageWidth - margin, y);
  y += 18;

  doc.setTextColor(0);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("INVOICE", margin, y);
  y += 18;

  const headerItems = template.filter((t) =>
    HEADER_FIELDS.includes(t.field as InvoiceTemplateField),
  );
  const totalItems = template.filter((t) =>
    TOTAL_FIELDS.includes(t.field as InvoiceTemplateField),
  );
  const bodyItems = template.filter(
    (t) =>
      !HEADER_FIELDS.includes(t.field as InvoiceTemplateField) &&
      !TOTAL_FIELDS.includes(t.field as InvoiceTemplateField),
  );

  const writeKv = (title: string, value: string) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(title.toUpperCase(), margin, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(0);
    const lines = doc.splitTextToSize(value || "—", pageWidth - margin * 2);
    doc.text(lines, margin, y + 14);
    y += 14 + 14 * lines.length;
  };

  for (const item of headerItems) {
    writeKv(item.title, valueFor(item.field as InvoiceTemplateField, inv, client));
  }

  const hasDetail = !!detail?.lines && detail.lines.length > 0;
  if (hasDetail) {
    const lines = detail!.lines!;
    const taxes = detail!.taxes ?? [];
    y += 8;
    doc.setDrawColor(220);
    doc.line(margin, y, pageWidth - margin, y);
    y += 16;
    // Line-item table header
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text("DESCRIPTION", margin, y);
    doc.text("QTY", pageWidth - margin - 180, y);
    doc.text("RATE", pageWidth - margin - 110, y);
    doc.text("AMOUNT", pageWidth - margin - 10 - doc.getTextWidth("AMOUNT"), y);
    y += 6;
    doc.setDrawColor(230);
    doc.line(margin, y, pageWidth - margin, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(0);
    for (const l of lines) {
      doc.text(String(l.label ?? ""), margin, y);
      doc.text(String(l.quantity ?? 0), pageWidth - margin - 180, y);
      doc.text(fmtPkr(l.unit_rate).replace("PKR ", ""), pageWidth - margin - 110, y);
      const amt = fmtPkr(l.amount);
      doc.text(amt, pageWidth - margin - 10 - doc.getTextWidth(amt), y);
      y += 16;
    }
    const rightLabel = (label: string, value: string, bold = false) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(bold ? 12 : 10);
      doc.setTextColor(bold ? 0 : 80);
      doc.text(label, pageWidth - margin - 200, y);
      doc.text(value, pageWidth - margin - 10 - doc.getTextWidth(value), y);
      y += bold ? 20 : 16;
    };
    y += 4;
    doc.setDrawColor(230);
    doc.line(pageWidth - margin - 220, y - 8, pageWidth - margin, y - 8);
    rightLabel("Subtotal", fmtPkr(inv.subtotal ?? 0));
    for (const t of taxes) {
      const sign = t.direction === "WITHHELD" ? "−" : "+";
      rightLabel(`${t.name} (${t.rate}%)`, `${sign}${fmtPkr(t.amount)}`);
    }
    if ((inv.previous_balance ?? 0) !== 0) rightLabel("Previous Balance", fmtPkr(inv.previous_balance ?? 0));
    rightLabel("Total Due", fmtPkr(inv.total_due ?? 0), true);
    if ((inv.tax_withheld_total ?? 0) > 0) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.setTextColor(120);
      doc.text("(net of withholding)", pageWidth - margin - 10 - doc.getTextWidth("(net of withholding)"), y);
      y += 14;
    }
    // Amount in words
    if (inv.amount_in_words) {
      y += 4;
      doc.setFont("helvetica", "italic");
      doc.setFontSize(10);
      doc.setTextColor(0);
      const wl = doc.splitTextToSize(inv.amount_in_words, pageWidth - margin * 2);
      doc.text(wl, margin, y);
      y += 14 * wl.length + 4;
    }
    // Remit account
    if (inv.remit_account) {
      const r = inv.remit_account;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(110);
      doc.text("REMIT TO", margin, y);
      y += 13;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(0);
      doc.text([r.account_title, r.account_number, r.bank_name].filter(Boolean).join("  ·  "), margin, y);
      y += 16;
    }
    if (inv.notes) writeKv("Notes", inv.notes);
  }

  if (!hasDetail && bodyItems.length > 0) {
    y += 6;
    doc.setDrawColor(220);
    doc.line(margin, y, pageWidth - margin, y);
    y += 14;
    for (const item of bodyItems) {
      writeKv(item.title, valueFor(item.field as InvoiceTemplateField, inv, client));
    }
  }

  if (!hasDetail && totalItems.length > 0) {
    y += 8;
    doc.setDrawColor(220);
    doc.line(margin, y, pageWidth - margin, y);
    y += 14;
    for (const item of totalItems) {
      const isTotalRow = item.field === "total" || item.field === "balance_due";
      doc.setFont("helvetica", isTotalRow ? "bold" : "normal");
      doc.setFontSize(isTotalRow ? 13 : 11);
      doc.setTextColor(isTotalRow ? 0 : 80);
      const title = item.title;
      const value = valueFor(item.field as InvoiceTemplateField, inv, client);
      doc.text(title, margin, y);
      const tw = doc.getTextWidth(value);
      doc.text(value, pageWidth - margin - tw, y);
      y += isTotalRow ? 22 : 18;
    }
  }

  doc.setFont("helvetica", "italic");
  doc.setFontSize(9);
  doc.setTextColor(140);
  doc.text(
    `Generated ${new Date().toLocaleString()}`,
    margin,
    doc.internal.pageSize.getHeight() - 30,
  );
  doc.save(`invoice_${inv.invoice_number ?? inv.id}.pdf`);
}
