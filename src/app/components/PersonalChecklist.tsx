import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2, Plus, Trash2 } from "lucide-react";
import { supabase, type PersonalChecklistItem, type Profile } from "../lib/supabase";
import ThemedSelect from "./ThemedSelect";

/**
 * A user's own running checklist, shown beneath the task board (0421).
 *
 * This replaced a checklist that hung off one task. The difference is not
 * cosmetic: the old one answered "who may see this?" with "the assignee of its
 * task", and a collective list has no task to ask. It is scoped by `owner_id`
 * and nothing else.
 *
 * Each line can carry its own deadline and ask to be reminded — 3 days, 1 day
 * and about 3 hours before — delivered by the hourly `send-task-alerts` job to
 * the address the user set at the top of the board.
 *
 * VISIBILITY IS RLS'S JOB. Owners read and write their own; super_admin and the
 * SSA may READ anyone's in their company and write nobody's but their own. The
 * `viewingOther` flag below hides the controls, it does not create the
 * restriction — a write to someone else's list is refused by the policy whether
 * or not this component offers a button for it.
 */
export default function PersonalChecklist({
  me,
  isAdmin,
  users,
  onError,
}: {
  me: Profile | null;
  isAdmin: boolean;
  /** Everyone in the company, for the admin's "whose list?" picker. */
  users: Profile[];
  onError?: (message: string) => void;
}) {
  const [ownerId, setOwnerId] = useState<string>(me?.id ?? "");
  const [items, setItems] = useState<PersonalChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [remindingId, setRemindingId] = useState<string | null>(null);
  const [remindAt, setRemindAt] = useState("");

  // The auth context can arrive after the first render, so the owner is seeded
  // from a prop that may still be null. Without this the list would sit empty
  // for the one user who is guaranteed to have one — their own.
  useEffect(() => {
    if (me?.id && !ownerId) setOwnerId(me.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  const viewingOther = !!me?.id && ownerId !== me.id;
  const canEdit = !viewingOther;

  const load = async () => {
    if (!ownerId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("personal_checklist_items")
      .select("*")
      .eq("owner_id", ownerId)
      .order("position")
      .order("created_at");
    if (error) onError?.(error.message);
    setItems((data ?? []) as PersonalChecklistItem[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId]);

  const add = async () => {
    const label = draft.trim();
    if (!label) return;
    setBusy(true);
    // From the current tail, not items.length: a list that has had rows deleted
    // has gaps, and length would reuse a number an existing row holds, which
    // sorts the two arbitrarily.
    const nextPosition = items.length > 0 ? Math.max(...items.map((i) => i.position)) + 1 : 0;
    // owner_id is sent explicitly even though the trigger defaults it to
    // auth.uid(). They are the same value here, and saying so at the call site
    // is what makes the insert readable next to the policy that governs it.
    const { error } = await supabase
      .from("personal_checklist_items")
      .insert({ owner_id: ownerId, label, position: nextPosition });
    setBusy(false);
    if (error) { onError?.(error.message); return; }
    setDraft("");
    await load();
  };

  const toggle = async (item: PersonalChecklistItem) => {
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)));
    const { error } = await supabase
      .from("personal_checklist_items")
      .update({ done: !item.done })
      .eq("id", item.id);
    if (error) { onError?.(error.message); await load(); }
  };

  const rename = async (item: PersonalChecklistItem, label: string) => {
    const next = label.trim();
    if (!next || next === item.label) return;
    const { error } = await supabase
      .from("personal_checklist_items")
      .update({ label: next })
      .eq("id", item.id);
    if (error) { onError?.(error.message); await load(); }
  };

  const remove = async (item: PersonalChecklistItem) => {
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    const { error } = await supabase.from("personal_checklist_items").delete().eq("id", item.id);
    if (error) { onError?.(error.message); await load(); }
  };

  // `datetime-local` speaks LOCAL wall-clock with no zone ("2026-09-14T17:00")
  // and the column is timestamptz. new Date(localString) reads it in the
  // browser's zone — which is what the user meant by "5pm" — and toISOString
  // states that instant in UTC. Handing the raw string to Postgres instead
  // would have it read as UTC and shift every deadline by five hours.
  const armReminder = async (item: PersonalChecklistItem) => {
    if (!remindAt) return;
    setBusy(true);
    const { error } = await supabase
      .from("personal_checklist_items")
      .update({ due_at: new Date(remindAt).toISOString(), reminders_on: true })
      .eq("id", item.id);
    setBusy(false);
    if (error) { onError?.(error.message); return; }
    setRemindingId(null);
    setRemindAt("");
    await load();
  };

  const disarmReminder = async (item: PersonalChecklistItem) => {
    // due_at stays. "Stop emailing me" is not the same statement as "this has no
    // deadline any more", and clearing it would throw away a date the user typed
    // the moment they asked for quiet.
    const { error } = await supabase
      .from("personal_checklist_items")
      .update({ reminders_on: false })
      .eq("id", item.id);
    if (error) { onError?.(error.message); return; }
    setRemindingId(null);
    await load();
  };

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
  const ownerName =
    users.find((u) => u.id === ownerId)?.full_name ??
    users.find((u) => u.id === ownerId)?.email ??
    "this user";

  return (
    <div className="mt-6 border border-slate-200 rounded-lg bg-white">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 py-3 border-b border-slate-200">
        <div>
          <h3 className="text-sm text-slate-900">
            {viewingOther ? `Notes — ${ownerName}` : "My notes"}
          </h3>
          <p className="text-[11px] text-slate-500">
            {viewingOther
              ? "Read-only. Only the owner can change their own list."
              : "Your own running checklist. Set a deadline on any line to be reminded about it."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">
            {items.length === 0 ? "Empty" : `${doneCount} of ${items.length} done`}
          </span>
          {/* Admins pick whose list to read. Rendered only for them; for
              everyone else there is exactly one possible answer and a dropdown
              with one option is a question that should not have been asked. */}
          {isAdmin && users.length > 0 && (
            <ThemedSelect
              value={ownerId}
              onChange={(e) => { setRemindingId(null); setOwnerId(e.target.value); }}
              className="px-2 py-1 border border-slate-200 rounded-md text-xs"
            >
              {me?.id && <option value={me.id}>My notes</option>}
              {users
                .filter((u) => u.id !== me?.id)
                .map((u) => (
                  <option key={u.id} value={u.id}>{u.full_name ?? u.email}</option>
                ))}
            </ThemedSelect>
          )}
        </div>
      </div>

      <div className="p-4 space-y-2">
        {loading ? (
          <div className="text-xs text-slate-500 py-2">
            <Loader2 className="w-3 h-3 animate-spin inline-block mr-1" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <p className="text-xs text-slate-500 py-1">
            {canEdit ? "Nothing here yet. Add your first line below." : "Nothing here yet."}
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
                    // input here would round-trip on every keystroke. The blur
                    // is the edit.
                    <input
                      type="text"
                      defaultValue={item.label}
                      onBlur={(e) => rename(item, e.target.value)}
                      className={`flex-1 bg-transparent text-sm border-0 border-b border-transparent focus:border-slate-200 focus:outline-none px-0 py-0.5 ${
                        item.done ? "line-through text-slate-400" : "text-slate-900"
                      }`}
                    />
                  ) : (
                    <span className={`flex-1 text-sm ${item.done ? "line-through text-slate-400" : "text-slate-900"}`}>
                      {item.label}
                    </span>
                  )}

                  {/* An armed reminder whose time you cannot see is
                      indistinguishable from one that failed to save. */}
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
                          : "text-slate-400 hover:text-slate-700 opacity-0 group-hover:opacity-100 focus:opacity-100"
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
                      className="p-1 text-slate-400 hover:text-danger-600 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex-shrink-0"
                      title="Remove"
                    >
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </button>
                  )}
                </div>

                {remindingId === item.id && canEdit && (
                  <div className="ml-6 p-2 rounded-md border border-slate-200 bg-slate-50 space-y-2">
                    <label className="block text-[11px] text-slate-500">When is this due?</label>
                    <input
                      type="datetime-local"
                      value={remindAt}
                      onChange={(e) => setRemindAt(e.target.value)}
                      className="w-full px-2 py-1 text-sm border border-slate-200 rounded"
                    />
                    <p className="text-[11px] text-slate-500">
                      You&apos;ll be emailed 3 days before, 1 day before, and about 3 hours before.
                      Ticking it off stops the reminders.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy || !remindAt}
                        onClick={() => void armReminder(item)}
                        className="px-2 py-1 text-xs rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                      >
                        {item.reminders_on ? "Update reminder" : "Remind me"}
                      </button>
                      {item.reminders_on && (
                        <button
                          type="button"
                          onClick={() => void disarmReminder(item)}
                          className="px-2 py-1 text-xs rounded border border-slate-200 text-slate-500 hover:bg-slate-100"
                        >
                          Turn off
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setRemindingId(null)}
                        className="px-2 py-1 text-xs text-slate-500 hover:text-slate-700"
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
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void add(); }
              }}
              placeholder="Add a note…"
              className="flex-1 px-3 py-1.5 text-sm border border-slate-200 rounded-md"
            />
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy || !draft.trim()}
              className="p-1.5 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 flex-shrink-0"
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
