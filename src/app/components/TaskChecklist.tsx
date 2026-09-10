import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2, Plus, Trash2 } from "lucide-react";
import { supabase, type TaskChecklistItem } from "../lib/supabase";

/**
 * The assignee's personal checklist on one task (0418).
 *
 * "Personal" means it belongs to whoever the task is assigned to — their own
 * breakdown of the work, which the task's title and description have no room
 * for. Admins and the SSA can read and edit it; nobody else can see it at all.
 * That visibility is enforced by RLS on `task_checklist_items`, not here: this
 * component sends a plain select, and a user with no business seeing a list
 * gets an empty one from the database rather than a hidden one from the UI.
 *
 * `canEdit` therefore controls the CONTROLS, not the access. A viewer who
 * somehow reaches this with canEdit=false still cannot write, because the
 * policy would refuse the write regardless.
 */
export default function TaskChecklist({
  taskId,
  canEdit,
  onError,
}: {
  taskId: string;
  canEdit: boolean;
  onError?: (message: string) => void;
}) {
  const [items, setItems] = useState<TaskChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Which item currently has its reminder editor open. One at a time: the rows
  // are narrow and two open editors would push the list around while the user
  // is typing into one of them.
  const [remindingId, setRemindingId] = useState<string | null>(null);
  const [remindAt, setRemindAt] = useState("");


  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("task_checklist_items")
      .select("*")
      .eq("task_id", taskId)
      .order("position")
      .order("created_at");
    if (error) onError?.(error.message);
    setItems((data ?? []) as TaskChecklistItem[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const add = async () => {
    const label = draft.trim();
    if (!label) return;
    setBusy(true);
    // position is taken from the CURRENT tail rather than items.length: a list
    // that has had rows deleted has gaps, and length would reuse a number an
    // existing row already holds, which sorts the two arbitrarily.
    const nextPosition = items.length > 0 ? Math.max(...items.map((i) => i.position)) + 1 : 0;
    const { error } = await supabase
      .from("task_checklist_items")
      .insert({ task_id: taskId, label, position: nextPosition });
    setBusy(false);
    if (error) { onError?.(error.message); return; }
    setDraft("");
    await load();
  };

  const toggle = async (item: TaskChecklistItem) => {
    // Optimistic: ticking a box that waits for a round trip feels broken, and
    // the reload below puts the truth back if the write was refused.
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)));
    const { error } = await supabase
      .from("task_checklist_items")
      .update({ done: !item.done })
      .eq("id", item.id);
    if (error) { onError?.(error.message); await load(); }
  };

  const rename = async (item: TaskChecklistItem, label: string) => {
    const next = label.trim();
    if (!next || next === item.label) return;
    const { error } = await supabase
      .from("task_checklist_items")
      .update({ label: next })
      .eq("id", item.id);
    if (error) { onError?.(error.message); await load(); }
  };

  const remove = async (item: TaskChecklistItem) => {
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    const { error } = await supabase.from("task_checklist_items").delete().eq("id", item.id);
    if (error) { onError?.(error.message); await load(); }
  };

  // `datetime-local` speaks LOCAL wall-clock with no zone ("2026-09-14T17:00"),
  // and the column is timestamptz. new Date(localString) reads it in the
  // browser's zone, which is what the user meant by "5pm", and toISOString then
  // states that instant in UTC. Handing the raw string to Postgres instead
  // would have it read as UTC and shift every deadline by five hours.
  const armReminder = async (item: TaskChecklistItem) => {
    if (!remindAt) return;
    const dueIso = new Date(remindAt).toISOString();
    setBusy(true);
    const { error } = await supabase
      .from("task_checklist_items")
      .update({ due_at: dueIso, reminders_on: true })
      .eq("id", item.id);
    setBusy(false);
    if (error) { onError?.(error.message); return; }
    setRemindingId(null);
    setRemindAt("");
    await load();
  };

  const disarmReminder = async (item: TaskChecklistItem) => {
    // due_at is left in place. Turning reminders off is not the same statement
    // as "this has no deadline any more", and clearing it would silently throw
    // away a date the user typed the moment they asked for quiet.
    const { error } = await supabase
      .from("task_checklist_items")
      .update({ reminders_on: false })
      .eq("id", item.id);
    if (error) { onError?.(error.message); return; }
    setRemindingId(null);
    await load();
  };

  // The value a datetime-local input wants: local wall-clock, no zone, minutes.
  const toLocalInput = (iso: string | null) => {
    const d = iso ? new Date(iso) : new Date(Date.now() + 24 * 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const fmtDue = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });

  const doneCount = items.filter((i) => i.done).length;

  return (
    <div className="border border-border rounded-md">
      <div className="flex items-center justify-between px-3 py-2 bg-muted border-b border-border">
        <span className="text-sm text-foreground">Checklist</span>
        <span className="text-xs text-muted-foreground">
          {items.length === 0 ? "Empty" : `${doneCount} of ${items.length} done`}
        </span>
      </div>

      <div className="p-3 space-y-2">
        {loading ? (
          <div className="text-xs text-muted-foreground py-2">
            <Loader2 className="w-3 h-3 animate-spin inline-block mr-1" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <p className="text-xs text-muted-foreground py-1">
            {canEdit
              ? "Nothing yet. Break the task into steps below — this list is yours."
              : "The assignee has not added anything."}
          </p>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.id} className="space-y-1">
              <div className="flex items-center gap-2 group">
                <input
                  type="checkbox"
                  checked={item.done}
                  disabled={!canEdit}
                  onChange={() => toggle(item)}
                  className="flex-shrink-0"
                />
                {canEdit ? (
                  // defaultValue + onBlur, not value + onChange: a controlled
                  // input here would round-trip to the database on every
                  // keystroke. The blur is the edit.
                  <input
                    type="text"
                    defaultValue={item.label}
                    onBlur={(e) => rename(item, e.target.value)}
                    className={`flex-1 bg-transparent text-sm border-0 border-b border-transparent focus:border-border focus:outline-none px-0 py-0.5 ${
                      item.done ? "line-through text-muted-foreground" : "text-foreground"
                    }`}
                  />
                ) : (
                  <span
                    className={`flex-1 text-sm ${
                      item.done ? "line-through text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    {item.label}
                  </span>
                )}
                {/* Armed items show their deadline inline. An armed reminder
                    you cannot see the time of is indistinguishable from one
                    that silently failed to save. */}
                {item.reminders_on && item.due_at && (
                  <span
                    className={`text-[11px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                      new Date(item.due_at).getTime() < Date.now()
                        ? "bg-danger-50 text-danger-700"
                        : "bg-warning-50 text-warning-700"
                    }`}
                  >
                    {fmtDue(item.due_at)}
                  </span>
                )}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      if (remindingId === item.id) { setRemindingId(null); return; }
                      setRemindingId(item.id);
                      setRemindAt(toLocalInput(item.due_at));
                    }}
                    className={`p-1 rounded flex-shrink-0 transition-opacity ${
                      item.reminders_on
                        ? "text-warning-600 hover:text-warning-700"
                        : "text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"
                    }`}
                    title={item.reminders_on ? "Reminders on — change or turn off" : "Remind me about this"}
                  >
                    {item.reminders_on
                      ? <Bell className="w-3.5 h-3.5" strokeWidth={2} />
                      : <BellOff className="w-3.5 h-3.5" strokeWidth={1.5} />}
                  </button>
                )}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => remove(item)}
                    className="p-1 text-muted-foreground hover:text-danger-600 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex-shrink-0"
                    title="Remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                )}
              </div>

              {remindingId === item.id && canEdit && (
                <div className="ml-6 p-2 rounded-md border border-border bg-muted space-y-2">
                  <label className="block text-[11px] text-muted-foreground">
                    When is this sub-task due?
                  </label>
                  <input
                    type="datetime-local"
                    value={remindAt}
                    onChange={(e) => setRemindAt(e.target.value)}
                    className="w-full px-2 py-1 text-sm border border-border rounded bg-input-background focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    You&apos;ll be emailed 3 days before, 1 day before, and about 3 hours before.
                    Ticking it off stops the reminders.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy || !remindAt}
                      onClick={() => void armReminder(item)}
                      className="px-2 py-1 text-xs rounded border border-border bg-card text-foreground hover:bg-accent disabled:opacity-40"
                    >
                      {item.reminders_on ? "Update reminder" : "Remind me"}
                    </button>
                    {item.reminders_on && (
                      <button
                        type="button"
                        onClick={() => void disarmReminder(item)}
                        className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:bg-accent"
                      >
                        Turn off
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setRemindingId(null)}
                      className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="flex items-center gap-2 pt-1">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              // The form around this modal submits on Enter, which would save
              // the whole task instead of adding a line. Claim the key.
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
              placeholder="Add a step…"
              className="flex-1 px-3 py-1.5 text-sm border border-border rounded-md bg-input-background focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500"
            />
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy || !draft.trim()}
              className="p-1.5 rounded-md border border-border text-foreground hover:bg-accent disabled:opacity-40 flex-shrink-0"
              title="Add"
            >
              <Plus className="w-4 h-4" strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
