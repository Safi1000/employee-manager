import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import Button from "./Button";
import ThemedSelect from "./ThemedSelect";
import { supabase, statutoryRateOn, type StatutoryRate } from "../lib/supabase";
import { saveBlob } from "../lib/saveFile";
import { buildEobiFile, eobiFileName, type EobiFileRow } from "../lib/eobiFile";

/**
 * EOBI CHALLAN (13 Nov 2026, Shayan). Each month GGS pays EOBI for SOME of the
 * people payroll deducted it from — about 100, sometimes more, sometimes
 * fewer (a client may refuse to bear it). So this screen asks one question:
 * of those whose EOBI was deducted this month, whose is paid? The list is
 * exactly the month's payslips with EOBI withheld; ticking builds the bulk
 * upload file the EOBI website takes (lib/eobiFile, byte-checked against
 * GGS's own FAA04781FS_BULK.csv).
 *
 * DECIDED 22 Oct 2026: those not paid stay in the liability. The employer
 * share is a cost only for those paid, on their client. RECORDING the payment
 * per person is DEFERRED to the next step (owed: a challan-lines table and
 * remit_statutory_liability per client) — today the file and the totals.
 *
 * The ticks are a working choice until the payment is recorded, so they are
 * kept per month in this browser only.
 */
type Row = {
  id: string; code: string; name: string; client: string;
  cnic: string | null; eobiNo: string | null; dob: string | null; doj: string | null;
  lastDay: string | null; state: string | null; withheld: number;
  /** Nothing withheld this month (office staff, or left) — GGS bears both shares. */
  notDeducted: boolean;
};

const LEFT = ["left", "terminated", "fired", "absconded", "archived"];
const NOT_DEDUCTED = "Not deducted this month — GGS pays both shares";
const monthLabel = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const fmt = (n: number) => Math.round(n).toLocaleString();
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; };
const storeKey = (m: string) => `eobiChallan.${m.slice(0, 7)}`;

