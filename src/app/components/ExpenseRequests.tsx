// Expense requests (0495/0496). Anyone signed in asks for an expense
// and leaves a note; someone with expenses.approve approves it or rejects it
// with a reply note. An approved request is then recorded as an ordinary
// expense through the normal Add Expense form (prefilled from the request) and
// linked back — approval itself moves no money.
//
// Every write is an RPC that stamps who did it from the signed-in account.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Clock, FilePlus2, Loader2, Plus, X, XCircle } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import Header from "./Header";
import ThemedSelect from "./ThemedSelect";
import { supabase } from "../lib/supabase";
import { formatDate, formatDateTime } from "../lib/date";
import { useAuth, hasPermission } from "../lib/auth";

export type ExpenseRequest = {
  id: string;
  category_id: string | null;
  client_id: string | null;
  amount: number;
  needed_by: string | null;
  description: string;
  note: string | null;
  status: "pending" | "approved" | "rejected" | "recorded";
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  expense_id: string | null;
  category?: { name: string } | null;
  client?: { name: string } | null;
};

type Option = { id: string; name: string };

const STATUS: Record<ExpenseRequest["status"], { label: string; cls: string; icon: typeof Clock }> = {
  pending: { label: "Waiting for approval", cls: "bg-warning-50 text-warning-800 border-warning-200", icon: Clock },
  approved: { label: "Approved — to be recorded", cls: "bg-brand-50 text-brand-800 border-brand-200", icon: CheckCircle2 },
  rejected: { label: "Rejected", cls: "bg-danger-50 text-danger-700 border-danger-200", icon: XCircle },
  recorded: { label: "Recorded as an expense", cls: "bg-success-50 text-success-700 border-success-200", icon: CheckCircle2 },
};

