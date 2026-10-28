import { useCallback, useEffect, useState } from "react";
import { FileDown, Trash2 } from "lucide-react";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { generateFuelSheetPdf, type FuelSheetRow } from "../lib/fuelSheetPdf";

/**
 * One card's month (0582): the balance brought forward, every top-up and every
 * trip with its route, client, km, average and price, and the running balance
 * — read from fuel_card_statement, so this screen adds nothing up. A trip is
 * deleted here (its card bill goes with it). The same rows print as the Fuel
 * Expense Sheet the holder signs.
 */

type Row = FuelSheetRow & { trip_id: string | null; expense_id: string | null };

const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const lastDay = (m: string) => { const [y, mo] = m.split("-").map(Number); return `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, "0")}`; };
const money = (n: number | null | undefined) => (n == null ? "" : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const day = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");

export default function FuelCardStatement({
  card, canEdit, refreshKey, onChanged,
}: {
  card: { fuel_card_id: string; label: string; card_last4: string | null; holder_name: string | null };
  canEdit: boolean;
  /** Bumped by the parent after anything that moves the card. */
  refreshKey: number;
  onChanged: () => void;
}) {
  const { company } = useAuth();
  const [month, setMonth] = useState(ym(new Date()));
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("fuel_card_statement", {
      p_fuel_card_id: card.fuel_card_id, p_from: `${month}-01`, p_to: lastDay(month),
    });
    setLoading(false);
    if (error) { setErr(friendlyDbError(error)); setRows([]); return; }
    setErr(null);
    setRows(((data ?? []) as Row[]).map((r) => ({ ...r, balance: Number(r.balance) })));
  }, [card.fuel_card_id, month]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const remove = async (r: Row) => {
    if (!r.trip_id) return;
    if (!window.confirm(`Delete the trip of ${day(r.entry_date)} (${money(r.spent)})? Its bill on the card goes with it.`)) return;
    const { error } = await supabase.rpc("delete_fuel_trip", { p_trip_id: r.trip_id });
    if (error) return setErr(friendlyDbError(error));
    await load(); onChanged();
  };

  const body = rows.filter((r) => r.kind !== "OPENING_BALANCE");
  const opening = rows.find((r) => r.kind === "OPENING_BALANCE");
  const spent = body.reduce((s, r) => s + Number(r.spent ?? 0), 0);
  const km = body.reduce((s, r) => s + Number(r.km ?? 0), 0);
  const closing = rows.length ? rows[rows.length - 1].balance : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground" aria-label="Month" />
          <span className="text-xs text-muted-foreground">
            {body.filter((r) => r.kind === "TRIP").length} trips{km ? ` · ${km.toLocaleString()} km` : ""} · spent <span className="font-ledger text-foreground">{money(spent)}</span>
          </span>
        </div>
        <Button size="sm" variant="secondary" disabled={!rows.length}
          onClick={() => generateFuelSheetPdf({
            company, cardLabel: card.label, cardLast4: card.card_last4, holder: card.holder_name,
            monthLabel: new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
            from: `${month}-01`, to: lastDay(month), rows,
          })}>
          <FileDown className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Fuel Expense Sheet (PDF)
        </Button>
      </div>
      {err && <p className="text-xs text-danger-700 dark:text-danger-500">{err}</p>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left px-2.5 py-1.5 font-medium">Date</th>
              <th className="text-left px-2.5 py-1.5 font-medium">Route / detail</th>
              <th className="text-left px-2.5 py-1.5 font-medium">Client</th>
              <th className="text-right px-2.5 py-1.5 font-medium">Km</th>
              <th className="text-right px-2.5 py-1.5 font-medium">Avg</th>
              <th className="text-right px-2.5 py-1.5 font-medium">Price</th>
              <th className="text-right px-2.5 py-1.5 font-medium">Amount</th>
              <th className="text-right px-2.5 py-1.5 font-medium">Balance</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {opening && (
              <tr className="bg-muted/20 italic text-muted-foreground">
                <td className="px-2.5 py-1.5" colSpan={7}>Balance brought forward</td>
                <td className="px-2.5 py-1.5 text-right font-ledger not-italic text-foreground">{money(opening.balance)}</td>
                <td />
              </tr>
            )}
            {body.map((r, i) => (
              <tr key={(r.expense_id ?? r.kind) + i}>
                <td className="px-2.5 py-1.5 whitespace-nowrap text-muted-foreground">{day(r.entry_date)}</td>
                <td className="px-2.5 py-1.5 text-foreground">
                  {r.kind === "TOP-UP" && <span className="mr-1.5 rounded bg-up/10 px-1 text-[10px] font-semibold text-up">TOP-UP</span>}
                  {r.kind === "OPENING" && <span className="mr-1.5 rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">OPENING</span>}
                  {r.detail}
                </td>
                <td className="px-2.5 py-1.5 text-muted-foreground">{r.client_name ?? (r.kind === "TRIP" || r.kind === "BILL" ? "General" : "")}</td>
                <td className="px-2.5 py-1.5 text-right font-ledger">{r.km != null ? Number(r.km) : ""}</td>
                <td className="px-2.5 py-1.5 text-right font-ledger text-muted-foreground">{r.km_per_litre != null ? Number(r.km_per_litre) : ""}</td>
                <td className="px-2.5 py-1.5 text-right font-ledger text-muted-foreground">{money(r.petrol_price)}</td>
                <td className={`px-2.5 py-1.5 text-right font-ledger ${r.loaded ? "text-up" : ""}`}>{r.loaded ? `+${money(r.loaded)}` : money(r.spent)}</td>
                <td className={`px-2.5 py-1.5 text-right font-ledger font-semibold ${r.balance < 0 ? "text-down" : ""}`}>{money(r.balance)}</td>
                <td className="px-1.5 py-1.5 text-right">
                  {canEdit && r.trip_id && (
                    <button type="button" className="text-muted-foreground hover:text-foreground" title="Delete this trip" onClick={() => void remove(r)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && body.length === 0 && (
              <tr><td colSpan={9} className="px-2.5 py-3 text-muted-foreground">Nothing on this card in the month.</td></tr>
            )}
          </tbody>
          {body.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-2.5 py-1.5" colSpan={6}>Total spent · closing balance</td>
                <td className="px-2.5 py-1.5 text-right font-ledger">{money(spent)}</td>
                <td className="px-2.5 py-1.5 text-right font-ledger">{money(closing)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
