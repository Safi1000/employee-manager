import { useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  X,
  MapPin,
  Plus,
  Trash2,
  Download,
  Sun,
  Moon,
  Sunset,
  Pencil,
  Settings as SettingsIcon,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import {
  supabase,
  ROSTER_STATUS_LABEL,
  CONTRACT_SHIFT_LABEL,
  type RosterAssignment,
  type RosterShift,
  type RosterStatus,
  type Employee,
  type Client,
  type Post,
  type ContractShift,
} from "../../lib/supabase";

const todayISO = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (iso: string, days: number): string => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const dayLabel = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};
const dayShort = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2);
};

const STATUS_COLOR: Record<RosterStatus, string> = {
  assigned: "bg-brand-50 text-brand-700 border-brand-200",
  confirmed: "bg-success-50 text-success-700 border-success-200",
  leave_requested: "bg-warning-50 text-warning-700 border-warning-200",
  reliever_needed: "bg-danger-50 text-danger-700 border-danger-200",
  unassigned: "bg-slate-50 text-slate-500 border-slate-200",
};

type DayCount = 7 | 14 | 30;

export default function Roster() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [rosterByKey, setRosterByKey] = useState<Map<string, RosterAssignment>>(new Map());

  const [startDate, setStartDate] = useState<string>(todayISO());
  const [dayCount, setDayCount] = useState<DayCount>(7);
  const [shift, setShift] = useState<RosterShift>("day");
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState<string>("all");

  // Cell edit modal
  const [editCell, setEditCell] = useState<{ employee: Employee; date: string } | null>(null);
  const [cellForm, setCellForm] = useState<{
    post_id: string;
    client_id: string;
    status: RosterStatus;
    notes: string;
  }>({ post_id: "", client_id: "", status: "assigned", notes: "" });
  // Item 12: keep an assignment in place on the following days until the user
  // changes it, instead of re-assigning each day from scratch.
  const [keepForward, setKeepForward] = useState(true);

  // Posts management modal
  const [postsModalOpen, setPostsModalOpen] = useState(false);

  const dates = useMemo(() => {
    const arr: string[] = [];
    for (let i = 0; i < dayCount; i += 1) arr.push(addDaysISO(startDate, i));
    return arr;
  }, [startDate, dayCount]);

  const endDate = dates[dates.length - 1];

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [empRes, cliRes, postRes] = await Promise.all([
      supabase
        .from("employees")
        .select("*, client:client_id(name), branch:branch_id(name)")
        .eq("status", "Active")
        .neq("category", "office_staff")
        .order("full_name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("posts").select("*").eq("active", true).order("name"),
    ]);
    if (empRes.error) setError(empRes.error.message);
    setEmployees((empRes.data ?? []) as Employee[]);
    setClients((cliRes.data ?? []) as Client[]);
    setPosts((postRes.data ?? []) as Post[]);
    setLoading(false);
  };

  const loadRoster = async () => {
    if (dates.length === 0) return;
    const { data, error: rErr } = await supabase
      .from("roster_assignments")
      .select("*")
      .gte("assignment_date", startDate)
      .lte("assignment_date", endDate)
      .eq("shift", shift);
    if (rErr) {
      setError(rErr.message);
      return;
    }
    const map = new Map<string, RosterAssignment>();
    for (const a of (data ?? []) as RosterAssignment[]) {
      map.set(`${a.employee_id}:${a.assignment_date}`, a);
    }
    setRosterByKey(map);
  };

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    loadRoster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, dayCount, shift]);

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      if (clientFilter !== "all" && e.client_id !== clientFilter) return false;
      if (q && !e.full_name.toLowerCase().includes(q) && !e.employee_code.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [employees, search, clientFilter]);

  const openCellEditor = (employee: Employee, date: string) => {
    const existing = rosterByKey.get(`${employee.id}:${date}`);
    setEditCell({ employee, date });
    setCellForm({
      post_id: existing?.post_id ?? "",
      client_id: existing?.client_id ?? employee.client_id ?? "",
      status: existing?.status ?? "assigned",
      notes: existing?.notes ?? "",
    });
  };

  const saveCell = async () => {
    if (!editCell) return;
    const { employee, date } = editCell;
    const existing = rosterByKey.get(`${employee.id}:${date}`);
    const base = {
      employee_id: employee.id,
      post_id: cellForm.post_id || null,
      client_id: cellForm.client_id || null,
      shift,
      status: cellForm.status,
      notes: cellForm.notes.trim() || null,
    };
    const friendly = (msg: string) =>
      /duplicate key|unique/i.test(msg)
        ? "This guard already has an assignment for this shift on that day (a guard can only be at one post per shift)."
        : msg;

    if (existing) {
      const { error: upErr } = await supabase
        .from("roster_assignments")
        .update({ ...base, assignment_date: date })
        .eq("id", existing.id);
      if (upErr) { setError(friendly(upErr.message)); return; }
    } else {
      const { error: insErr } = await supabase
        .from("roster_assignments")
        .insert({ ...base, assignment_date: date });
      if (insErr) { setError(friendly(insErr.message)); return; }
    }

    // Item 12: carry the assignment forward over the following days in view that
    // are still empty, stopping at the first day the user already set (so manual
    // changes downstream are preserved).
    if (keepForward) {
      const laterEmpty: string[] = [];
      for (const d of dates) {
        if (d <= date) continue;
        if (rosterByKey.get(`${employee.id}:${d}`)) break;
        laterEmpty.push(d);
      }
      if (laterEmpty.length > 0) {
        const { error: fillErr } = await supabase
          .from("roster_assignments")
          .insert(laterEmpty.map((d) => ({ ...base, assignment_date: d })));
        if (fillErr) { setError(friendly(fillErr.message)); return; }
      }
    }

    setEditCell(null);
    await loadRoster();
  };

  const clearCell = async () => {
    if (!editCell) return;
    const existing = rosterByKey.get(`${editCell.employee.id}:${editCell.date}`);
    if (existing) {
      const { error: delErr } = await supabase
        .from("roster_assignments")
        .delete()
        .eq("id", existing.id);
      if (delErr) {
        setError(delErr.message);
        return;
      }
    }
    setEditCell(null);
    await loadRoster();
  };

  // Export current view as CSV (instead of PDF — matches the existing export pattern).
  const exportCsv = () => {
    const headers = ["Employee Code", "Name", ...dates.map((d) => d)];
    const rows = filteredEmployees.map((emp) => {
      const cells = dates.map((d) => {
        const a = rosterByKey.get(`${emp.id}:${d}`);
        if (!a) return "—";
        const postName = posts.find((p) => p.id === a.post_id)?.name ?? "";
        const statusLbl = ROSTER_STATUS_LABEL[a.status];
        return [statusLbl, postName].filter(Boolean).join(" — ");
      });
      return [emp.employee_code, emp.full_name, ...cells];
    });
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Roster ${startDate} to ${endDate} (${shift}).csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const gapCount = useMemo(() => {
    // Total required assignments = filteredEmployees x dates; actual = rosterByKey
    // entries that match. This is a rough indicator of unfilled slots.
    let unassigned = 0;
    for (const emp of filteredEmployees) {
      for (const d of dates) {
        const a = rosterByKey.get(`${emp.id}:${d}`);
        if (!a) unassigned += 1;
      }
    }
    return unassigned;
  }, [filteredEmployees, dates, rosterByKey]);

  return (
    <>
      <Header
        title="Deployment Roster"
        subtitle="Plan who goes where, on which shift, days ahead. Click any cell to assign."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={() => setPostsModalOpen(true)}>
              <SettingsIcon className="w-4 h-4 mr-2" /> Manage Posts
            </Button>
            <Button variant="secondary" size="md" onClick={exportCsv}>
              <Download className="w-4 h-4 mr-2" /> Export CSV
            </Button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Toolbar */}
        <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setStartDate(addDaysISO(startDate, -dayCount))}
              className="p-2 rounded hover:bg-slate-100 text-slate-600"
              title="Previous window"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setStartDate(todayISO())}
              className="px-3 py-1.5 text-sm rounded border border-slate-200 hover:bg-slate-50"
              title="Jump to today"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => setStartDate(addDaysISO(startDate, dayCount))}
              className="p-2 rounded hover:bg-slate-100 text-slate-600"
              title="Next window"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="ml-2 text-sm text-slate-700">
              <Calendar className="w-4 h-4 inline mr-1 text-slate-400" />
              {dayLabel(startDate)} → {dayLabel(endDate)}
            </span>
          </div>

          <div className="flex gap-1 ml-auto">
            {([7, 14, 30] as DayCount[]).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setDayCount(n)}
                className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                  dayCount === n
                    ? "border-brand-600 bg-brand-50 text-brand-700"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {n} days
              </button>
            ))}
          </div>

          <div className="flex gap-1">
            {(["day", "night"] as RosterShift[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setShift(s)}
                className={`px-3 py-1.5 text-xs rounded border transition-colors inline-flex items-center gap-1 ${
                  shift === s
                    ? "border-brand-600 bg-brand-50 text-brand-700"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {s === "day" ? <Sun className="w-3 h-3" /> : s === "night" ? <Moon className="w-3 h-3" /> : <Sunset className="w-3 h-3" />}
                {CONTRACT_SHIFT_LABEL[s]}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employee…"
            className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
          />
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
          >
            <option value="all">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Guards visible" value={filteredEmployees.length} />
          <Stat label="Days shown" value={dates.length} />
          <Stat label="Filled slots" value={filteredEmployees.length * dates.length - gapCount} />
          <Stat label="Gaps (unassigned)" value={gapCount} accent={gapCount > 0 ? "danger" : "muted"} />
        </div>

        {/* Grid */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead className="bg-slate-50">
                <tr>
                  <th className="sticky left-0 bg-slate-50 z-10 text-left px-3 py-2 text-xs text-slate-500 uppercase border-b border-slate-200 min-w-[200px]">
                    Employee
                  </th>
                  {dates.map((d) => (
                    <th
                      key={d}
                      className="text-center px-2 py-2 text-xs text-slate-500 uppercase border-b border-slate-200 min-w-[110px]"
                    >
                      <div className="text-[10px] text-slate-400">{dayShort(d)}</div>
                      <div className="text-[11px] text-slate-700">
                        {new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && (
                  <tr>
                    <td colSpan={dates.length + 1} className="px-4 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredEmployees.length === 0 && (
                  <tr>
                    <td colSpan={dates.length + 1} className="px-4 py-10 text-center text-slate-500 text-sm">
                      No active guards / relievers match the current filters.
                    </td>
                  </tr>
                )}
                {!loading && filteredEmployees.map((emp) => (
                  <tr key={emp.id} className="hover:bg-slate-50/60">
                    <td className="sticky left-0 bg-white z-10 px-3 py-2 text-sm border-b border-slate-100">
                      <div className="text-slate-900">{emp.full_name}</div>
                      <div className="text-xs text-slate-500 font-mono">{emp.employee_code}</div>
                    </td>
                    {dates.map((d) => {
                      const a = rosterByKey.get(`${emp.id}:${d}`);
                      const post = a?.post_id ? posts.find((p) => p.id === a.post_id) : null;
                      return (
                        <td key={d} className="p-1 border-b border-slate-100 text-center align-top">
                          <button
                            type="button"
                            onClick={() => openCellEditor(emp, d)}
                            className={`w-full min-h-[44px] rounded border px-1.5 py-1 text-[10px] leading-tight text-left transition-colors ${
                              a
                                ? STATUS_COLOR[a.status]
                                : "border-dashed border-slate-200 text-slate-400 hover:bg-slate-50"
                            }`}
                          >
                            {a ? (
                              <>
                                <div className="font-medium truncate" title={ROSTER_STATUS_LABEL[a.status]}>
                                  {ROSTER_STATUS_LABEL[a.status]}
                                </div>
                                {post && (
                                  <div className="truncate text-[10px] opacity-80" title={post.name}>
                                    {post.name}
                                  </div>
                                )}
                              </>
                            ) : (
                              <span>—</span>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Legend */}
        <div className="text-xs text-slate-500 flex flex-wrap gap-3">
          {(Object.keys(ROSTER_STATUS_LABEL) as RosterStatus[]).map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span className={`w-3 h-3 rounded border ${STATUS_COLOR[s]}`} />
              {ROSTER_STATUS_LABEL[s]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-3 rounded border border-dashed border-slate-300" />
            Empty (unassigned)
          </span>
        </div>
      </div>

      {/* Cell edit modal */}
      <Modal
        isOpen={editCell !== null}
        onClose={() => setEditCell(null)}
        title={editCell ? `${editCell.employee.full_name} — ${dayLabel(editCell.date)}` : ""}
        size="md"
      >
        {editCell && (
          <div className="space-y-3">
            <div className="text-xs text-slate-500">
              Shift: <strong className="text-slate-700">{CONTRACT_SHIFT_LABEL[shift]}</strong>
              <span className="mx-2">·</span>
              Employee code: <span className="font-mono">{editCell.employee.employee_code}</span>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Post</label>
              <select
                value={cellForm.post_id}
                onChange={(e) => setCellForm({ ...cellForm, post_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">— No specific post —</option>
                {posts.map((p) => {
                  const cli = clients.find((c) => c.id === p.client_id);
                  return (
                    <option key={p.id} value={p.id}>
                      {p.name}{cli ? ` (${cli.name})` : ""}
                    </option>
                  );
                })}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Client (override)</label>
              <select
                value={cellForm.client_id}
                onChange={(e) => setCellForm({ ...cellForm, client_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">— Inherit from employee's client —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Status</label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(ROSTER_STATUS_LABEL) as RosterStatus[]).map((s) => (
                  <label
                    key={s}
                    className={`flex items-center gap-2 px-3 py-2 border rounded cursor-pointer text-xs ${
                      cellForm.status === s
                        ? STATUS_COLOR[s]
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="status"
                      checked={cellForm.status === s}
                      onChange={() => setCellForm({ ...cellForm, status: s })}
                    />
                    {ROSTER_STATUS_LABEL[s]}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Notes</label>
              <textarea
                rows={2}
                value={cellForm.notes}
                onChange={(e) => setCellForm({ ...cellForm, notes: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={keepForward}
                onChange={(e) => setKeepForward(e.target.checked)}
                className="rounded border-slate-300"
              />
              Keep this assignment on the following days until changed
            </label>
            <div className="flex items-center gap-2 pt-3 border-t border-slate-200">
              <Button variant="primary" size="md" onClick={saveCell} className="flex-1">
                Save
              </Button>
              {rosterByKey.get(`${editCell.employee.id}:${editCell.date}`) && (
                <Button variant="secondary" size="md" onClick={clearCell}>
                  <Trash2 className="w-4 h-4 mr-1" /> Clear
                </Button>
              )}
              <Button variant="secondary" size="md" onClick={() => setEditCell(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <PostsModal
        isOpen={postsModalOpen}
        onClose={() => setPostsModalOpen(false)}
        posts={posts}
        clients={clients}
        onChanged={loadAll}
      />
    </>
  );
}

function Stat({
  label,
  value,
  accent = "muted",
}: {
  label: string;
  value: number;
  accent?: "muted" | "danger";
}) {
  return (
    <div className="bg-white p-3 rounded-lg border border-slate-200">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-2xl ${accent === "danger" ? "text-danger-600" : "text-slate-900"}`}>{value}</div>
    </div>
  );
}

function PostsModal({
  isOpen,
  onClose,
  posts,
  clients,
  onChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  posts: Post[];
  clients: Client[];
  onChanged: () => void | Promise<void>;
}) {
  const [form, setForm] = useState({
    client_id: "",
    name: "",
    address: "",
    required_guards: "1",
    shift_pattern: "day" as ContractShift,
    active: true,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setForm({
      client_id: "",
      name: "",
      address: "",
      required_guards: "1",
      shift_pattern: "day",
      active: true,
    });
    setEditingId(null);
  };

  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen]);

  const startEdit = (p: Post) => {
    setEditingId(p.id);
    setForm({
      client_id: p.client_id,
      name: p.name,
      address: p.address ?? "",
      required_guards: String(p.required_guards),
      shift_pattern: p.shift_pattern,
      active: p.active,
    });
    nameRef.current?.focus();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.client_id) return;
    setErr(null);
    const payload = {
      client_id: form.client_id,
      name: form.name.trim(),
      address: form.address.trim() || null,
      required_guards: Math.max(0, Math.floor(Number(form.required_guards) || 0)),
      shift_pattern: form.shift_pattern,
      active: form.active,
    };
    if (editingId) {
      const { error: upErr } = await supabase.from("posts").update(payload).eq("id", editingId);
      if (upErr) { setErr(upErr.message); return; }
    } else {
      const { error: insErr } = await supabase.from("posts").insert(payload);
      if (insErr) { setErr(insErr.message); return; }
    }
    reset();
    await onChanged();
  };

  const remove = async (p: Post) => {
    if (!window.confirm(`Delete post "${p.name}"?`)) return;
    const { error: delErr } = await supabase.from("posts").delete().eq("id", p.id);
    if (delErr) { setErr(delErr.message); return; }
    await onChanged();
  };

  const toggleActive = async (p: Post) => {
    const { error: upErr } = await supabase.from("posts").update({ active: !p.active }).eq("id", p.id);
    if (upErr) { setErr(upErr.message); return; }
    await onChanged();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Manage Posts (Deployment Sites)" size="lg">
      <div className="space-y-4">
        {err && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{err}</div>
            <button onClick={() => setErr(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        <form onSubmit={save} className="grid grid-cols-2 gap-3 p-3 bg-slate-50 rounded-md border border-slate-200">
          <div>
            <label className="block text-xs text-slate-700 mb-1">Client *</label>
            <select
              required
              value={form.client_id}
              onChange={(e) => setForm({ ...form, client_id: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">— Select client —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-700 mb-1">Post Name *</label>
            <input
              required
              ref={nameRef}
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="e.g., Main Gate"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-slate-700 mb-1">Address</label>
            <input
              type="text"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-700 mb-1">Required Guards</label>
            <input
              type="number"
              min="0"
              value={form.required_guards}
              onChange={(e) => setForm({ ...form, required_guards: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-700 mb-1">Shift Pattern</label>
            <select
              value={form.shift_pattern}
              onChange={(e) => setForm({ ...form, shift_pattern: e.target.value as ContractShift })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="day">Day</option>
              <option value="night">Night</option>
              <option value="evening">Evening</option>
            </select>
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <Button variant="primary" size="sm">
              <Plus className="w-4 h-4 mr-1" />
              {editingId ? "Update post" : "Add post"}
            </Button>
            {editingId && (
              <Button variant="secondary" size="sm" onClick={reset}>
                Cancel edit
              </Button>
            )}
          </div>
        </form>

        <div className="border border-slate-200 rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-2 text-xs text-slate-500 uppercase">Post</th>
                <th className="text-left px-3 py-2 text-xs text-slate-500 uppercase">Client</th>
                <th className="text-right px-3 py-2 text-xs text-slate-500 uppercase">Guards</th>
                <th className="text-left px-3 py-2 text-xs text-slate-500 uppercase">Shift</th>
                <th className="text-right px-3 py-2 text-xs text-slate-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {posts.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-500 text-sm">
                    No posts yet. Add one to get started.
                  </td>
                </tr>
              )}
              {posts.map((p) => (
                <tr key={p.id} className={p.active ? "" : "bg-slate-50/50 opacity-60"}>
                  <td className="px-3 py-2">
                    <div className="text-slate-900 inline-flex items-center gap-1">
                      <MapPin className="w-3 h-3 text-slate-400" />
                      {p.name}
                    </div>
                    {p.address && <div className="text-xs text-slate-500">{p.address}</div>}
                  </td>
                  <td className="px-3 py-2 text-slate-600 text-xs">
                    {clients.find((c) => c.id === p.client_id)?.name ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">{p.required_guards}</td>
                  <td className="px-3 py-2 text-xs">{p.shift_pattern}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => toggleActive(p)}
                        className="text-xs px-2 py-1 rounded border border-slate-200 hover:bg-slate-50"
                      >
                        {p.active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        onClick={() => startEdit(p)}
                        className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => remove(p)}
                        className="p-1.5 rounded text-danger-600 hover:bg-danger-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
