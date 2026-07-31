import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import ThemedSelect from "../../components/ThemedSelect";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { formatDate } from "../../lib/date";
import { formatCnic } from "../../lib/validation";

// Workforce ▸ Recruitment: a light candidate intake pipeline. Add a candidate,
// move them through the stages, and mark the outcome. A hire is flagged 'hired'
// and then onboarded in Employees (kept manual — the employee record is rich and
// shouldn't be auto-forged from thin intake data).

type Candidate = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  cnic: string | null;
  position_applied: string | null;
  source: string | null;
  status: string;
  notes: string | null;
  branch_id: string | null;
  created_at: string;
};

type Branch = { id: string; name: string };

const STAGES = ["applied", "screening", "interview", "offer", "hired"] as const;
const SOURCES = ["walk-in", "referral", "agency", "online", "other"] as const;

// Semantic palettes only — sky/violet/amber are stock Tailwind and are NOT
// remapped by theme.css, so they kept their light-mode tints in dark mode.
// `text-*-700 dark:text-*-500` is the app-wide contrast pairing.
const STATUS_STYLE: Record<string, string> = {
  applied: "bg-slate-100 text-slate-700 border-slate-200",
  screening: "bg-info-50 text-info-700 dark:text-info-500 border-info-200",
  interview: "bg-warning-50 text-warning-700 dark:text-warning-500 border-warning-200",
  offer: "bg-brand-50 text-brand-700 dark:text-brand-500 border-brand-200",
  hired: "bg-success-50 text-success-700 dark:text-success-500 border-success-200",
  rejected: "bg-danger-50 text-danger-700 dark:text-danger-500 border-danger-200",
  withdrawn: "bg-slate-100 text-slate-500 border-slate-200",
};

const FIELD =
  "w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/40";

const emptyForm = {
  full_name: "",
  phone: "",
  email: "",
  cnic: "",
  position_applied: "",
  source: "walk-in",
  branch_id: "",
  notes: "",
};

