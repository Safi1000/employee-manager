import { useEffect, useMemo, useRef, useState } from "react";
import { Check, History, Plus, Search, Trash2, Users } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";
import { PK_BANKS, isPkWallet, validateWalletAccount } from "../lib/validation";
import { formatDate } from "../lib/date";
import { FormField, Hint, ModalFooter } from "../pages/super-admin/_assetsKit";

/**
 * 0662: put payslips in transit on iNet. Nothing is paid and no bank moves
 * until someone else releases the batch on Bank & Ledgers ▸ iNet releases.
 * Askari payees and other-bank payees become two batches (two upload files).
 *
 * 0667 (Shayan, 12 Nov 2026): before initiating, every payee is checked. The
 * ones who cannot go in the file (no IBAN, no account — most of MIU) can be
 * paid to receivers, THIS TIME ONLY — one or more (MIU went to two receivers
 * the same day), each guard assigned to one or left out — with
 * a line saying where their salary went last time, and as one row per guard
 * or one combined transfer per receiver.
 */
export type InetInitiateItem = { payslipId: string; employeeId: string; name: string; amount: number };

type Check = { problem: string | null };
type Staff = { id: string; full_name: string; code: string | null; client: string | null; bank_name: string | null; bank_account: string | null; iban: string | null; account_title: string | null };
type Receiver = { name: string; staffId?: string; bank: string; account: string; iban: string };
type Past = { employee_id: string; payee_name: string; bank_name: string; account_no: string | null; iban: string | null; set_at: string };

const input = "w-full px-3 py-2 rounded-lg border border-border bg-background text-sm";
const blank = (): Receiver => ({ name: "", bank: "", account: "", iban: "" });
const acctKey = (r: { account_no?: string | null; iban?: string | null; account?: string; payee_name?: string; name?: string }) =>
  `${(r.payee_name ?? r.name ?? "").trim().toUpperCase()}|${(r.iban || r.account_no || r.account || "").toUpperCase().replace(/[^0-9A-Z]/g, "")}`;

