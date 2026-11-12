import { saveBlob } from "./saveFile";

/**
 * The online-banking bulk upload file for one batch (0662), per bank format —
 * see docs/INET_BULK_FILE_FORMAT.md.
 *  - askari: Askari iNet. One sheet "Sheet1", 13 columns, FT or IBFT1 — copied
 *    from the files Shayan uploaded for October 2026.
 *  - soneri: Soneri Trans@ct templates "Fund Transfer With Purpose" (sheet FT)
 *    and "Inter Bank Fund Transfer with Purpose" (sheet IBFT) — copied from
 *    Soneri's own samples (12 Nov 2026), with the 1LINK purpose code
 *    (0501 salary, 0122 vendor payment).
 *
 * Everything written comes from the batch's items as stored at initiation
 * (account, bank name, code were fixed then), so downloading again gives the
 * same file.
 */
export type InetFileBatch = {
  label: string;
  reference: string | null;
  file_kind: "FT" | "IBFT" | "single" | "manual";
  transaction_date: string; // yyyy-mm-dd
  /** 0667: join the items paid to the same receiver account into one row (one transfer). */
  combined?: boolean;
};
export type InetFormat = "askari" | "soneri";
export type InetFileItem = {
  kind?: "payslip" | "vendor";
  payee_name: string;
  account_no: string | null;
  bank_name: string | null;
  bank_code: string | null;
  amount: number;
  /** 0663: the guard, when his salary is paid to someone else (payee_name is the receiver). */
  on_behalf_of?: string | null;
  /** 0667: a joined row — how many guards' salaries it carries. */
  guards?: number;
};

const HEADERS = [
  "S.No", "Transaction Date", "Beneficiary Bank Code", "Beneficiary Bank Name", "Beneficiary Name",
  "Beneficiary Account No", "Amount", "Product Type Code", "ReferenceFeild1", "ReferenceFeild2",
  "ReferenceFeild3", "BeneficiaryMobile", "BeneficiaryEmail",
];

/** Excel's day number for a yyyy-mm-dd date (the files store the date as a number shown m/d/yy). */
const excelDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
};

export const inetFileName = (bankName: string, b: InetFileBatch) =>
  `Inet ${bankName} ${b.label} ${b.transaction_date}.xlsx`.replace(/[\\/:*?"<>|]+/g, " ");

/** Soneri: product codes for a bulk upload, and the 1LINK purpose codes. */
export const SONERI_PRODUCT = { FT: "FTBulk", IBFT: "IBFTBulk" } as const;
const PURPOSE = { payslip: 501, vendor: 122 } as const;

export async function downloadInetFile(bankName: string, format: InetFormat, batch: InetFileBatch, items: InetFileItem[]): Promise<void> {
  const XLSX = await import("xlsx");
  const out = buildInetFile(XLSX, format, batch, items);
  await saveBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), inetFileName(bankName, batch));
}

/**
 * 0667: the rows the file carries. A combined batch joins the items paid to
 * the same receiver account (salary paid to someone else) into one row — the
 * receiver, the total, "Salaries of N guards". Every other item is its own row.
 * Each payslip keeps its own item in Bastion; only the file is joined.
 */
export function inetFileRows(batch: Pick<InetFileBatch, "combined">, items: InetFileItem[]): InetFileItem[] {
  if (!batch.combined) return items;
  const out: InetFileItem[] = [];
  const groups = new Map<string, { row: InetFileItem; n: number }>();
  for (const it of items) {
    if (!it.on_behalf_of || !it.account_no) { out.push(it); continue; }
    const key = it.account_no.toUpperCase().replace(/[^0-9A-Z]/g, "");
    const g = groups.get(key);
    if (g) { g.row.amount += Math.round(Number(it.amount)); g.n += 1; continue; }
    const row = { ...it, amount: Math.round(Number(it.amount)) };
    groups.set(key, { row, n: 1 });
    out.push(row);
  }
  for (const g of groups.values()) if (g.n > 1) g.row.guards = g.n;
  return out;
}

