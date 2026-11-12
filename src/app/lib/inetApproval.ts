/**
 * Askari iNet "Ins_Approval" export → which payments of a batch the bank has.
 * Studied 12 Nov 2026 from three exports Shayan shared:
 *  - one sheet; a header row with INSTRUCTIONID, AMOUNT, BENEFICIARYACCOUNTNO,
 *    STATUS and FILEBATCHNO ("<n>-<uploaded file name>", or "SI" for single
 *    instructions);
 *  - STATUS 8 = verified, waiting for approval; 14 = approved;
 *  - REJECTED PAYMENTS ARE NOT IN THE EXPORT (Shayan): they show only on
 *    iNet's screen. So a payment of the batch missing from the file is taken
 *    as rejected — proposed, and confirmed by the person releasing.
 * Each row is matched once, on account number and whole-rupee amount.
 */
export type ApprovalItem = { id: string; account_no: string | null; amount: number; payee_name: string };
export type ApprovalRow = { instructionId: string; account: string; amount: number; status: string; fileBatch: string; name: string };
export type ApprovalMatch = {
  rows: ApprovalRow[];
  matched: Map<string, ApprovalRow>;      // item id → its row
  missing: ApprovalItem[];                // in the batch, not in the file → rejected
  extra: ApprovalRow[];                   // in the file, not in the batch
  notApproved: ApprovalRow[];             // matched, but STATUS is not 14
  fileNames: string[];                    // distinct FILEBATCHNO values
  matchedTotal: number;
};

const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^0+/, "");

export function readApprovalSheet(XLSX: typeof import("xlsx"), data: ArrayBuffer): ApprovalRow[] {
  const wb = XLSX.read(data, { type: "array" });
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null });
    const h = grid.findIndex((r) => r.some((c) => String(c ?? "").trim().toUpperCase() === "INSTRUCTIONID"));
    if (h < 0) continue;
    const head = grid[h].map((c) => String(c ?? "").trim().toUpperCase());
    const col = (k: string) => head.indexOf(k);
    const [iId, iAmt, iAcct, iSt, iFb, iName] = [col("INSTRUCTIONID"), col("AMOUNT"), col("BENEFICIARYACCOUNTNO"), col("STATUS"), col("FILEBATCHNO"), col("BENEFICIARYNAME")];
    if (iId < 0 || iAmt < 0 || iAcct < 0) continue;
    return grid.slice(h + 1)
      .filter((r) => r[iId] != null && String(r[iId]).trim() !== "")
      .map((r) => ({
        instructionId: String(r[iId]).trim(),
        account: String(r[iAcct] ?? "").trim(),
        amount: Math.round(Number(String(r[iAmt] ?? "0").replace(/,/g, "")) || 0),
        status: iSt >= 0 ? String(r[iSt] ?? "").trim() : "",
        fileBatch: iFb >= 0 ? String(r[iFb] ?? "").trim() : "",
        name: iName >= 0 ? String(r[iName] ?? "").trim() : "",
      }));
  }
  throw new Error("This is not an iNet approval export — no INSTRUCTIONID / AMOUNT / BENEFICIARYACCOUNTNO columns found.");
}

export function matchApproval(items: ApprovalItem[], rows: ApprovalRow[]): ApprovalMatch {
  const free = [...rows];
  const matched = new Map<string, ApprovalRow>();
  const missing: ApprovalItem[] = [];
  for (const it of items) {
    const k = norm(it.account_no);
    const amt = Math.round(it.amount);
    const i = free.findIndex((r) => norm(r.account) === k && r.amount === amt);
    if (i >= 0 && k) { matched.set(it.id, free[i]); free.splice(i, 1); } else missing.push(it);
  }
  const m = [...matched.values()];
  return {
    rows, matched, missing, extra: free,
    notApproved: m.filter((r) => r.status && r.status !== "14"),
    fileNames: [...new Set(rows.map((r) => r.fileBatch).filter((f) => f && f !== "SI"))],
    matchedTotal: m.reduce((s, r) => s + r.amount, 0),
  };
}