export default function Recruitment() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [rows, setRows] = useState<Candidate[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [statusFilter, setStatusFilter] = useState<"active" | "all" | string>("active");
  const [form, setForm] = useState(emptyForm);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [c, b] = await Promise.all([
      supabase.from("recruitment_candidates").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
      supabase.from("branches").select("id, name").eq("company_id", companyId).order("name"),
    ]);
    setRows((c.data ?? []) as Candidate[]);
    setBranches((b.data ?? []) as Branch[]);
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

  const branchName = (id: string | null) => (id ? branches.find((b) => b.id === id)?.name ?? "—" : "—");

  const addCandidate = async () => {
    if (!form.full_name.trim()) { setErr("Candidate name is required."); return; }
    const ok = await run(
      supabase.from("recruitment_candidates").insert({
        full_name: form.full_name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        cnic: form.cnic.trim() || null,
        position_applied: form.position_applied.trim() || null,
        source: form.source || null,
        branch_id: form.branch_id || null,
        notes: form.notes.trim() || null,
      }),
    );
    if (ok) { setForm(emptyForm); setAddOpen(false); }
  };

  const setStatus = (id: string, status: string) =>
    run(supabase.from("recruitment_candidates").update({ status }).eq("id", id));

  const nextStage = (status: string): string | null => {
    const i = STAGES.indexOf(status as (typeof STAGES)[number]);
    return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
  };

  const filtered = useMemo(() => {
    if (statusFilter === "all") return rows;
    if (statusFilter === "active") return rows.filter((r) => !["hired", "rejected", "withdrawn"].includes(r.status));
    return rows.filter((r) => r.status === statusFilter);
  }, [rows, statusFilter]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach((r) => { m[r.status] = (m[r.status] ?? 0) + 1; });
    return m;
  }, [rows]);

  return (
    <>
      {/* Header is a full-bleed sticky bar with its own padding — it belongs
       * outside the padded scroll container, not nested inside it. */}
      <Header
        title="Recruitment"
        subtitle="Candidate intake → pipeline → hire. Onboard hires in Employees."
        actions={
          <Button variant="primary" size="md" onClick={() => { setForm(emptyForm); setAddOpen((v) => !v); }}>
            {addOpen ? "Close" : "Add Candidate"}
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
      {err && (
        <p className="mb-4 p-3 bg-danger-50 border border-danger-200 rounded-md text-sm text-danger-700 dark:text-danger-500">
          {err}
        </p>
      )}

      {/* Stage summary — doubles as the pipeline filter */}
      <div className="flex flex-wrap gap-2 mb-4">
        {STAGES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter((f) => (f === s ? "active" : s))}
            title={`Show ${s} candidates`}
            className={`px-2.5 py-1 rounded-md text-xs border capitalize transition-colors hover:opacity-80 ${STATUS_STYLE[s]} ${
              statusFilter === s ? "ring-2 ring-ring/50" : ""
            }`}
          >
            {s} · {counts[s] ?? 0}
          </button>
        ))}
      </div>

      {addOpen && (
        <div className="bg-card border border-border rounded-lg p-4 mb-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Full name *</label>
              <input className={FIELD} value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Candidate name" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Position applied</label>
              <input className={FIELD} value={form.position_applied}
                onChange={(e) => setForm({ ...form, position_applied: e.target.value })} placeholder="e.g. Security Guard" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Source</label>
              <ThemedSelect className={FIELD} value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}>
                {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Phone</label>
              <input className={FIELD} value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="03xx-xxxxxxx" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Email</label>
              <input className={FIELD} value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">CNIC</label>
              <input className={FIELD} value={form.cnic}
                onChange={(e) => setForm({ ...form, cnic: formatCnic(e.target.value) })} maxLength={15} placeholder="XXXXX-XXXXXXX-X" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Branch / Region</label>
              <ThemedSelect className={FIELD} value={form.branch_id}
                onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
                <option value="">—</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </ThemedSelect>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-muted-foreground mb-1">Notes</label>
              <input className={FIELD} value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Screening notes, availability…" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={busy || !form.full_name.trim()} onClick={addCandidate}>Add</Button>
          </div>
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-muted-foreground">Show:</span>
        <ThemedSelect className="px-3 py-1.5 bg-input-background border border-border rounded-md text-sm text-foreground capitalize" value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="active">In pipeline</option>
          <option value="all">All</option>
          {["applied", "screening", "interview", "offer", "hired", "rejected", "withdrawn"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </ThemedSelect>
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">
          {filtered.length} of {rows.length}
        </span>
      </div>

      <div className="overflow-x-auto border border-border rounded-lg bg-card">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-slate-50 border-b border-border">
            <tr>
              <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Candidate</th>
              <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Position</th>
              <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Source</th>
              <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Branch</th>
              <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Applied</th>
              <th className="text-center px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Status</th>
              <th className="text-right px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const next = nextStage(r.status);
              const terminal = ["hired", "rejected", "withdrawn"].includes(r.status);
              return (
                <tr key={r.id} className="border-b border-border last:border-0 transition-colors hover:bg-accent/50">
                  <td className="px-4 py-3">
                    <div className="text-foreground">{r.full_name}</div>
                    <div className="text-xs text-muted-foreground">{r.phone ?? r.email ?? r.cnic ?? "—"}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.position_applied ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground capitalize">{r.source ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{branchName(r.branch_id)}</td>
                  <td className="px-4 py-3 text-muted-foreground tabular-nums whitespace-nowrap">{formatDate(r.created_at)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded-md text-xs border capitalize ${STATUS_STYLE[r.status] ?? STATUS_STYLE.applied}`}>{r.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      {next && !terminal && (
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => setStatus(r.id, next)}>
                          → {next}
                        </Button>
                      )}
                      {!terminal && (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStatus(r.id, "rejected")}>
                          Reject
                        </Button>
                      )}
                      {terminal && r.status !== "hired" && (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStatus(r.id, "applied")}>
                          Reopen
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {rows.length === 0
                    ? 'No candidates yet — click "Add Candidate" to start the pipeline.'
                    : "No candidates in this view."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground mt-3">
        A candidate marked <span className="text-success-700 dark:text-success-500">hired</span> is onboarded from the Employees panel — recruitment intake data is intentionally light and doesn't auto-create an employee record.
      </p>
      </div>
    </>
  );
}
