import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ClipboardCheck, Loader2, Target, X } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * Employee profile completion, group by group (0601). One row per client, then
 * Head Office, Relievers and staff not under any client: how many are complete,
 * the field most often missing, and the group's target — who is completing it,
 * by when. The counts are profile_completion()'s, over the employees the viewer
 * can already read; nothing here adds anything up.
 *
 * Clicking a row filters the roster below to that group's incomplete staff. A
 * super admin sets, moves and closes targets; each target is also a task on
 * the assignee's Task Board.
 */

export type CompletionGroup = {
  bucket: "client" | "office_staff" | "reliever" | "unassigned";
  client_id: string | null;
  label: string;
  staff: number;
  complete: number;
  incomplete: number;
  top_missing: string | null;
  target_id: string | null;
  assigned_to: string | null;
  assignee_name: string | null;
  due_date: string | null;
  overdue: boolean;
};

type Person = { id: string; full_name: string | null; email: string | null };

const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export default function ProfileCompletionPanel({
  canSetTargets,
  onPick,
}: {
  canSetTargets: boolean;
  onPick: (g: CompletionGroup) => void;
}) {
  const [rows, setRows] = useState<CompletionGroup[] | null>(null);
  const [open, setOpen] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [editing, setEditing] = useState<CompletionGroup | null>(null);
  const [who, setWho] = useState("");
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [modalErr, setModalErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("profile_completion");
    if (error) { setErr(friendlyDbError(error)); return; }
    setErr(null);
    setRows((data ?? []) as CompletionGroup[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!canSetTargets) return;
    void supabase.from("profiles").select("id, full_name, email").is("disabled_at", null).order("full_name")
      .then(({ data }) => setPeople((data ?? []) as Person[]));
  }, [canSetTargets]);

  const startEdit = (g: CompletionGroup) => {
    setEditing(g);
    setWho(g.assigned_to ?? "");
    setDue(g.due_date ?? "");
    setNote("");
    setModalErr(null);
  };

  const save = async () => {
    if (!editing) return;
    if (!who || !due) { setModalErr("Choose who and by when."); return; }
    setBusy(true); setModalErr(null);
    const { error } = await supabase.rpc("set_profile_target", {
      p_bucket: editing.bucket, p_client_id: editing.client_id, p_assigned_to: who, p_due_date: due, p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) { setModalErr(friendlyDbError(error)); return; }
    setEditing(null);
    void load();
  };

  const close = async (g: CompletionGroup) => {
    if (!g.target_id) return;
    if (!window.confirm(`Close the target for ${g.label}? Its Task Board task is marked done.`)) return;
    const { error } = await supabase.rpc("close_profile_target", { p_target_id: g.target_id });
    if (error) { setErr(friendlyDbError(error)); return; }
    void load();
  };

  const total = rows?.reduce((s, r) => s + r.staff, 0) ?? 0;
  const incomplete = rows?.reduce((s, r) => s + r.incomplete, 0) ?? 0;

  return (
    <div className="mb-4 rounded-2xl border border-border bg-card p-4 md:p-5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full flex-wrap items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <span className="text-sm font-semibold text-foreground">Profile completion</span>
          {rows && (
            <span className={`text-xs ${incomplete ? "text-heed" : "text-up"}`}>
              {incomplete ? `${incomplete} of ${total} active staff incomplete` : "Every profile complete"}
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">Click a group to list its incomplete staff</span>
      </button>

      {err && <p className="mt-2 text-xs text-danger-700 dark:text-danger-500">{err}</p>}
      {open && !rows && !err && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
      )}

      {open && rows && (
        <div className="mt-3 max-h-96 overflow-y-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-medium">Group</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Incomplete</th>
                <th className="hidden px-2.5 py-1.5 text-left font-medium sm:table-cell">Done</th>
                <th className="hidden px-2.5 py-1.5 text-left font-medium md:table-cell">Most missing</th>
                <th className="px-2.5 py-1.5 text-left font-medium">Target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((g) => {
                const pct = g.staff ? Math.round((g.complete / g.staff) * 100) : 100;
                const key = `${g.bucket}:${g.client_id ?? ""}`;
                return (
                  <tr key={key} className="cursor-pointer hover:bg-muted/40" onClick={() => onPick(g)}>
                    <td className="px-2.5 py-1.5 text-foreground">
                      {g.label}
                      {g.bucket !== "client" && <span className="ml-1.5 text-[10px] text-muted-foreground">({g.staff})</span>}
                    </td>
                    <td className={`px-2.5 py-1.5 text-right font-ledger ${g.incomplete ? "text-foreground" : "text-up"}`}>
                      {g.incomplete}<span className="text-muted-foreground"> / {g.staff}</span>
                    </td>
                    <td className="hidden px-2.5 py-1.5 sm:table-cell">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                          <div className={`h-full ${pct === 100 ? "bg-up" : "bg-brand-500"}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="font-ledger text-muted-foreground">{pct}%</span>
                      </div>
                    </td>
                    <td className="hidden px-2.5 py-1.5 text-muted-foreground md:table-cell">{g.top_missing ?? "—"}</td>
                    <td className="px-2.5 py-1.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        {g.target_id ? (
                          <span className={g.incomplete === 0 ? "text-up" : g.overdue ? "font-semibold text-down" : "text-foreground"}>
                            {g.assignee_name ?? "—"} · {g.incomplete === 0 ? "Reached 100%" : `${g.overdue ? "overdue " : "by "}${g.due_date ? day(g.due_date) : ""}`}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {canSetTargets && (
                          <>
                            <button type="button" title={g.target_id ? "Move target" : "Set target"} aria-label={g.target_id ? "Move target" : "Set target"}
                              onClick={() => startEdit(g)} className="rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground">
                              <Target className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </button>
                            {g.target_id && (
                              <button type="button" title="Close target" aria-label="Close target"
                                onClick={() => void close(g)} className="rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground">
                                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal isOpen onClose={() => setEditing(null)} title={`Target — ${editing.label}`} size="sm" error={modalErr} onDismissError={() => setModalErr(null)}>
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              {editing.incomplete} of {editing.staff} still incomplete{editing.top_missing ? `, most often missing ${editing.top_missing}` : ""}.
              The target also goes on the assignee&apos;s Task Board.
            </p>
            <label className="flex flex-col gap-1 text-xs">
              <span className="lbl">Who completes it</span>
              <select value={who} onChange={(e) => setWho(e.target.value)}
                className="rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground">
                <option value="">Choose…</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.email}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="lbl">By when</span>
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)}
                className="rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="lbl">Note (optional)</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                className="rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground" />
            </label>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}{editing.target_id ? "Move target" : "Set target"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