export default function EobiChallan({ companyId, rates }: { companyId: string | null; rates: StatutoryRate[] }) {
  const [month, setMonth] = useState(prevMonth());
  const [months, setMonths] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [reg, setReg] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Months that have EOBI withheld, newest first.
  useEffect(() => {
    if (!companyId) return;
    void supabase.from("payslips").select("period_month").eq("company_id", companyId).gt("eobi", 0)
      .order("period_month", { ascending: false }).limit(2000)
      .then(({ data }) => {
        const ms = [...new Set(((data ?? []) as { period_month: string }[]).map((r) => r.period_month.slice(0, 10)))];
        setMonths(ms);
        if (ms.length && !ms.includes(month)) setMonth(ms[0]);
      });
    void supabase.from("companies").select("eobi_registration_no").eq("id", companyId).maybeSingle()
      .then(({ data }) => setReg((data as { eobi_registration_no?: string | null } | null)?.eobi_registration_no ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    setRows(null); setErr(null);
    void (async () => {
      const { data: ps, error } = await supabase.from("payslips")
        .select("employee_id, eobi").eq("company_id", companyId).eq("period_month", month).gt("eobi", 0);
      if (error) { if (live) setErr(error.message); return; }
      const ids = ((ps ?? []) as { employee_id: string }[]).map((p) => p.employee_id);
      const withheld = new Map(((ps ?? []) as { employee_id: string; eobi: number }[]).map((p) => [p.employee_id, Number(p.eobi)]));
      const COLS = "id, employee_code, full_name, category, cnic_number, eobi_registration_number, date_of_birth, eobi_join_date, join_date, last_working_day, lifecycle_state, clients(name)";
      const toRow = (e: any, notDeducted: boolean): Row => ({
        id: e.id, code: e.employee_code ?? "", name: e.full_name ?? "",
        client: notDeducted ? NOT_DEDUCTED : e.clients?.name ?? "Head office / office staff",
        cnic: e.cnic_number ?? null, eobiNo: (e.eobi_registration_number ?? "").trim() || null, dob: e.date_of_birth ?? null,
        doj: e.eobi_join_date ?? e.join_date ?? null, lastDay: e.last_working_day ?? null, state: e.lifecycle_state ?? null,
        withheld: withheld.get(e.id) ?? 0, notDeducted,
      });
      const out: Row[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data: es, error: e2 } = await supabase.from("employees").select(COLS).in("id", ids.slice(i, i + 200));
        if (e2) { if (live) setErr(e2.message); return; }
        for (const e of (es ?? []) as any[]) out.push(toRow(e, false));
      }
      // 13 Nov 2026 (Shayan): EOBI is also paid for people nothing was withheld
      // from — office staff (not on payroll) and guards who have left. Anyone
      // registered (an EOBI number) who is not already above; GGS bears both shares.
      const { data: reg2, error: e3 } = await supabase.from("employees").select(COLS)
        .eq("company_id", companyId).not("eobi_registration_number", "is", null).neq("eobi_registration_number", "");
      if (e3) { if (live) setErr(e3.message); return; }
      const have = new Set(ids);
      for (const e of (reg2 ?? []) as any[]) if (!have.has(e.id)) out.push(toRow(e, true));
      if (!live) return;
      out.sort((a, b) => Number(a.notDeducted) - Number(b.notDeducted) || a.client.localeCompare(b.client) || a.name.localeCompare(b.name));
      setRows(out);
      // Last choice for this month, else everyone who has an EOBI number.
      // Saved: the ticks AND who had been shown, so someone who only became
      // eligible since (an EOBI number filled in) gets the default, not "unticked".
      let saved: { picked: string[]; seen: string[] } | null = null;
      try {
        const raw = JSON.parse(localStorage.getItem(storeKey(month)) ?? "null");
        saved = raw && Array.isArray(raw.picked) ? raw : null;
      } catch { saved = null; }
      const can = new Set(out.filter(fileable).map((r) => r.id));
      // Default: has an EOBI number; not-deducted people only when working (office staff) — those who left are ticked by hand.
      const byDefault = (r: Row) => fileable(r) && !!r.eobiNo && (!r.notDeducted || !LEFT.includes(String(r.state ?? "")));
      const seen = new Set(saved?.seen ?? []);
      setPicked(new Set([
        ...(saved?.picked ?? []).filter((id) => can.has(id)),
        ...out.filter((r) => !seen.has(`${r.id}:${r.eobiNo ?? ""}`) && byDefault(r)).map((r) => r.id),
      ]));
    })();
    return () => { live = false; };
  }, [companyId, month]);

  useEffect(() => {
    if (!rows) return;
    try {
      localStorage.setItem(storeKey(month), JSON.stringify({ picked: [...picked], seen: rows.map((r) => `${r.id}:${r.eobiNo ?? ""}`) }));
    } catch { /* convenience only */ }
  }, [picked, rows, month]);

  const rate = statutoryRateOn(rates, "eobi", month);
  const toggle = (ids: string[], on: boolean) => setPicked((p) => { const n = new Set(p); for (const id of ids) on ? n.add(id) : n.delete(id); return n; });

  const shown = useMemo(() => (rows ?? []).filter((r) => {
    const s = q.trim().toLowerCase();
    return !s || r.name.toLowerCase().includes(s) || r.code.toLowerCase().includes(s) || r.client.toLowerCase().includes(s);
  }), [rows, q]);
  const groups = useMemo(() => [...shown.reduce((m, r) => m.set(r.client, [...(m.get(r.client) ?? []), r]), new Map<string, Row[]>())]
    .sort((a, b) => Number(a[0] === NOT_DEDUCTED) - Number(b[0] === NOT_DEDUCTED) || b[1].length - a[1].length), [shown]);

  const chosen = (rows ?? []).filter((r) => picked.has(r.id));
  const notChosen = (rows ?? []).filter((r) => !picked.has(r.id));
  const empShare = (rate?.employee_amount ?? 0) * chosen.length;
  const erShare = (rate?.employer_amount ?? 0) * chosen.length;
  const leftOwed = notChosen.reduce((n, r) => n + r.withheld, 0);
  const chosenNotDeducted = chosen.filter((r) => r.notDeducted).length;

  const download = async () => {
    if (!reg) return setErr("The company's EOBI registration number is not set.");
    if (chosen.length === 0) return setErr("Tick at least one person.");
    setSaving(true); setErr(null);
    try {
      const fileRows: EobiFileRow[] = chosen.map((r) => ({ name: r.name, eobiNo: r.eobiNo ?? "", cnic: r.cnic ?? "", dob: r.dob, doj: r.doj, exit: r.lastDay }));
      const text = buildEobiFile(reg, month, fileRows);
      await saveBlob(new Blob([text], { type: "text/csv" }), eobiFileName(reg));
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    setSaving(false);
  };

  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0 mr-auto">
          <h3 className="text-sm font-semibold text-foreground">EOBI challan — whose EOBI is paid</h3>
          <p className="text-xs text-muted-foreground">From everyone EOBI was deducted from that month. Ticking builds the file for the EOBI website.</p>
        </div>
        <ThemedSelect value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Contribution month" className="px-3 py-1.5 border border-border rounded-lg text-sm bg-card">
          {(months.length ? months : [month]).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </ThemedSelect>
        <Button size="sm" disabled={saving || !rows || chosen.length === 0} onClick={() => void download()}>
          {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Download className="w-4 h-4 mr-1.5" strokeWidth={1.5} />}
          EOBI file ({chosen.length})
        </Button>
      </div>

      {/* What the challan should read — compare with EOBI's payment slip. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border-b border-border">
        {[
          { l: "Insured persons", v: String(chosen.length), s: chosenNotDeducted ? `${chosen.length - chosenNotDeducted} deducted + ${chosenNotDeducted} not deducted` : `of ${(rows ?? []).filter((r) => !r.notDeducted).length} deducted` },
          { l: "Employee share", v: fmt(empShare), s: rate ? `${fmt(rate.employee_amount)} × ${chosen.length}` : "rate not set" },
          { l: "Employer share", v: fmt(erShare), s: rate ? `${fmt(rate.employer_amount)} × ${chosen.length}${chosenNotDeducted ? ` · GGS also bears ${fmt(rate.employee_amount * chosenNotDeducted)} of employee share` : " · cost on their clients"}` : "" },
          { l: "Challan total", v: fmt(empShare + erShare), s: notChosen.length ? `${notChosen.length} not paid · ${fmt(leftOwed)} stays owed` : "everyone deducted is paid" },
        ].map((t) => (
          <div key={t.l} className="bg-card px-4 py-2.5">
            <p className="lbl">{t.l}</p>
            <p className="font-ledger text-lg text-foreground">{t.v}</p>
            <p className="text-[11px] text-muted-foreground">{t.s}</p>
          </div>
        ))}
      </div>

      {err && <p className="px-4 pt-3 text-sm text-danger-700 dark:text-danger-500">{err}</p>}
      {!reg && rows && <p className="px-4 pt-3 text-sm text-heed">The company's EOBI registration (e.g. FAA04781) is not set, so the file cannot be built.</p>}

      <div className="px-4 py-3 flex flex-col gap-3">
        <input className="w-64 max-w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm" placeholder="Search a name, code or client" value={q} onChange={(e) => setQ(e.target.value)} />
        {!rows ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading {monthLabel(month)}…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No EOBI was deducted in {monthLabel(month)}.</p>
        ) : groups.map(([g, list]) => {
          const can = list.filter(fileable);
          const on = list.filter((r) => picked.has(r.id)).length;
          return (
            <div key={g} className="rounded-lg border border-border">
              <div className="flex flex-wrap items-center gap-3 px-3 py-1.5 bg-muted/40 text-sm">
                <input type="checkbox" className="accent-brand-600" aria-label={`Pay EOBI for everyone at ${g}`}
                  checked={can.length > 0 && can.every((r) => picked.has(r.id))}
                  ref={(el) => { if (el) el.indeterminate = on > 0 && on < can.length; }}
                  disabled={can.length === 0} onChange={(e) => toggle(can.map((r) => r.id), e.target.checked)} />
                <span className="font-medium text-foreground flex-1 min-w-0 truncate">{g}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{on} of {list.length} paid</span>
              </div>
              <ul className="divide-y divide-border text-sm">
                {list.map((r) => {
                  const fl = flagsOf(r, month);
                  const ok = fileable(r);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1">
                      <input type="checkbox" className="accent-brand-600" checked={picked.has(r.id)} disabled={!ok}
                        aria-label={`Pay EOBI for ${r.name}`} onChange={(e) => toggle([r.id], e.target.checked)} />
                      <span className={`flex-1 min-w-0 truncate ${picked.has(r.id) ? "text-foreground" : "text-muted-foreground"}`}>
                        {r.name} <span className="font-mono text-[11px] text-muted-foreground">{r.code}</span>
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">{r.eobiNo ?? ""}</span>
                      {fl.map((f) => (
                        <span key={f.t} className={`text-[11px] rounded px-1.5 py-0.5 ${f.hard ? "bg-danger-50 text-danger-700 dark:bg-danger-500/10 dark:text-danger-500" : "bg-warning-50 text-heed"}`}>{f.t}</span>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A row the EOBI file can carry: it needs a CNIC. (No EOBI no. is allowed — new registrations go in without one.) */
function fileable(r: Row): boolean {
  return !!r.cnic && r.cnic.replace(/\D/g, "").length === 13;
}

function flagsOf(r: Row, month: string): { t: string; hard: boolean }[] {
  const out: { t: string; hard: boolean }[] = [];
  if (!fileable(r)) out.push({ t: "no valid CNIC — cannot go in the file", hard: true });
  if (!r.eobiNo) out.push({ t: "no EOBI no.", hard: false });
  if (!r.dob) out.push({ t: "no date of birth", hard: false });
  if (LEFT.includes(String(r.state ?? ""))) out.push({ t: String(r.state), hard: false });
  if (r.dob) {
    const b = new Date(`${r.dob}T00:00:00`), m = new Date(`${month.slice(0, 7)}-01T00:00:00`);
    const age = m.getFullYear() - b.getFullYear() - (m < new Date(m.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
    if (age >= 60) out.push({ t: `age ${age}`, hard: false });
  }
  return out;
}
