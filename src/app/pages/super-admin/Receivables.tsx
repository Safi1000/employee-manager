import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// Receivables — §5 regional receivables ownership (aging/DSO, legacy carve-out,
// bad-debt bearer) and §10 invoicing upgrades (reminder cadence engine,
// attendance-based billing suggestion). Surfaces the 0109/0110 backend.

type Tab = "aging" | "reminders" | "writeoff" | "billing" | "settings";

const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const money = (n: any) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function Receivables() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [tab, setTab] = useState<Tab>("aging");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [aging, setAging] = useState<any[]>([]);
  const [reminders, setReminders] = useState<any[]>([]);
  const [openInv, setOpenInv] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [clients, setClients] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [ag, rem, inv, fs, cl] = await Promise.all([
      supabase.from("regional_receivables_aging").select("*").eq("company_id", companyId),
      supabase.from("due_invoice_reminders").select("*").eq("company_id", companyId).order("age_days", { ascending: false }),
      supabase.from("invoices").select("id,invoice_number,invoice_date,total_due,invoice_amount,amount_received,status,client_id")
        .eq("company_id", companyId),
      supabase.from("finance_settings").select("*").eq("company_id", companyId).maybeSingle(),
      supabase.from("clients").select("id,name,workout_account,receivable_owner_branch_id,credit_ceiling,attendance_billing").eq("company_id", companyId).order("name"),
    ]);
    setAging(ag.data ?? []);
    setReminders(rem.data ?? []);
    const open = (inv.data ?? []).filter(
      (i: any) => (Number(i.total_due ?? i.invoice_amount ?? 0) - Number(i.amount_received ?? 0)) > 0 && i.status !== "Written-Off"
    );
    setOpenInv(open);
    setSettings(fs.data);
    setClients(cl.data ?? []);
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setErr(null);
    const { error } = await p;
    setBusy(false);
    if (error) { setErr(error.message); return false; }
    await load();
    return true;
  };

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "—";

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Receivables" subtitle="Regional aging & DSO, reminder cadence, write-offs, attendance billing" />

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {([
          ["aging", "Regional Aging"],
          ["reminders", "Reminder Cadence"],
          ["writeoff", "Write-offs"],
          ["billing", "Attendance Billing"],
          ["settings", "Policy"],
        ] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {label}
          </button>
        ))}
      </div>

      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      {tab === "aging" && (
        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="text-left px-3 py-2">Region</th>
                <th className="text-right px-3 py-2">Current</th>
                <th className="text-right px-3 py-2">31–60</th>
                <th className="text-right px-3 py-2">61–90</th>
                <th className="text-right px-3 py-2">90+</th>
                <th className="text-right px-3 py-2">Total</th>
                <th className="text-right px-3 py-2">DSO (wtd)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {aging.map((r, i) => (
                <tr key={i} className={r.workout_account ? "bg-warning-50" : ""}>
                  <td className="px-3 py-1.5 text-slate-700">
                    {r.region_name ?? "—"}{r.workout_account && <span className="ml-2 text-[10px] uppercase text-warning-700">workout</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{money(r.bucket_current)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{money(r.bucket_31_60)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{money(r.bucket_61_90)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-danger-700">{money(r.bucket_90_plus)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium">{money(r.total_outstanding)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{Number(r.dso_weighted_days ?? 0).toFixed(0)}</td>
                </tr>
              ))}
              {aging.length === 0 && <tr><td colSpan={7} className="px-3 py-3 text-slate-500">No outstanding receivables.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "reminders" && (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">Cadence steps come from Policy ({(settings?.reminder_cadence_days ?? [0, 7, 15, 30, 45]).join(", ")} days). Logging a reminder removes it from this queue.</p>
          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Invoice</th>
                  <th className="text-left px-3 py-2">Client</th>
                  <th className="text-right px-3 py-2">Outstanding</th>
                  <th className="text-right px-3 py-2">Age</th>
                  <th className="text-right px-3 py-2">Due step</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reminders.map((r) => (
                  <tr key={r.invoice_id} className={r.workout_account ? "bg-warning-50" : ""}>
                    <td className="px-3 py-1.5 text-slate-700">{r.invoice_number}</td>
                    <td className="px-3 py-1.5 text-slate-600">{r.client_name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(r.outstanding)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.age_days}d</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">+{r.due_step}</td>
                    <td className="px-3 py-1.5 text-right">
                      <Button variant="secondary" size="sm" disabled={busy}
                        onClick={() => run(supabase.rpc("log_invoice_reminder", { p_invoice_id: r.invoice_id, p_step_day: r.due_step, p_channel: "manual", p_note: null }))}>
                        Mark reminder sent
                      </Button>
                    </td>
                  </tr>
                ))}
                {reminders.length === 0 && <tr><td colSpan={6} className="px-3 py-3 text-slate-500">No reminders due.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "writeoff" && (
        <WriteOffTab openInv={openInv} clientName={clientName} run={run} busy={busy} />
      )}

      {tab === "billing" && (
        <BillingTab companyId={companyId} clients={clients} />
      )}

      {tab === "settings" && (
        <PolicyTab settings={settings} run={run} busy={busy} companyId={companyId} clients={clients} />
      )}
    </div>
  );
}

function WriteOffTab({ openInv, clientName, run, busy }: {
  openInv: any[]; clientName: (id: string) => string;
  run: (p: PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>; busy: boolean;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-md">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
          <tr>
            <th className="text-left px-3 py-2">Invoice</th>
            <th className="text-left px-3 py-2">Client</th>
            <th className="text-right px-3 py-2">Outstanding</th>
            <th className="text-left px-3 py-2 w-1/3">Reason</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {openInv.map((i) => {
            const out = Number(i.total_due ?? i.invoice_amount ?? 0) - Number(i.amount_received ?? 0);
            return (
              <tr key={i.id}>
                <td className="px-3 py-1.5 text-slate-700">{i.invoice_number}</td>
                <td className="px-3 py-1.5 text-slate-600">{clientName(i.client_id)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(out)}</td>
                <td className="px-3 py-1.5">
                  <input className={FIELD + " w-full"} placeholder="Bad-debt reason"
                    value={reasons[i.id] ?? ""} onChange={(e) => setReasons((s) => ({ ...s, [i.id]: e.target.value }))} />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Button variant="danger" size="sm" disabled={busy || !(reasons[i.id] ?? "").trim()}
                    onClick={() => run(supabase.rpc("write_off_receivable", { p_invoice_id: i.id, p_reason: reasons[i.id] }))}>
                    Write off
                  </Button>
                </td>
              </tr>
            );
          })}
          {openInv.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-slate-500">No open invoices to write off.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function BillingTab({ companyId: _companyId, clients }: { companyId: string; clients: any[] }) {
  const [clientId, setClientId] = useState("");
  const today = new Date();
  const [start, setStart] = useState(today.toISOString().slice(0, 8) + "01");
  const [end, setEnd] = useState(today.toISOString().slice(0, 10));
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const compute = async () => {
    if (!clientId) return;
    setBusy(true);
    const { data } = await supabase.rpc("attendance_billing_suggestion", {
      p_client_id: clientId, p_period_start: start, p_period_end: end,
    });
    setBusy(false);
    setRes(Array.isArray(data) ? data[0] : data);
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-xs text-slate-400">Suggests a billable amount from verified attendance guard-days served in the period, pro-rated against the active contract rate (§10).</p>
      <div className="flex items-end gap-2 flex-wrap">
        <div>
          <label className="text-xs text-slate-500 block mb-1">Client</label>
          <ThemedSelect className={FIELD} value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">— client —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </ThemedSelect>
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">From</label>
          <input type="date" className={FIELD} value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">To</label>
          <input type="date" className={FIELD} value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <Button variant="primary" size="sm" disabled={busy || !clientId} onClick={compute}>Compute</Button>
      </div>
      {res && (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Billable guard-days" value={res.billable_guard_days} />
          <Stat label="Standard days" value={res.standard_days} />
          <Stat label="Rate / guard / month" value={`PKR ${money(res.rate_per_guard)}`} />
          <Stat label="Suggested amount" value={`PKR ${money(res.suggested_amount)}`} />
        </div>
      )}
    </div>
  );
}

function PolicyTab({ settings, run, busy, companyId, clients }: {
  settings: any; run: (p: PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>;
  busy: boolean; companyId: string; clients: any[];
}) {
  const [bearer, setBearer] = useState(settings?.bad_debt_bearer ?? "region");
  const [cadence, setCadence] = useState((settings?.reminder_cadence_days ?? [0, 7, 15, 30, 45]).join(", "));
  useEffect(() => {
    setBearer(settings?.bad_debt_bearer ?? "region");
    setCadence((settings?.reminder_cadence_days ?? [0, 7, 15, 30, 45]).join(", "));
  }, [settings]);

  const saveSettings = () => {
    const arr = cadence.split(",").map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n));
    return run(supabase.from("finance_settings").update({
      bad_debt_bearer: bearer, reminder_cadence_days: arr, updated_at: new Date().toISOString(),
    }).eq("company_id", companyId));
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <section className="border border-slate-200 rounded-md p-4 space-y-3">
        <h3 className="text-sm text-slate-900">Bad-debt bearer (D1) & reminder cadence</h3>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600 w-40">Bad debt borne by</label>
          <ThemedSelect className={FIELD} value={bearer} onChange={(e) => setBearer(e.target.value)}>
            <option value="region">Operating region</option>
            <option value="head_office">Head office</option>
          </ThemedSelect>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600 w-40">Reminder cadence (days)</label>
          <input className={FIELD + " flex-1"} value={cadence} onChange={(e) => setCadence(e.target.value)} placeholder="0, 7, 15, 30, 45" />
        </div>
        <Button variant="primary" size="sm" disabled={busy} onClick={saveSettings}>Save policy</Button>
      </section>

      <section className="border border-slate-200 rounded-md p-4 space-y-2">
        <h3 className="text-sm text-slate-900">Client receivable ownership & workout flags (§5)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="text-left px-3 py-2">Client</th>
                <th className="text-center px-3 py-2">Workout</th>
                <th className="text-center px-3 py-2">Attendance billing</th>
                <th className="text-right px-3 py-2">Credit ceiling</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {clients.map((c) => (
                <tr key={c.id}>
                  <td className="px-3 py-1.5 text-slate-700">{c.name}</td>
                  <td className="px-3 py-1.5 text-center">
                    <input type="checkbox" checked={!!c.workout_account}
                      onChange={(e) => run(supabase.from("clients").update({ workout_account: e.target.checked }).eq("id", c.id))} />
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <input type="checkbox" checked={!!c.attendance_billing}
                      onChange={(e) => run(supabase.from("clients").update({ attendance_billing: e.target.checked }).eq("id", c.id))} />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{c.credit_ceiling ? money(c.credit_ceiling) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="border border-slate-200 rounded-md p-3 bg-white">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg text-slate-900 tabular-nums mt-1">{value}</div>
    </div>
  );
}
