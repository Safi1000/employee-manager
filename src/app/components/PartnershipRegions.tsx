import { useCallback, useEffect, useMemo, useState } from "react";
import Button from "./Button";
import Modal from "./Modal";
import ClientClearances from "./ClientClearances";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * BY REGION (0537, 2026-10-21). Each region's month in the partnership, and
 * where it left the equity partner (Shujaat Mehmood, who provides all the
 * operating capital): what the region made, what its regional partner took,
 * and what reached the equity partner — month and running total. A region
 * whose running total is negative has been spending the equity partner's
 * money.
 *
 * A region OUTSIDE the partnership (Lahore from 2026-09) contributes only its
 * DECLARED profit for the month: no money moves, nothing is posted, and its
 * regional partner gets no line. Declaring needs accounting.edit; the run must
 * then be re-drafted to pick it up.
 */

type Out = {
  row_kind: string;
  branch_id: string | null;
  region_name: string | null;
  partner_name: string | null;
  own_profit: number | null;
  ho_allocated: number | null;
  base_amount: number | null;
  amount: number | null;
};

const acct = (n: number | null | undefined) => {
  const v = Number(n ?? 0);
  const s = Math.abs(Math.round(v)).toLocaleString();
  return v < 0 ? `(${s})` : s;
};

export default function PartnershipRegions({
  companyId, month, outputs, status, canDeclare, onDeclared,
}: {
  companyId: string;
  /** YYYY-MM-01 */
  month: string;
  outputs: Out[];
  status: string | null;
  canDeclare: boolean;
  onDeclared: () => void;
}) {
  const [outside, setOutside] = useState<Set<string>>(new Set());
  const [declared, setDeclared] = useState<Map<string, { amount: number; note: string | null }>>(new Map());
  const [running, setRunning] = useState<Map<string, number>>(new Map());
  const [editing, setEditing] = useState<{ branchId: string; name: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [set, dec, runs] = await Promise.all([
      supabase.from("partnership_region_settings").select("branch_id, outside_from, outside_to").eq("company_id", companyId),
      supabase.from("region_declared_profit").select("branch_id, amount, note").eq("company_id", companyId).eq("period_month", month),
      supabase.from("profit_allocation_runs").select("period_month, status, outputs").eq("company_id", companyId).lte("period_month", month),
    ]);
    const o = new Set<string>();
    for (const s of (set.data ?? []) as { branch_id: string; outside_from: string; outside_to: string | null }[]) {
      if (s.outside_from <= month && (!s.outside_to || s.outside_to >= month)) o.add(s.branch_id);
    }
    setOutside(o);
    setDeclared(new Map(((dec.data ?? []) as { branch_id: string; amount: number; note: string | null }[])
      .map((d) => [d.branch_id, { amount: Number(d.amount), note: d.note }])));
    // Running total to the equity partner, per region, over every month up to
    // this one that has a live run (a reversed run moved nothing).
    const run = new Map<string, number>();
    for (const r of (runs.data ?? []) as { status: string; outputs: Out[] | null }[]) {
      if (r.status === "REVERSED") continue;
      for (const x of r.outputs ?? []) {
        if (x.row_kind !== "EQUITY_REGION" || !x.branch_id) continue;
        run.set(x.branch_id, (run.get(x.branch_id) ?? 0) + Number(x.amount ?? 0));
      }
    }
    setRunning(run);
  }, [companyId, month]);
  useEffect(() => { void load(); }, [load, outputs]);

  const rows = useMemo(() => {
    const regions = outputs.filter((r) => r.row_kind === "REGION" && r.branch_id);
    return regions.map((r) => {
      const regional = outputs.filter((x) => x.row_kind === "REGIONAL_PARTNER" && x.branch_id === r.branch_id);
      const equity = outputs.filter((x) => x.row_kind === "EQUITY_REGION" && x.branch_id === r.branch_id);
      return {
        branchId: r.branch_id!,
        name: r.region_name ?? "—",
        profit: Number(r.base_amount ?? 0),
        own: Number(r.own_profit ?? 0),
        ho: Number(r.ho_allocated ?? 0),
        regional: regional.reduce((s, x) => s + Number(x.amount ?? 0), 0),
        regionalNames: regional.map((x) => x.partner_name).filter(Boolean).join(", "),
        toEquity: equity.reduce((s, x) => s + Number(x.amount ?? 0), 0),
        equityName: equity.map((x) => x.partner_name).filter(Boolean).join(", "),
      };
    }).sort((a, b) => b.toEquity - a.toEquity);
  }, [outputs]);

  // A run drafted before 0537 has no EQUITY_REGION rows: showing it would put a
  // false zero against every region. Re-draft and it appears.
  if (rows.length === 0 || !outputs.some((r) => r.row_kind === "EQUITY_REGION")) return null;
  const equityName = rows.find((r) => r.equityName)?.equityName || "Equity partner";

  const save = async () => {
    if (!editing) return;
    const v = Number(amount.replace(/[,\s]/g, ""));
    if (amount.trim() === "" || Number.isNaN(v)) return setErr("Enter the profit for the month (commas are fine).");
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("declare_region_profit", {
      p_branch_id: editing.branchId, p_month: month, p_amount: v, p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    setEditing(null);
    await load();
    onDeclared();
  };

  return (
    <section className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border">
        <h3 className="font-display text-base font-bold tracking-tight text-foreground">By region</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          What each region left for {equityName} this month and in total. All operating capital is the equity partner&rsquo;s,
          so a negative total is a region running on that money.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground uppercase">
            <tr>
              <th className="text-left px-4 py-2">Region</th>
              <th className="text-right px-4 py-2">Profit</th>
              <th className="text-right px-4 py-2">Regional partner</th>
              <th className="text-right px-4 py-2">To {equityName}</th>
              <th className="text-right px-4 py-2">Running total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => {
              const isOut = outside.has(r.branchId);
              const dec = declared.get(r.branchId);
              const total = running.get(r.branchId) ?? 0;
              return (
                <tr key={r.branchId}>
                  <td className="px-4 py-2">
                    <div className="text-foreground">{r.name}</div>
                    {isOut && (
                      <div className="text-[11px] text-muted-foreground">
                        Outside the partnership · profit declared{dec ? "" : " — none yet"}
                        {canDeclare && status !== "POSTED" && (
                          <button type="button" className="ml-1.5 font-semibold text-brand-700 dark:text-brand-500 hover:underline"
                            onClick={() => { setErr(null); setAmount(dec ? String(dec.amount) : ""); setNote(dec?.note ?? ""); setEditing({ branchId: r.branchId, name: r.name }); }}>
                            {dec ? "Change" : "Declare"}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className={`px-4 py-2 text-right tabular-nums ${r.profit < 0 ? "text-danger-700" : "text-foreground"}`}
                    title={isOut ? "Declared profit" : `Own ${acct(r.own)} · head office ${acct(r.ho)}`}>
                    {acct(r.profit)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground" title={r.regionalNames}>
                    {isOut ? "—" : acct(r.regional)}
                  </td>
                  <td className={`px-4 py-2 text-right tabular-nums font-semibold ${r.toEquity < 0 ? "text-danger-700" : "text-foreground"}`}>{acct(r.toEquity)}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${total < 0 ? "text-danger-700" : "text-muted-foreground"}`}
                    title={total < 0 ? "This region has used the equity partner's capital" : ""}>
                    {acct(total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 0576/0580: a region outside the partnership (Lahore) is settled client by client. */}
      {rows.filter((r) => outside.has(r.branchId)).map((r) => (
        <ClientClearances key={r.branchId} companyId={companyId} branchId={r.branchId} regionName={r.name}
          canEdit={canDeclare} onChanged={() => { void load(); onDeclared(); }} />
      ))}

      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title={editing ? `${editing.name}: declared profit` : ""} error={err} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </>}>
        {editing && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              The company&rsquo;s profit from {editing.name} for {new Date(`${month}T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}:
              what was kept after sending the region&rsquo;s partner his money. Nothing moves in any bank; it is the
              region&rsquo;s whole contribution to the partnership, all to the equity partner. Re-draft the run afterwards.
            </p>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Profit (PKR) *</label>
              <input className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" inputMode="decimal"
                value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Note</label>
              <input className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
