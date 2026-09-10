import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
              <li key={item.id} className="flex items-center gap-2 group">
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