export async function loadExpenseRequests(): Promise<ExpenseRequest[]> {
  const { data, error } = await supabase
    .from("expense_requests")
    .select("*, category:category_id(name), client:client_id(name)")
    .order("requested_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ExpenseRequest[];
}

/** Load categories and clients for the request form, for callers that have none. */
async function loadOptions(): Promise<{ categories: Option[]; clients: Option[] }> {
  const [c, k] = await Promise.all([
    supabase.from("expense_categories").select("id, name").order("name"),
    supabase.from("clients").select("id, name").order("name"),
  ]);
  return { categories: (c.data ?? []) as Option[], clients: (k.data ?? []) as Option[] };
}

// ── The request form ─────────────────────────────────────────────────────────
export function ExpenseRequestModal({
  categories, clients, onClose, onSaved,
}: {
  categories?: Option[];
  clients?: Option[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [opts, setOpts] = useState<{ categories: Option[]; clients: Option[] } | null>(
    categories && clients ? { categories, clients } : null,
  );
  const [form, setForm] = useState({ category_id: "", client_id: "", amount: "", needed_by: "", description: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!opts) void loadOptions().then(setOpts).catch((e) => setErr(String(e)));
  }, [opts]);

  const save = async () => {
    const amount = Number(form.amount);
    if (!form.description.trim()) { setErr("Say what the expense is for."); return; }
    if (!amount || amount <= 0) { setErr("Enter an amount above zero."); return; }
    setSaving(true);
    setErr(null);
    const { error } = await supabase.rpc("request_expense", {
      p_category_id: form.category_id || null,
      p_client_id: form.client_id || null,
      p_amount: amount,
      p_description: form.description.trim(),
      p_note: form.note.trim() || null,
      p_needed_by: form.needed_by || null,
    });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    await onSaved();
  };

  const input = "w-full px-3 py-2 border border-border rounded-md text-sm bg-card";
  return (
    <Modal
      isOpen
      onClose={() => { if (!saving) onClose(); }}
      title="Request an expense"
      size="md"
      error={err}
      onDismissError={() => setErr(null)}
      footer={
        <div className="flex items-center gap-3">
          <Button variant="primary" size="md" className="flex-1" disabled={saving || !form.description.trim() || !form.amount} onClick={save}>
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Sending…</> : "Send request"}
          </Button>
          <Button variant="secondary" size="md" disabled={saving} onClick={onClose}>Cancel</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          An approver will approve or reject it. Nothing is spent until it is approved and recorded.
        </p>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">What is it for? *</label>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="e.g. Torch batteries for night shift, site 4" className={input} maxLength={500} autoFocus />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Amount (PKR) *</label>
            <input type="number" min={0} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={input} />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Needed by</label>
            <input type="date" value={form.needed_by} onChange={(e) => setForm({ ...form, needed_by: e.target.value })} className={input} />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Category</label>
            <ThemedSelect value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} className={input}>
              <option value="">— Not sure —</option>
              {(opts?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Client</label>
            <ThemedSelect value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} className={input}>
              <option value="">Office (no client)</option>
              {(opts?.clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </ThemedSelect>
          </div>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Note for the approver</label>
          <textarea rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
            placeholder="Anything they should know — why it's needed, a quote, who will buy it" className={input} />
        </div>
      </div>
    </Modal>
  );
}

// ── The list ─────────────────────────────────────────────────────────────────
export function ExpenseRequestsList({
  requests, loading, canApprove, canRecord, onChanged, onRecord, emptyText,
}: {
  requests: ExpenseRequest[];
  loading: boolean;
  canApprove: boolean;
  canRecord: boolean;
  onChanged: () => void | Promise<void>;
  /** Open the Add Expense form prefilled from this approved request. */
  onRecord?: (r: ExpenseRequest) => void;
  emptyText?: string;
}) {
  const [deciding, setDeciding] = useState<{ r: ExpenseRequest; approve: boolean } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const decide = async () => {
    if (!deciding) return;
    if (!deciding.approve && !note.trim()) { setErr("Add a note saying why it is rejected."); return; }
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc("decide_expense_request", {
      p_request_id: deciding.r.id,
      p_approve: deciding.approve,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setDeciding(null);
    setNote("");
    await onChanged();
  };

  if (loading) {
    return <div className="px-6 py-10 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…</div>;
  }
  if (requests.length === 0) {
    return <div className="px-6 py-10 text-center text-sm text-muted-foreground">{emptyText ?? "No expense requests yet."}</div>;
  }

  return (
    <>
      <div className="divide-y divide-border">
        {requests.map((r) => {
          const st = STATUS[r.status];
          return (
            <div key={r.id} className="px-4 md:px-6 py-4 space-y-2">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="flex-1 min-w-[12rem]">
                  <p className="text-sm text-foreground">{r.description}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {r.category?.name ?? "No category"} · {r.client?.name ?? "Office"}
                    {r.needed_by ? ` · needed by ${formatDate(r.needed_by)}` : ""}
                  </p>
                </div>
                <span className="text-sm font-medium text-foreground tabular-nums">PKR {Number(r.amount).toLocaleString()}</span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs ${st.cls}`}>
                  <st.icon className="w-3 h-3" /> {st.label}
                </span>
              </div>

              <div className="rounded-md border border-border bg-secondary/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  Requested by <span className="text-foreground">{r.requested_by_name ?? "Unknown"}</span> · {formatDateTime(r.requested_at)}
                </p>
                {r.note && <p className="text-sm text-foreground whitespace-pre-wrap mt-1">{r.note}</p>}
              </div>

              {r.decided_at && (
                <div className={`rounded-md border px-3 py-2 ml-4 ${r.status === "rejected" ? "border-danger-200 bg-danger-50/60 dark:bg-danger-900/20" : "border-border"}`}>
                  <p className="text-xs text-muted-foreground">
                    {r.status === "rejected" ? "Rejected" : "Approved"} by <span className="text-foreground">{r.decided_by_name ?? "Unknown"}</span> · {formatDateTime(r.decided_at)}
                  </p>
                  {r.decision_note && <p className="text-sm text-foreground whitespace-pre-wrap mt-1">{r.decision_note}</p>}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {r.status === "pending" && canApprove && (
                  <>
                    <Button size="sm" variant="primary" onClick={() => { setErr(null); setNote(""); setDeciding({ r, approve: true }); }}>
                      <CheckCircle2 className="w-4 h-4 mr-1.5" /> Approve
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => { setErr(null); setNote(""); setDeciding({ r, approve: false }); }}>
                      <XCircle className="w-4 h-4 mr-1.5" /> Reject
                    </Button>
                  </>
                )}
                {r.status === "approved" && canRecord && onRecord && (
                  <Button size="sm" variant="primary" onClick={() => onRecord(r)}>
                    <FilePlus2 className="w-4 h-4 mr-1.5" /> Record expense
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {deciding && (
        <Modal
          isOpen
          onClose={() => { if (!busy) setDeciding(null); }}
          title={deciding.approve ? "Approve request" : "Reject request"}
          size="sm"
          error={err}
          onDismissError={() => setErr(null)}
          footer={
            <div className="flex items-center gap-3">
              <Button variant={deciding.approve ? "primary" : "danger"} size="md" className="flex-1"
                disabled={busy || (!deciding.approve && !note.trim())} onClick={decide}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : deciding.approve ? "Approve" : "Reject"}
              </Button>
              <Button variant="secondary" size="md" disabled={busy} onClick={() => setDeciding(null)}>Cancel</Button>
            </div>
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-foreground">
              {deciding.r.description} · <span className="tabular-nums">PKR {Number(deciding.r.amount).toLocaleString()}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Requested by {deciding.r.requested_by_name ?? "Unknown"}.{" "}
              {deciding.approve
                ? "Once approved, accounts record it as an expense; no money moves until then."
                : "The requester will see your note."}
            </p>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                {deciding.approve ? "Note (optional)" : "Why is it rejected? *"}
              </label>
              <textarea rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-md text-sm bg-card" />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// ── Page for people who can request but not see the expense ledger ───────────
export default function MyExpenseRequestsPage() {
  const { profile } = useAuth();
  const canRequest = !!profile;
  const canApprove = hasPermission(profile, "expenses.approve");
  const [requests, setRequests] = useState<ExpenseRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRequests(await loadExpenseRequests()); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const mine = useMemo(() => requests.filter((r) => canApprove || r.requested_by === profile?.id), [requests, canApprove, profile?.id]);

  return (
    <>
      <Header
        title="Expense requests"
        subtitle="Ask for an expense; an approver approves or rejects it"
        actions={canRequest ? (
          <Button variant="primary" size="md" onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} /> Request Expense
          </Button>
        ) : undefined}
      />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        {err && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" /><div className="flex-1">{err}</div>
            <button onClick={() => setErr(null)}><X className="w-4 h-4" /></button>
          </div>
        )}
        <div className="bg-card rounded-lg border border-border">
          <ExpenseRequestsList
            requests={mine}
            loading={loading}
            canApprove={canApprove}
            canRecord={false}
            onChanged={load}
            emptyText={'You have not requested any expenses. Use "Request Expense" to ask for one.'}
          />
        </div>
      </div>
      {open && <ExpenseRequestModal onClose={() => setOpen(false)} onSaved={async () => { setOpen(false); await load(); }} />}
    </>
  );
}
