import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronRight, Download, Loader2 } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError, statutoryRateOn, type StatutoryRate } from "../lib/supabase";
import { loadCustodianOptions, ensureCustodianLocation, type CustodianOption } from "../lib/custodian";
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
  /** His own client (the group label above may be the not-deducted group). */
  realClient: string;
};
type Recorded = { id: string; paid_on: string; paid_via: string; bank: string | null; reference: string | null; amount: number; ids: Set<string>; others: string[] };

const LEFT = ["left", "terminated", "fired", "absconded", "archived"];
const NOT_DEDUCTED = "Not deducted this month — GGS pays both shares";
const monthLabel = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const fmt = (n: number) => Math.round(n).toLocaleString();
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; };
// v2: the default changed on 13 Nov 2026, so earlier saved ticks are not reused.
const storeKey = (m: string) => `eobiChallan.v2.${m.slice(0, 7)}`;
/** DECIDED 13 Nov 2026 (Shayan): October 2026's EOBI was paid INCLUDING the guards
 *  who had left, so for that month they start ticked. From November each one who
 *  has left starts unticked and is confirmed by hand before payment. */
const PAID_WITH_LEAVERS = new Set(["2026-10"]);

export default function EobiChallan({ companyId, rates }: { companyId: string | null; rates: StatutoryRate[] }) {
  const [month, setMonth] = useState(prevMonth());
  const [months, setMonths] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [reg, setReg] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  // Clients start collapsed (13 Nov 2026, Shayan: "people in it only if I expand").
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [monthCount, setMonthCount] = useState<Map<string, number>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 0671: a recorded challan for the month — shown as paid; its people are fixed.
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [recKey, setRecKey] = useState(0);
  const [payOpen, setPayOpen] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [banks, setBanks] = useState<{ id: string; bank_name: string; account_number: string | null }[]>([]);
  const [custodians, setCustodians] = useState<CustodianOption[]>([]);
  const [pay, setPay] = useState<{ on: string; via: "Bank" | "Cash"; bank: string; cust: string; ref: string }>(
    { on: new Date().toISOString().slice(0, 10), via: "Bank", bank: "", cust: "", ref: "" });

  // Months that have EOBI withheld, newest first.
  useEffect(() => {
    if (!companyId) return;
    void supabase.from("payslips").select("period_month").eq("company_id", companyId).gt("eobi", 0)
      .order("period_month", { ascending: false }).limit(2000)
      .then(({ data }) => {
        const all = ((data ?? []) as { period_month: string }[]).map((r) => r.period_month.slice(0, 10));
        const ms = [...new Set(all)];
        setMonths(ms);
        setMonthCount(all.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>()));
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
        realClient: e.clients?.name ?? "Head office",
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
      const leaversIn = PAID_WITH_LEAVERS.has(month.slice(0, 7));
      const byDefault = (r: Row) => fileable(r) && !!r.eobiNo
        && (!r.notDeducted || leaversIn || !LEFT.includes(String(r.state ?? "")));
      const seen = new Set(saved?.seen ?? []);
      setPicked(new Set([
        ...(saved?.picked ?? []).filter((id) => can.has(id)),
        ...out.filter((r) => !seen.has(`${r.id}:${r.eobiNo ?? ""}`) && byDefault(r)).map((r) => r.id),
      ]));
    })();
    return () => { live = false; };
  }, [companyId, month]);

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    setRecorded(null);
    void (async () => {
      const { data: ls } = await supabase.from("statutory_remittance_lines")
        .select("remittance_id, employee_id, other_name").eq("company_id", companyId).eq("scheme", "eobi").eq("period_month", month);
      const lines = (ls ?? []) as { remittance_id: string; employee_id: string | null; other_name: string | null }[];
      if (!live || lines.length === 0) return;
      const { data: rm } = await supabase.from("statutory_remittances")
        .select("id, paid_on, paid_via, reference, amount, bank_accounts(bank_name)").in("id", [...new Set(lines.map((l) => l.remittance_id))]);
      const r = ((rm ?? []) as any[])[0];
      if (!live || !r) return;
      setRecorded({
        id: r.id, paid_on: r.paid_on, paid_via: r.paid_via, bank: r.bank_accounts?.bank_name ?? null, reference: r.reference ?? null,
        amount: ((rm ?? []) as any[]).reduce((n, x) => n + Number(x.amount), 0),
        ids: new Set(lines.filter((l) => l.employee_id).map((l) => l.employee_id!)),
        others: lines.filter((l) => l.other_name).map((l) => l.other_name!),
      });
    })();
    return () => { live = false; };
  }, [companyId, month, recKey]);

  // A recorded month shows exactly who was paid for.
  useEffect(() => { if (recorded) setPicked(new Set(recorded.ids)); }, [recorded]);

  useEffect(() => {
    if (!rows || recorded) return;
    try {
      localStorage.setItem(storeKey(month), JSON.stringify({ picked: [...picked], seen: rows.map((r) => `${r.id}:${r.eobiNo ?? ""}`) }));
    } catch { /* convenience only */ }
  }, [picked, rows, month]);

  const rate = statutoryRateOn(rates, "eobi", month);
  const toggle = (ids: string[], on: boolean) => { if (recorded) return; setPicked((p) => { const n = new Set(p); for (const id of ids) on ? n.add(id) : n.delete(id); return n; }); };

  const openPay = async () => {
    setPayErr(null); setPayOpen(true);
    if (!companyId) return;
    const [{ data: b }, c] = await Promise.all([
      supabase.from("bank_accounts").select("id, bank_name, account_number, active").eq("company_id", companyId).order("bank_name"),
      loadCustodianOptions(companyId, false).catch(() => [] as CustodianOption[]),
    ]);
    setBanks(((b ?? []) as any[]).filter((x) => x.active !== false));
    setCustodians(c);
  };
  const recordPay = async () => {
    if (!companyId) return;
    if (pay.via === "Bank" && !pay.bank) return setPayErr("Choose the bank it was paid from.");
    if (pay.via === "Cash" && !pay.cust) return setPayErr("Choose who paid it in cash.");
    setPaying(true); setPayErr(null);
    try {
      let loc: string | null = null;
      if (pay.via === "Cash") {
        const st = custodians.find((x) => x.employeeId === pay.cust);
        if (!st) throw new Error("Custodian not found — reload and try again.");
        loc = st.locationId ?? await ensureCustodianLocation(companyId, st.employeeId, st.fullName, st.kind);
      }
      const { error } = await supabase.rpc("record_statutory_challan", {
        p_company_id: companyId, p_scheme: "eobi", p_period: month, p_paid_via: pay.via,
        p_bank_account_id: pay.via === "Bank" ? pay.bank : null, p_custodian_location_id: loc,
        p_paid_on: pay.on, p_reference: pay.ref.trim() || null,
        p_employee_ids: chosen.map((r) => r.id), p_others: [], p_expected_total: empShare + erShare,
      });
      if (error) throw new Error(friendlyDbError(error));
      setPayOpen(false); setRecKey((k) => k + 1);
    } catch (e: any) { setPayErr(e?.message ?? String(e)); }
    setPaying(false);
  };

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
    <section id="eobi-challan" className="rounded-2xl border border-border bg-card overflow-hidden scroll-mt-24">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0 mr-auto">
          <h3 className="text-sm font-semibold text-foreground">EOBI challan · {monthLabel(month)} salaries</h3>
          <p className="text-xs text-muted-foreground">Contribution for {monthLabel(month)}, paid the month after. Tick whose EOBI is paid; the file is what the EOBI website takes.</p>
        </div>
        <ThemedSelect value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Contribution month" className="px-3 py-1.5 border border-border rounded-lg text-sm bg-card">
          {(months.length ? months : [month]).map((m) => (
            <option key={m} value={m}>{monthLabel(m)} salaries{monthCount.get(m) ? ` · ${monthCount.get(m)} deducted` : ""}</option>
          ))}
        </ThemedSelect>
        <Button size="sm" variant="secondary" disabled={saving || !rows || chosen.length === 0} onClick={() => void download()}>
          {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Download className="w-4 h-4 mr-1.5" strokeWidth={1.5} />}
          EOBI file ({chosen.length})
        </Button>
        {!recorded && (
          <Button size="sm" disabled={!rows || chosen.length === 0 || !rate} onClick={() => void openPay()}>
            Record payment · {fmt(empShare + erShare)}
          </Button>
        )}
      </div>
      {recorded && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border bg-success-50 dark:bg-success-500/10 text-sm text-success-700 dark:text-success-500">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>
            Paid {new Date(`${recorded.paid_on}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
            {" · "}PKR {fmt(recorded.amount)} · {recorded.paid_via === "Bank" ? recorded.bank ?? "bank" : "cash"}
            {recorded.reference ? ` · voucher ${recorded.reference}` : ""} · {recorded.ids.size + recorded.others.length} insured. The people below are the ones it paid for.
          </span>
        </div>
      )}

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
        <div className="flex flex-wrap items-center gap-3">
          <input className="w-64 max-w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm" placeholder="Search a name, code or client" value={q} onChange={(e) => setQ(e.target.value)} />
          {groups.length > 0 && (
            <button type="button" className="text-xs text-brand-700 dark:text-brand-500 hover:underline"
              onClick={() => setOpen(open.size >= groups.length ? new Set() : new Set(groups.map(([g]) => g)))}>
              {open.size >= groups.length ? "Collapse all" : "Expand all"}
            </button>
          )}
        </div>
        {!rows ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading {monthLabel(month)}…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No EOBI was deducted in {monthLabel(month)}.</p>
        ) : groups.map(([g, list]) => {
          const can = list.filter(fileable);
          const on = list.filter((r) => picked.has(r.id)).length;
          const flagged = list.filter((r) => flagsOf(r, month).some((f) => f.hard || f.t !== "no EOBI no.")).length;
          const isOpen = open.has(g) || !!q.trim();
          const perHead = (rate?.employee_amount ?? 0) + (rate?.employer_amount ?? 0);
          return (
            <div key={g} className="rounded-lg border border-border overflow-hidden">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 bg-muted/40 text-sm">
                <input type="checkbox" className="accent-brand-600" aria-label={`Pay EOBI for everyone at ${g}`}
                  checked={can.length > 0 && can.every((r) => picked.has(r.id))}
                  ref={(el) => { if (el) el.indeterminate = on > 0 && on < can.length; }}
                  disabled={can.length === 0} onChange={(e) => toggle(can.map((r) => r.id), e.target.checked)} />
                <button type="button" aria-expanded={isOpen} onClick={() => setOpen((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n; })}
                  className="flex flex-1 min-w-0 items-center gap-2 text-left">
                  <ChevronRight className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  <span className="font-medium text-foreground truncate">{g}</span>
                </button>
                <span className="text-xs text-muted-foreground tabular-nums basis-full sm:basis-auto pl-7 sm:pl-0">
                  <span className="text-foreground font-medium">{on}</span> of {list.length} paid
                  {list.length - on > 0 ? ` · ${list.length - on} not` : ""}
                  {flagged ? ` · ${flagged} flagged` : ""}
                  {(() => { const lv = list.filter((r) => LEFT.includes(String(r.state ?? "")) && !picked.has(r.id)).length;
                    return lv ? ` · ${lv} who left — confirm each` : ""; })()}
                  {on && perHead ? ` · PKR ${fmt(on * perHead)}` : ""}
                </span>
              </div>
              {isOpen && <ul className="divide-y divide-border text-sm">
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
              </ul>}
            </div>
          );
        })}
      </div>

      <Modal isOpen={payOpen} onClose={() => !paying && setPayOpen(false)} title={`Record EOBI payment · ${monthLabel(month)}`}
        error={payErr} onDismissError={() => setPayErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setPayOpen(false)} disabled={paying}>Cancel</Button>
          <Button onClick={() => void recordPay()} disabled={paying}>{paying ? "Recording…" : `Record ${fmt(empShare + erShare)} paid`}</Button>
        </>}>
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted-foreground">This is the challan you built: who is ticked, and what it comes to. Check it matches EOBI's payment slip, say where it was paid from, and record it.</p>
          <div className="grid grid-cols-3 gap-2">
            {[["Insured", String(chosen.length)], ["Employee share", fmt(empShare)], ["Employer share", fmt(erShare)]].map(([l, v]) => (
              <div key={l} className="rounded-lg border border-border px-3 py-2"><p className="lbl">{l}</p><p className="font-ledger text-base text-foreground">{v}</p></div>
            ))}
          </div>
          {(() => {
            const emp = rate?.employee_amount ?? 0, head = (rate?.employee_amount ?? 0) + (rate?.employer_amount ?? 0);
            const settled = chosen.reduce((n, r) => n + Math.min(r.withheld, emp), 0);
            const byClient = [...chosen.reduce((m, r) => m.set(r.realClient, (m.get(r.realClient) ?? 0) + head - Math.min(r.withheld, emp)), new Map<string, number>())]
              .sort((a, b) => b[1] - a[1]);
            return (
              <div className="rounded-lg border border-border divide-y divide-border">
                <div className="flex justify-between px-3 py-1.5"><span>Deducted from their salaries — passed on to EOBI</span><span className="font-ledger">{fmt(settled)}</span></div>
                <div className="px-3 py-1.5">
                  <div className="flex justify-between"><span>GGS's own cost</span><span className="font-ledger">{fmt(empShare + erShare - settled)}</span></div>
                  {byClient.map(([c, v]) => <div key={c} className="flex justify-between text-xs text-muted-foreground pl-3"><span>{c}</span><span className="font-ledger">{fmt(v)}</span></div>)}
                </div>
                <div className="flex justify-between px-3 py-1.5 font-medium"><span>Paid to EOBI</span><span className="font-ledger">{fmt(empShare + erShare)}</span></div>
                {leftOwed > 0 && <div className="px-3 py-1.5 text-xs text-muted-foreground">{fmt(leftOwed)} deducted from the {notChosen.filter((r) => r.withheld > 0).length} not paid for stays owed.</div>}
              </div>
            );
          })()}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Paid on</label>
              <input type="date" className="w-full rounded-lg border border-border bg-background px-3 py-2" value={pay.on} max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setPay((x) => ({ ...x, on: e.target.value }))} />
            </div>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Voucher no. (on EOBI's slip)</label>
              <input className="w-full rounded-lg border border-border bg-background px-3 py-2" value={pay.ref} placeholder="e.g. 1003270632"
                onChange={(e) => setPay((x) => ({ ...x, ref: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-1 rounded-lg bg-muted p-1 text-xs w-fit">
            {(["Bank", "Cash"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={pay.via === v} onClick={() => setPay((x) => ({ ...x, via: v }))}
                className={`px-3 py-1 rounded-md ${pay.via === v ? "bg-card text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}>{v}</button>
            ))}
          </div>
          {pay.via === "Bank" ? (
            <ThemedSelect value={pay.bank} onChange={(e) => setPay((x) => ({ ...x, bank: e.target.value }))} aria-label="Paid from bank">
              <option value="">Paid from which bank…</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.bank_name}{b.account_number ? ` · ${b.account_number}` : ""}</option>)}
            </ThemedSelect>
          ) : (
            <ThemedSelect value={pay.cust} onChange={(e) => setPay((x) => ({ ...x, cust: e.target.value }))} aria-label="Paid in cash by">
              <option value="">Paid in cash by…</option>
              {custodians.map((c) => <option key={c.employeeId} value={c.employeeId}>{c.fullName}</option>)}
            </ThemedSelect>
          )}
          <p className="text-[11px] text-muted-foreground">Recording takes {fmt(empShare + erShare)} out of that {pay.via === "Bank" ? "bank" : "person's cash"} in Bastion once. Record a challan only once.</p>
        </div>
      </Modal>
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
