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

const STATUS_STYLE: Record<string, string> = {
  applied: "bg-slate-100 text-slate-700 border-slate-200",
  screening: "bg-sky-50 text-sky-700 border-sky-200",
  interview: "bg-amber-50 text-amber-700 border-amber-200",
  offer: "bg-violet-50 text-violet-700 border-violet-200",
  hired: "bg-success-50 text-success-700 border-success-200",
  rejected: "bg-danger-50 text-danger-700 border-danger-200",
  withdrawn: "bg-slate-100 text-slate-500 border-slate-200",
};

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
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header
        title="Recruitment"
        subtitle="Candidate intake → pipeline → hire. Onboard hires in Employees."
        actions={
          <Button variant="primary" size="md" onClick={() => { setForm(emptyForm); setAddOpen((v) => !v); }}>
            {addOpen ? "Close" : "Add Candidate"}
          </Button>
        }
      />

      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      {/* Stage summary */}
      <div className="flex flex-wrap gap-2 mb-4">
        {STAGES.map((s) => (
          <span key={s} className={`px-2.5 py-1 rounded-md text-xs border ${STATUS_STYLE[s]}`}>
            {s} · {counts[s] ?? 0}
          </span>
        ))}
      </div>

      {addOpen && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Full name *</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Candidate name" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Position applied</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" value={form.position_applied}
                onChange={(e) => setForm({ ...form, position_applied: e.target.value })} placeholder="e.g. Security Guard" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Source</label>
              <ThemedSelect className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}>
                {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Phone</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="03xx-xxxxxxx" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Email</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">CNIC</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" value={form.cnic}
                onChange={(e) => setForm({ ...form, cnic: formatCnic(e.target.value) })} maxLength={15} placeholder="XXXXX-XXXXXXX-X" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Branch / Region</label>
              <ThemedSelect className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" value={form.branch_id}
                onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
                <option value="">—</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </ThemedSelect>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Notes</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" value={form.notes}
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
        <span className="text-xs text-slate-500">Show:</span>
        <ThemedSelect className="px-3 py-1.5 border border-slate-200 rounded-md text-sm" value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="active">In pipeline</option>
          <option value="all">All</option>
          {["applied", "screening", "interview", "offer", "hired", "rejected", "withdrawn"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </ThemedSelect>
      </div>

      <div className="overflow-x-auto border border-slate-200 rounded-lg bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
            <tr>
              <th className="text-left px-3 py-2">Candidate</th>
              <th className="text-left px-3 py-2">Position</th>
              <th className="text-left px-3 py-2">Source</th>
              <th className="text-left px-3 py-2">Branch</th>
              <th className="text-left px-3 py-2">Applied</th>
              <th className="text-center px-3 py-2">Status</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((r) => {
              const next = nextStage(r.status);
              const terminal = ["hired", "rejected", "withdrawn"].includes(r.status);
              return (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <div className="text-slate-800">{r.full_name}</div>
                    <div className="text-xs text-slate-400">{r.phone ?? r.email ?? r.cnic ?? "—"}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.position_applied ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{r.source ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{branchName(r.branch_id)}</td>
                  <td className="px-3 py-2 text-slate-500 tabular-nums">{formatDate(r.created_at)}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded-md text-xs border ${STATUS_STYLE[r.status] ?? STATUS_STYLE.applied}`}>{r.status}</span>
                  </td>
                  <td className="px-3 py-2">
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
              <tr><td colSpan={7} className="px-3 py-4 text-slate-500">No candidates in this view.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400 mt-3">
        A candidate marked <span className="text-success-700">hired</span> is onboarded from the Employees panel — recruitment intake data is intentionally light and doesn't auto-create an employee record.
      </p>
    </div>
  );
}