/** The second reference: the guard a salary belongs to, or how many a joined row carries. */
const behalfRef = (it: InetFileItem) =>
  it.guards ? `Salaries of ${it.guards} guards` : it.on_behalf_of ? `Salary of ${it.on_behalf_of}`.slice(0, 40) : null;

/** The upload file's bytes — pure, so the same code makes the app's download and any offline test file. */
export function buildInetFile(XLSX: typeof import("xlsx"), format: InetFormat, batch: InetFileBatch, allItems: InetFileItem[]): ArrayBuffer {
  if (batch.file_kind !== "FT" && batch.file_kind !== "IBFT") {
    throw new Error("This batch is keyed into online banking by hand — there is no upload file for it.");
  }
  const items = inetFileRows(batch, allItems);
  if (format === "soneri") return soneriFile(XLSX, batch, items);
  const ft = batch.file_kind === "FT";
  const day = excelDay(batch.transaction_date);
  const rows: (string | number | null)[][] = [HEADERS];
  items.forEach((it, i) => {
    rows.push([
      i + 1,
      day,
      it.bank_code != null && it.bank_code !== "" ? Number(it.bank_code) : null,
      it.bank_name ?? "",
      it.payee_name,
      // Askari→Askari: the 13-digit account as a number, as in the accepted files.
      // Other banks: the IBAN as text.
      // A leading 0 is part of the account (0990100587220): a number would drop
      // it, so such an account is written as text with every digit.
      ft ? (/^0/.test(it.account_no ?? "") ? String(it.account_no) : Number(it.account_no)) : (it.account_no ?? ""),
      Math.round(Number(it.amount)),
      ft ? "FT" : "IBFT1",
      batch.reference ?? "",
      // 0663: a salary paid to someone else names the guard it belongs to.
      behalfRef(it),
      null, null, null,
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  for (let r = 1; r <= items.length; r += 1) {
    const date = ws[XLSX.utils.encode_cell({ r, c: 1 })];
    if (date) date.z = "m/d/yy";
    const acct = ws[XLSX.utils.encode_cell({ r, c: 5 })];
    if (acct && ft) { if (acct.t === "s") acct.z = "@"; else acct.z = "0"; }
    const amt = ws[XLSX.utils.encode_cell({ r, c: 6 })];
    if (amt) amt.z = "0";
  }
  ws["!cols"] = [5, 14, 18, 26, 28, 28, 11, 15, 14, 14, 14, 15, 15].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

function soneriFile(XLSX: typeof import("xlsx"), batch: InetFileBatch, items: InetFileItem[]): ArrayBuffer {
  const ft = batch.file_kind === "FT";
  const headers = ft
    ? ["ProductTypeCode", "BeneficiaryAccountNo", "Amount", "ReferenceField1", "ReferenceField2", "ReferenceField3", "Purpose of Payment"]
    : ["ProductTypeCode", "BeneficiaryAccountNo", "BeneficiaryBankCode", "Amount", "ReferenceField1", "ReferenceField2", "ReferenceField3", "Purpose of Payment"];
  const rows: (string | number | null)[][] = [headers];
  for (const it of items) {
    const purpose = PURPOSE[it.kind ?? "payslip"];
    const refs = [batch.reference ?? "", (behalfRef(it) ?? it.payee_name).slice(0, 40), batch.label.slice(0, 40)];
    rows.push(ft
      ? [SONERI_PRODUCT.FT, it.account_no ?? "", Math.round(Number(it.amount)), ...refs, purpose]
      : [SONERI_PRODUCT.IBFT, it.account_no ?? "", it.bank_code != null && it.bank_code !== "" ? Number(it.bank_code) : null, Math.round(Number(it.amount)), ...refs, purpose]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // The account is text (the sample formats it "@"), so long numbers and IBANs keep every digit.
  for (let r = 1; r <= items.length; r += 1) {
    const a = ws[XLSX.utils.encode_cell({ r, c: 1 })];
    if (a) { a.t = "s"; a.v = String(a.v); a.z = "@"; }
  }
  ws["!cols"] = (ft ? [15, 26, 12, 16, 30, 30, 17] : [15, 28, 18, 12, 16, 30, 30, 17]).map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, ft ? "FT" : "IBFT");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}
