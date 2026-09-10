import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useState } from "react";
import { Plus, Loader2, AlertCircle, X, Trash2, Pencil, Calendar as CalendarIcon, User as UserIcon, Mail, Check, Lock } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import PersonalChecklist from "../../components/PersonalChecklist";
import { formatDate } from "../../lib/date";
import {
  supabase,
  TASK_STATUS_LABEL,
  TASK_PRIORITY_LABEL,
  TASK_PRIORITY_BADGE,
  type Task,
  type TaskStatus,
  type TaskPriority,
  type Profile,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];

// Column zones: white surface with a thick top accent strip so each lane reads
// as a distinct status without the heavy full-tint look. Tones don't repeat:
// To Do = info (blue), In Progress = warning (amber), Done = success (green).
const COLUMN_TONE: Record<TaskStatus, string> = {
  todo: "bg-white border border-slate-200 border-t-4 border-t-info-500",
  in_progress: "bg-white border border-slate-200 border-t-4 border-t-warning-500",
  done: "bg-white border border-slate-200 border-t-4 border-t-success-500",
};

const COLUMN_LABEL_TONE: Record<TaskStatus, string> = {
  todo: "text-info-700",
  in_progress: "text-warning-700",
  done: "text-success-700",
};

const dayDiff = (iso: string) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(y, m - 1, d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
};

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function Tasks() {
  const { profile } = useAuth();
  const isAdmin =
    profile?.role === "super_admin" || profile?.role === "super_super_admin";

  const [tasks, setTasks] = useState<Task[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");

  // Where THIS user's task alerts go. 0418 put it on `profiles` rather than on
  // a task, because the address belongs to the person: one place to set it, one
  // place to change it, and no way for two tasks to disagree about where the
  // same person is reachable. Empty means opted out, which is the default.
  const [alertEmail, setAlertEmail] = useState<string>("");
  const [alertEmailSaved, setAlertEmailSaved] = useState<string>("");
  const [alertEmailBusy, setAlertEmailBusy] = useState(false);
  const [alertEmailDone, setAlertEmailDone] = useState(false);

  // Create / edit modal.
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formAssignee, setFormAssignee] = useState<string>("");
  const [formDueDate, setFormDueDate] = useState<string>("");
  const [formStatus, setFormStatus] = useState<TaskStatus>("todo");
  const [formPriority, setFormPriority] = useState<TaskPriority>("medium");
  const [submitting, setSubmitting] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [tRes, uRes] = await Promise.all([
      supabase
        .from("tasks")
        .select("*")
        .order("position")
        .order("created_at"),
      isAdmin
        ? supabase.from("profiles").select("*").order("full_name")
        : Promise.resolve({ data: null, error: null } as any),
    ]);
    if (tRes.error) setError(tRes.error.message);
    setTasks((tRes.data ?? []) as Task[]);
    if (uRes && !uRes.error) setUsers((uRes.data ?? []) as Profile[]);

    // Read back rather than taken from the cached `profile`: the auth context is
    // populated at sign-in and would show a stale address for the rest of the
    // session after someone changes it on another device.
    if (profile?.id) {
      const { data: me } = await supabase
        .from("profiles")
        .select("task_alert_email")
        .eq("id", profile.id)
        .maybeSingle();
      const current = (me?.task_alert_email as string | null) ?? "";
      setAlertEmail(current);
      setAlertEmailSaved(current);
    }
    setLoading(false);
  };

  const saveAlertEmail = async () => {
    if (!profile?.id) return;
    const next = alertEmail.trim();
    // A rough shape check only. The authority on whether an address works is
    // whether mail arrives at it, and a regex that rejects valid addresses is
    // worse than one that accepts a typo — the typo is visible in the box.
    if (next && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
      setError("That does not look like an email address.");
      return;
    }
    setAlertEmailBusy(true);
    setError(null);
    const { error: upErr } = await supabase
      .from("profiles")
      .update({ task_alert_email: next || null })
      .eq("id", profile.id);
    setAlertEmailBusy(false);
    if (upErr) { setError(upErr.message); return; }
    setAlertEmailSaved(next);
    setAlertEmailDone(true);
    window.setTimeout(() => setAlertEmailDone(false), 2000);
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const userMap = useMemo(() => {
    const m = new Map<string, Profile>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);

  const filteredTasks = useMemo(() => {
    if (!isAdmin) return tasks; // RLS already scopes to self
    if (assigneeFilter === "all") return tasks;
    if (assigneeFilter === "unassigned") return tasks.filter((t) => !t.assignee_id);
    return tasks.filter((t) => t.assignee_id === assigneeFilter);
  }, [tasks, assigneeFilter, isAdmin]);

  const columns = useMemo(() => {
    const byStatus: Record<TaskStatus, Task[]> = { todo: [], in_progress: [], done: [] };
    for (const t of filteredTasks) {
      byStatus[t.status].push(t);
    }
    return byStatus;
  }, [filteredTasks]);

  const resetForm = () => {
    setFormTitle("");
    setFormDescription("");
    setFormAssignee("");
    setFormDueDate("");
    setFormStatus("todo");
    setFormPriority("medium");
  };

  const openCreate = () => {
    resetForm();
    setIsCreateOpen(true);
  };

  const openEdit = (t: Task) => {
    setEditTask(t);
    setFormTitle(t.title);
    setFormDescription(t.description ?? "");
    setFormAssignee(t.assignee_id ?? "");
    setFormDueDate(t.due_date ?? "");
    setFormStatus(t.status);
    setFormPriority(t.priority ?? "medium");
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTitle.trim()) {
      setError("Task title is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // tasks.company_id is NOT NULL and the table has NO fill_company_id
      // trigger — one of the 27 company-scoped tables where the caller must
      // supply it. Omitting it failed with a not-null violation for every user,
      // which is why production holds zero tasks. Same defect as treasury.
      const taskCompanyId = profile?.view_as_company ?? profile?.company_id ?? null;
      if (!taskCompanyId) {
        throw new Error("No company is selected, so there is nowhere to file this task. Pick a company with the “Viewing as” selector first.");
      }
      const { error: insErr } = await supabase.from("tasks").insert({
        company_id: taskCompanyId,
        title: formTitle.trim(),
        description: formDescription.trim() || null,
        status: formStatus,
        priority: formPriority,
        assignee_id: formAssignee || null,
        due_date: formDueDate || null,
      });
      if (insErr) throw insErr;
      setIsCreateOpen(false);
      resetForm();
      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTask) return;
    if (!formTitle.trim()) {
      setError("Task title is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // A non-admin sends STATUS AND NOTHING ELSE.
      //
      // It used to send title, description and priority for everyone and add
      // assignee/due_date for admins — which was fine while nothing checked,
      // and 0418 now checks. `tasks_guard_privileged_fields` compares NEW
      // against OLD with `is distinct from`, so re-sending an unchanged title
      // is harmless; but the moment a non-admin's form held a stale value —
      // reopened after someone else retitled the task, say — the save would be
      // refused and the status change would go with it. Sending only what this
      // user is allowed to change removes the whole class.
      const patch: Partial<Task> = isAdmin
        ? {
            title: formTitle.trim(),
            description: formDescription.trim() || null,
            status: formStatus,
            priority: formPriority,
            assignee_id: formAssignee || null,
            due_date: formDueDate || null,
          }
        : { status: formStatus };
      const { error: upErr } = await supabase.from("tasks").update(patch).eq("id", editTask.id);
      if (upErr) throw upErr;
      setEditTask(null);
      resetForm();
      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (t: Task) => {
    if (!isAdmin) return;
    if (!window.confirm(`Delete task "${t.title}"?`)) return;
    const { error: dErr } = await supabase.from("tasks").delete().eq("id", t.id);
    if (dErr) {
      setError(dErr.message);
      return;
    }
    await loadAll();
  };

  const moveTask = async (t: Task, newStatus: TaskStatus) => {
    if (t.status === newStatus) return;
    // Optimistic update.
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: newStatus } : x)));
    const { error: upErr } = await supabase
      .from("tasks")
      .update({ status: newStatus })
      .eq("id", t.id);
    if (upErr) {
      setError(upErr.message);
      await loadAll();
    }
  };

  return (
    <>
      <Header
        title={isAdmin ? "Task Board" : "My Tasks"}
        subtitle={
          isAdmin
            ? "Assign work and track team progress"
            : "Your assignments by status"
        }
        actions={
          isAdmin ? (
            <Button variant="primary" size="md" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              New Task
            </Button>
          ) : null
        }
      />

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Alert address — every user, not just admins. This is the one control
            on the board that is about the viewer rather than about the work. */}
        <div className="mb-6 border border-slate-200 rounded-lg bg-white p-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-slate-700 flex-shrink-0">
              <Mail className="w-4 h-4 text-slate-400" strokeWidth={1.5} />
              Email me about my tasks
            </div>
            <input
              type="email"
              value={alertEmail}
              onChange={(e) => setAlertEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveAlertEmail(); } }}
              placeholder="you@example.com"
              className="flex-1 min-w-0 px-3 py-1.5 border border-slate-200 rounded-md text-sm"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={alertEmailBusy || alertEmail.trim() === alertEmailSaved.trim()}
              onClick={() => void saveAlertEmail()}
            >
              {alertEmailBusy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : alertEmailDone ? (
                <><Check className="w-3.5 h-3.5 mr-1" strokeWidth={2} />Saved</>
              ) : (
                "Save"
              )}
            </Button>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            You&apos;ll get a message when a task is assigned to you, and reminders as its due
            date approaches. Leave it empty to receive nothing. This is separate from the
            address you sign in with.
          </p>
        </div>

        {isAdmin && (
          <div className="flex items-center gap-3 mb-6">
            <label className="text-xs text-slate-500">Filter by assignee:</label>
            <ThemedSelect
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
            >
              <option value="all">All assignees</option>
              <option value="unassigned">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name ?? u.email}
                </option>
              ))}
            </ThemedSelect>
          </div>
        )}

        {loading ? (
          <div className="bg-white border border-slate-200 rounded-lg p-10 text-center text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {STATUSES.map((status) => (
              <div
                key={status}
                className={`rounded-lg ${COLUMN_TONE[status]} p-3 min-h-[200px]`}
              >
                <div className="flex items-center justify-between mb-3 px-1">
                  <h3 className={`text-sm uppercase tracking-wide ${COLUMN_LABEL_TONE[status]}`}>
                    {TASK_STATUS_LABEL[status]}{" "}
                    <span className="text-xs text-slate-500 normal-case">({columns[status].length})</span>
                  </h3>
                </div>
                <div className="space-y-2">
                  {columns[status].length === 0 && (
                    <div className="text-xs text-slate-400 text-center py-6 border border-dashed border-slate-200 rounded">
                      No tasks here.
                    </div>
                  )}
                  {columns[status].map((t) => {
                    const assignee = t.assignee_id ? userMap.get(t.assignee_id) : null;
                    const daysLeft = t.due_date ? dayDiff(t.due_date) : null;
                    const overdue = daysLeft !== null && daysLeft < 0;
                    const soon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 3;
                    return (
                      <div
                        key={t.id}
                        className="bg-white rounded-md border border-slate-200 p-3 shadow-sm hover:shadow transition-shadow"
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <p className="text-sm text-slate-900 flex-1">{t.title}</p>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => openEdit(t)}
                              className="p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
                              title="Edit"
                            >
                              <Pencil className="w-3.5 h-3.5" strokeWidth={1.5} />
                            </button>
                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() => handleDelete(t)}
                                className="p-1 text-danger-600 hover:bg-danger-50 rounded"
                                title="Delete"
                              >
                                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                              </button>
                            )}
                          </div>
                        </div>
                        {t.description && (
                          <p className="text-xs text-slate-600 line-clamp-3 mb-2">{t.description}</p>
                        )}
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded border ${TASK_PRIORITY_BADGE[t.priority ?? "medium"]}`}>
                            {TASK_PRIORITY_LABEL[t.priority ?? "medium"]}
                          </span>
                          {t.status === "done" && t.completed_at && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-success-50 text-success-700">
                              ✓ {formatDate(t.completed_at.slice(0, 10))}
                            </span>
                          )}
                          {assignee && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                              <UserIcon className="w-3 h-3" strokeWidth={1.5} />
                              {assignee.full_name ?? assignee.email}
                            </span>
                          )}
                          {t.due_date && (
                            <span
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${
                                overdue
                                  ? "bg-danger-50 text-danger-700"
                                  : soon
                                    ? "bg-warning-50 text-warning-700"
                                    : "bg-slate-100 text-slate-700"
                              }`}
                            >
                              <CalendarIcon className="w-3 h-3" strokeWidth={1.5} />
                              {formatDate(t.due_date)}
                              {overdue ? " · overdue" : soon ? ` · ${daysLeft}d left` : ""}
                            </span>
                          )}
                        </div>
                        <div className="mt-2 pt-2 border-t border-slate-100 flex gap-1">
                          {STATUSES.filter((s) => s !== t.status).map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={() => moveTask(t, s)}
                              className="text-[10px] px-2 py-0.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
                            >
                              → {TASK_STATUS_LABEL[s]}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Beneath the board, and outside the loading branch on purpose: the
            notes are a separate thing from the tasks and should not disappear
            while the columns are fetching. */}
        <PersonalChecklist
          me={profile ?? null}
          isAdmin={isAdmin}
          users={users}
          onError={setError}
        />
      </div>

      <Modal
        isOpen={isCreateOpen}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => {
          setIsCreateOpen(false);
          resetForm();
        }}
        title="New Task"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleCreate}>
          <TaskFields
            title={formTitle}
            setTitle={setFormTitle}
            description={formDescription}
            setDescription={setFormDescription}
            assignee={formAssignee}
            setAssignee={setFormAssignee}
            dueDate={formDueDate}
            setDueDate={setFormDueDate}
            status={formStatus}
            setStatus={setFormStatus}
            priority={formPriority}
            setPriority={setFormPriority}
            users={users}
            isAdmin={isAdmin}
          />
          <div className="flex items-center gap-3 pt-2">
            <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create Task
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsCreateOpen(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!editTask}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => {
          setEditTask(null);
          resetForm();
        }}
        title={`Edit Task — ${editTask?.title ?? ""}`}
        size="md"
      >
        {editTask && (
          <form className="space-y-4" onSubmit={handleEditSave}>
            {isAdmin ? (
              <TaskFields
                title={formTitle}
                setTitle={setFormTitle}
                description={formDescription}
                setDescription={setFormDescription}
                assignee={formAssignee}
                setAssignee={setFormAssignee}
                dueDate={formDueDate}
                setDueDate={setFormDueDate}
                status={formStatus}
                setStatus={setFormStatus}
                priority={formPriority}
                setPriority={setFormPriority}
                users={users}
                isAdmin={isAdmin}
              />
            ) : (
              // A non-admin gets the task as INFORMATION plus the one control
              // they hold. Disabled inputs were the old answer and they read as
              // "broken" rather than "not yours" — a greyed-out text box still
              // invites a click, and the reason it does nothing is nowhere on
              // screen. Text that cannot be typed into does not raise the
              // question in the first place.
              <TaskReadOnlyFields
                task={editTask}
                status={formStatus}
                setStatus={setFormStatus}
              />
            )}


            <div className="flex items-center gap-3 pt-2">
              <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setEditTask(null);
                  resetForm();
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

function TaskFields({
  title,
  setTitle,
  description,
  setDescription,
  assignee,
  setAssignee,
  dueDate,
  setDueDate,
  status,
  setStatus,
  priority,
  setPriority,
  users,
  isAdmin,
}: {
  title: string;
  setTitle: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  assignee: string;
  setAssignee: (v: string) => void;
  dueDate: string;
  setDueDate: (v: string) => void;
  status: TaskStatus;
  setStatus: (v: TaskStatus) => void;
  priority: TaskPriority;
  setPriority: (v: TaskPriority) => void;
  users: Profile[];
  isAdmin: boolean;
}) {
  return (
    <>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Title</label>
        <input
          type="text"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          placeholder="e.g. Reconcile Bank A for March"
        />
      </div>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Description / notes</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          placeholder="Details, links, ongoing notes…"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Status</label>
          <ThemedSelect
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="todo">To Do</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
          </ThemedSelect>
          <label className="block text-sm text-slate-700 mb-1 mt-3">Priority</label>
          <ThemedSelect
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            {(["low", "medium", "high", "urgent"] as TaskPriority[]).map((p) => (
              <option key={p} value={p}>{TASK_PRIORITY_LABEL[p]}</option>
            ))}
          </ThemedSelect>
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Due date</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            disabled={!isAdmin}
            min={todayIso()}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50"
          />
        </div>
      </div>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Assignee</label>
        <ThemedSelect
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          disabled={!isAdmin}
          className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50"
        >
          <option value="">Unassigned</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name ?? u.email}
            </option>
          ))}
        </ThemedSelect>
        {!isAdmin && (
          <p className="text-[11px] text-slate-500 mt-1">
            Only admins can reassign tasks.
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The edit dialog as a non-admin sees it: everything about the task, and the one
 * field they may change.
 *
 * 0418 moved the field-level rule into the database — `tasks_guard_privileged_fields`
 * refuses any change to title, description, priority, due date or assignee from
 * a user who is not a super_admin or the SSA. This component is the honest UI
 * for that rule. It is NOT the enforcement, and it must not be mistaken for it:
 * the form previously disabled the same inputs and the API accepted the writes
 * anyway, which is precisely the gap the trigger closes.
 */
function TaskReadOnlyFields({
  task,
  status,
  setStatus,
}: {
  task: Task;
  status: TaskStatus;
  setStatus: (v: TaskStatus) => void;
}) {
  return (
    <>
      <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
        <div className="px-3 py-2">
          <p className="text-xs text-slate-500">Title</p>
          <p className="text-sm text-slate-900">{task.title}</p>
        </div>
        {task.description && (
          <div className="px-3 py-2">
            <p className="text-xs text-slate-500">Description</p>
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{task.description}</p>
          </div>
        )}
        <div className="px-3 py-2 grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-slate-500">Priority</p>
            <p className="text-sm text-slate-700">{TASK_PRIORITY_LABEL[task.priority ?? "medium"]}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Due date</p>
            <p className="text-sm text-slate-700">
              {task.due_date ? formatDate(task.due_date) : "None"}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" strokeWidth={1.5} />
        <span>
          Only an admin can change the title, description, priority, due date or assignee.
          You can move this task between columns and keep your own checklist below.
        </span>
      </div>

      <div>
        <label className="block text-sm text-slate-700 mb-1">Status</label>
        <ThemedSelect
          value={status}
          onChange={(e) => setStatus(e.target.value as TaskStatus)}
          className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
        >
          <option value="todo">To Do</option>
          <option value="in_progress">In Progress</option>
          <option value="done">Done</option>
        </ThemedSelect>
      </div>
    </>
  );
}