export default function InetInitiateModal({ bankId, bankName, items, defaultLabel, defaultReference, onClose, onDone }: {
  bankId: string;
  bankName: string;
  items: InetInitiateItem[];
  defaultLabel: string;
  defaultReference: string;
  onClose: () => void;
  onDone: (summary: string) => void;
}) {
  const [label, setLabel] = useState(defaultLabel);
  const [reference, setReference] = useState(defaultReference);
  const [date, setDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Pre-check: who can go in the file.
  const [checks, setChecks] = useState<Map<string, Check> | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all(items.map(async (i) => {
      const { data, error } = await supabase.rpc("inet_payee", { p_employee_id: i.employeeId, p_bank_account_id: bankId });
      const r = (Array.isArray(data) ? data[0] : data) as { problem: string | null } | null;
      return [i.payslipId, { problem: error ? friendlyDbError(error) : r?.problem ?? null }] as const;
    })).then((rows) => { if (live) setChecks(new Map(rows)); });
    return () => { live = false; };
  }, [items, bankId]);
  const refused = useMemo(() => items.filter((i) => checks?.get(i.payslipId)?.problem), [items, checks]);

  // Receivers, and which receiver each refused guard goes to (-1 = left out).
  const [receivers, setReceivers] = useState<Receiver[]>([blank()]);
  const [assign, setAssign] = useState<Map<string, number>>(new Map());
  useEffect(() => { setAssign(new Map(refused.map((i) => [i.payslipId, 0]))); }, [refused]);
  const [reason, setReason] = useState("No bank account — paid through the site supervisor");
  const [combined, setCombined] = useState(true);

  const [staff, setStaff] = useState<Staff[]>([]);
  const [past, setPast] = useState<Past[]>([]);
  useEffect(() => {
    if (!refused.length) return;
    // The GGS code (employee_code), not the client's own guard code.
    void supabase.from("employees").select("id, full_name, employee_code, bank_name, bank_account, iban, account_title, clients(name)")
      .eq("status", "Active").order("full_name")
      .then(({ data }) => setStaff(((data ?? []) as unknown as (Omit<Staff, "code" | "client"> & { employee_code: string | null; clients: { name: string } | null })[])
        .map((e) => ({ ...e, code: e.employee_code, client: e.clients?.name ?? null }))));
    void supabase.from("salary_payees").select("employee_id, payee_name, bank_name, account_no, iban, set_at")
      .in("employee_id", refused.map((i) => i.employeeId)).order("set_at", { ascending: false })
      .then(({ data }) => setPast((data ?? []) as Past[]));
  }, [refused]);

  // Where each of these guards' salary went last time.
  const lastTime = useMemo(() => {
    const latest = new Map<string, Past>();
    for (const p of past) if (!latest.has(p.employee_id)) latest.set(p.employee_id, p);
    const groups = new Map<string, { r: Past; n: number }>();
    for (const p of latest.values()) { const k = acctKey(p); const g = groups.get(k); if (g) g.n += 1; else groups.set(k, { r: p, n: 1 }); }
    return { latest, groups: [...groups.values()].sort((a, b) => b.n - a.n) };
  }, [past]);

  const useLastTime = () => {
    const rs = lastTime.groups.map((g) => ({ name: g.r.payee_name, bank: g.r.bank_name, account: g.r.account_no ?? "", iban: g.r.iban ?? "" }));
    if (!rs.length) return;
    const idx = new Map(lastTime.groups.map((g, i) => [acctKey(g.r), i]));
    setReceivers(rs);
    setAssign(new Map(refused.map((i) => {
      const p = lastTime.latest.get(i.employeeId);
      return [i.payslipId, p ? idx.get(acctKey(p)) ?? 0 : 0];
    })));
  };

  const setR = (k: number, patch: Partial<Receiver>) => setReceivers((rs) => rs.map((r, i) => (i === k ? { ...r, ...patch } : r)));
  const pickStaff = (k: number, s: Staff) =>
    setR(k, { name: s.account_title?.trim() || s.full_name, staffId: s.id, bank: s.bank_name ?? "", account: s.bank_account ?? "", iban: s.iban ?? "" });
  const removeR = (k: number) => {
    setReceivers((rs) => rs.filter((_, i) => i !== k));
    setAssign((m) => new Map([...m].map(([id, v]) => [id, v === k ? -1 : v > k ? v - 1 : v])));
  };

  const guardsOf = (k: number) => refused.filter((i) => assign.get(i.payslipId) === k);
  const rProblem = (r: Receiver, k: number): string | null => {
    if (!guardsOf(k).length) return null;
    const wallet = isPkWallet(r.bank);
    if (!r.name.trim()) return "Name the receiver.";
    if (!r.bank) return "Choose the bank or wallet.";
    if (wallet) return r.account.trim() ? validateWalletAccount(r.account, r.bank) : "Enter the mobile number.";
    if (!r.account.trim() && !r.iban.trim()) return "Enter the account number or IBAN.";
    return null;
  };
  const used = receivers.map((_, k) => guardsOf(k).length > 0);
  const receiversReady = receivers.every((r, k) => !rProblem(r, k)) && (!used.some(Boolean) || reason.trim().length >= 5);
  const sending = items.filter((i) => !checks?.get(i.payslipId)?.problem || (assign.get(i.payslipId) ?? -1) >= 0);
  const leftOut = refused.filter((i) => (assign.get(i.payslipId) ?? -1) < 0);
  const total = sending.reduce((s, i) => s + Math.round(i.amount), 0);
  const usingPayTo = used.some(Boolean);
  const nameOf = (k: number) => receivers[k]?.name.trim() || `Receiver ${k + 1}`;

  const submit = async () => {
    setBusy(true); setErr(null);
    const base = {
      p_bank_account_id: bankId,
      p_label: label.trim(),
      p_reference: reference.trim(),
      p_transaction_date: date,
      p_items: sending.map((i) => ({ payslip_id: i.payslipId, amount: Math.round(i.amount) })),
    };
    const payTo = receivers.map((r, k) => ({
      payee_name: r.name.trim(), bank_name: r.bank, account_no: r.account.trim() || null,
      iban: isPkWallet(r.bank) ? null : r.iban.trim() || null, reason: reason.trim(),
      payslip_ids: guardsOf(k).map((i) => i.payslipId),
    })).filter((r) => r.payslip_ids.length);
    const { data, error } = usingPayTo
      ? await supabase.rpc("initiate_inet_payslips_to", { ...base, p_pay_to: payTo, p_combined: combined })
      : await supabase.rpc("initiate_inet_payslips", base);
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    const r = data as { items: number; batches: Record<string, string>; paid_to?: number };
    const kinds = Object.keys(r.batches ?? {}).map((k) => (k === "FT" ? `${bankName.split(" ")[0]} accounts` : k === "IBFT" ? "other banks" : "keyed by hand"));
    onDone(`${r.items} payslip${r.items === 1 ? "" : "s"} in transit on ${bankName} (${kinds.join(" + ")})`
      + (r.paid_to ? `, ${r.paid_to} paid to ${payTo.map((p) => p.payee_name).join(" and ")}${combined ? " as one transfer each" : ""}` : "")
      + (leftOut.length ? `; ${leftOut.length} left out` : "")
      + `. Download the file${kinds.length > 1 ? "s" : ""} on Bank & Ledgers ▸ iNet releases.`);
  };

  return (
    <Modal isOpen onClose={onClose} title={`Initiate on ${bankName} iNet`} size={refused.length ? "lg" : "sm"} error={err} onDismissError={() => setErr(null)}
      footer={
        <ModalFooter summary={<>{sending.length} payslip{sending.length === 1 ? "" : "s"} · PKR {total.toLocaleString()}{leftOut.length ? ` · ${leftOut.length} left out` : ""}</>}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !checks || !label.trim() || !date || !sending.length || !receiversReady}>
            {busy ? "Initiating…" : !checks ? "Checking…" : "Initiate"}
          </Button>
        </ModalFooter>
      }>
      <div className="space-y-4">
        <Hint tone="info">
          Nothing is paid yet. The payslips show <span className="font-semibold">In transit</span> and the bank does not move
          until someone else releases the batch with the total the bank sent.
        </Hint>

        {checks && refused.length > 0 && (
          <div className="rounded-xl border border-warning-200 bg-warning-50 dark:bg-warning-500/10 p-3 space-y-3">
            <div className="flex items-start gap-2">
              <Users className="w-4 h-4 mt-0.5 text-warning-700 dark:text-warning-500" />
              <div className="text-sm">
                <p className="font-medium text-foreground">{refused.length} can't go in the file</p>
                <p className="text-xs text-muted-foreground">Pay them to a receiver, this time only — or leave them out of this batch.</p>
              </div>
            </div>

            {lastTime.groups.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs rounded-lg bg-background border border-border px-3 py-2">
                <History className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">Last time:</span>
                {lastTime.groups.slice(0, 3).map((g, i) => (
                  <span key={i} className="text-foreground">
                    <span className="font-medium">{g.r.payee_name}</span>
                    <span className="text-muted-foreground"> · {g.r.bank_name} <span className="font-ledger">{g.r.iban ?? g.r.account_no}</span> · {g.n} guard{g.n === 1 ? "" : "s"} · {formatDate(g.r.set_at)}</span>
                    {i < Math.min(lastTime.groups.length, 3) - 1 ? ";" : ""}
                  </span>
                ))}
                <button type="button" className="ml-auto text-info-700 dark:text-info-500 hover:underline" onClick={useLastTime}>Use the same</button>
              </div>
            )}

            {receivers.map((r, k) => {
              const wallet = isPkWallet(r.bank);
              const prob = rProblem(r, k);
              const n = guardsOf(k).length;
              const amt = guardsOf(k).reduce((s, i) => s + Math.round(i.amount), 0);
              return (
                <div key={k} className="rounded-lg border border-border bg-background p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">Receiver {k + 1}</span>
                    <span className="text-xs text-muted-foreground">{n} guard{n === 1 ? "" : "s"} · PKR {amt.toLocaleString()}</span>
                    {receivers.length > 1 && (
                      <button type="button" className="ml-auto text-muted-foreground hover:text-danger-700" onClick={() => removeR(k)} title="Remove this receiver">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <ReceiverPicker value={r.name} picked={staff.find((x) => x.id === r.staffId) ?? null} staff={staff}
                    onType={(v) => setR(k, { name: v, staffId: undefined })} onPick={(s) => pickStaff(k, s)} />
                  <div className="grid grid-cols-3 gap-2">
                    <select className={input} value={r.bank} onChange={(e) => setR(k, { bank: e.target.value })}>
                      <option value="">Bank or wallet…</option>
                      {PK_BANKS.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
                    </select>
                    <input className={`${input} font-ledger`} value={r.account} onChange={(e) => setR(k, { account: e.target.value })}
                      placeholder={wallet ? "Mobile 03XXXXXXXXX" : "Account number"} />
                    {!wallet && (
                      <input className={`${input} font-ledger uppercase`} value={r.iban} onChange={(e) => setR(k, { iban: e.target.value })} placeholder="IBAN PK.." />
                    )}
                  </div>
                  {prob && n > 0 && <p className="text-xs text-danger-700 dark:text-danger-500">{prob}</p>}
                </div>
              );
            })}
            {receivers.length < 4 && (
              <button type="button" className="inline-flex items-center gap-1 text-sm text-info-700 dark:text-info-500 hover:underline"
                onClick={() => setReceivers((rs) => [...rs, blank()])}>
                <Plus className="w-4 h-4" /> Add another receiver
              </button>
            )}

            <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-background divide-y divide-border text-sm">
              {refused.map((i) => {
                const v = assign.get(i.payslipId) ?? -1;
                const prev = lastTime.latest.get(i.employeeId);
                return (
                  <div key={i.payslipId} className={`flex items-center gap-2 px-3 py-1.5 ${v < 0 ? "opacity-60" : ""}`}>
                    <span className="flex-1 min-w-0 truncate">
                      {i.name}
                      <span className="text-xs text-muted-foreground"> · {checks.get(i.payslipId)?.problem}{prev ? ` · last: ${prev.payee_name}` : ""}</span>
                    </span>
                    <span className="font-ledger w-20 text-right">{Math.round(i.amount).toLocaleString()}</span>
                    <select className="px-2 py-1 rounded-md border border-border bg-background text-xs w-40" value={v}
                      onChange={(e) => setAssign((m) => new Map(m).set(i.payslipId, Number(e.target.value)))}>
                      {receivers.map((_, k) => <option key={k} value={k}>{nameOf(k)}</option>)}
                      <option value={-1}>Leave out</option>
                    </select>
                  </div>
                );
              })}
            </div>

            {usingPayTo && (
              <>
                <FormField label="Why?" required>
                  <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} />
                </FormField>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {([[true, "One transfer per receiver", "Each receiver gets one row with his guards' total"],
                     [false, "One row per guard", "Each guard's salary is its own row to the receiver's account"]] as const).map(([v, t, d]) => (
                    <button key={t} type="button" onClick={() => setCombined(v)}
                      className={`text-left rounded-lg border px-3 py-2 ${combined === v ? "border-brand-500 bg-background" : "border-border bg-background/60"}`}>
                      <span className="block font-medium text-foreground">{t}</span>
                      <span className="block text-xs text-muted-foreground">{d}</span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Each guard's payslip is still recorded separately and is paid when the batch is released.{combined ? " If the bank rejects a receiver's row, all of his guards go back to unpaid together." : ""}</p>
              </>
            )}
          </div>
        )}

        <FormField label="iNet group name" required hint="As you will name it on iNet, e.g. MIU Oct salaries.">
          <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Reference" hint="Column I of the file, e.g. MIU.">
            <input className={`${input} uppercase`} value={reference} onChange={(e) => setReference(e.target.value)} />
          </FormField>
          <FormField label="Transaction date" required>
            <input type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Receiver name: type anyone's name, or pick a staff member from the list —
 * name, GGS code, client and bank — which fills in their account.
 */
function ReceiverPicker({ value, picked, staff, onType, onPick }: {
  value: string; picked: Staff | null; staff: Staff[]; onType: (v: string) => void; onPick: (s: Staff) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const q = value.trim().toLowerCase();
  const matches = useMemo(() => (q.length < 2 ? [] : staff.filter((s) =>
    s.full_name.toLowerCase().includes(q) || (s.code ?? "").toLowerCase().includes(q) || (s.client ?? "").toLowerCase().includes(q),
  ).slice(0, 8)), [q, staff]);
  const choose = (s: Staff) => { onPick(s); setOpen(false); };

  return (
    <div ref={box} className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
      <input
        className={`${input} pl-9`}
        value={value}
        onChange={(e) => { onType(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || !matches.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); choose(matches[hi]); }
          else if (e.key === "Escape") setOpen(false);
        }}
        placeholder="Receiver's name — type 2 letters to search staff, or any name"
      />
      {picked && (
        <p className="mt-1 text-xs text-muted-foreground">
          <Check className="inline w-3 h-3 mr-1 text-success-700 dark:text-success-500" />
          {picked.full_name} · {picked.code ?? "no code"}{picked.client ? ` · ${picked.client}` : ""} — account filled from the profile
        </p>
      )}
      {open && matches.length > 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-border bg-card shadow-lg overflow-hidden">
          {matches.map((s, i) => (
            <button key={s.id} type="button" onMouseDown={(e) => { e.preventDefault(); choose(s); }} onMouseEnter={() => setHi(i)}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 ${i === hi ? "bg-accent" : ""}`}>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-foreground truncate">{s.full_name}</span>
                <span className="block text-xs text-muted-foreground truncate">{s.code ?? "no code"}{s.client ? ` · ${s.client}` : ""}</span>
              </span>
              <span className={`text-xs shrink-0 ${s.iban || s.bank_account ? "text-muted-foreground" : "text-warning-700 dark:text-warning-500"}`}>
                {s.iban || s.bank_account ? (s.bank_name ?? "bank on file") : "no bank details"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
