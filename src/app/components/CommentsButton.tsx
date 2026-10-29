import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { CheckCircle2, Loader2, MessageSquare, X } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth } from "../lib/auth";

/**
 * Comments on one record (0606). A conversation is seen ONLY by the person who
 * started it and the people tagged in it — not by admins, not by the record's
 * owners (Shayan, 29 Oct 2026). Each thread carries the record's label, written
 * by the database from the record itself, so everyone tagged sees exactly
 * which expense / invoice / employee / payslip it is about. Tagging and every
 * reply are emailed to everyone else in the thread (comment-mail).
 */

export type CommentRecordType = "expense" | "invoice" | "employee" | "payslip";

export type Thread = {
  id: string; record_type: CommentRecordType; record_id: string; record_label: string; record_path: string;
  created_by: string; created_at: string; resolved_at: string | null;
};
export type Message = { id: string; thread_id: string; author_id: string; author_name: string | null; body: string; created_at: string };
export type Participant = { thread_id: string; user_id: string; name: string | null; last_read_at: string | null };
type Person = { id: string; name: string };

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Everyone in the thread, read by RLS — only a participant gets anything back. */
export async function loadThreads(filter: { recordType?: CommentRecordType; recordId?: string; ids?: string[] }) {
  let q = supabase.from("comment_threads").select("*").order("created_at", { ascending: false });
  if (filter.recordType) q = q.eq("record_type", filter.recordType);
  if (filter.recordId) q = q.eq("record_id", filter.recordId);
  if (filter.ids) q = q.in("id", filter.ids);
  const { data: threads, error } = await q;
  if (error) throw error;
  const ids = (threads ?? []).map((t) => t.id as string);
  if (!ids.length) return { threads: [] as Thread[], messages: [] as Message[], people: [] as Participant[] };
  const [m, p] = await Promise.all([
    supabase.from("comment_messages").select("*").in("thread_id", ids).order("created_at"),
    supabase.from("comment_participants").select("thread_id, user_id, name, last_read_at").in("thread_id", ids),
  ]);
  return { threads: (threads ?? []) as Thread[], messages: (m.data ?? []) as Message[], people: (p.data ?? []) as Participant[] };
}

/** The tag picker: the caller's active colleagues, names only (comment_people). */
export function useColleagues() {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    void supabase.rpc("comment_people").then(({ data }) => setPeople((data ?? []) as Person[]));
  }, []);
  return people;
}

export function TagPicker({ people, value, onChange, exclude = [] }: {
  people: Person[]; value: string[]; onChange: (v: string[]) => void; exclude?: string[];
}) {
  const [q, setQ] = useState("");
  const chosen = people.filter((p) => value.includes(p.id));
  const options = people.filter((p) => !value.includes(p.id) && !exclude.includes(p.id) && p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {chosen.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
            @{p.name}
            <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter((v) => v !== p.id))}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tag someone…"
        className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground" />
      {q && options.length > 0 && (
        <ul className="max-h-40 overflow-y-auto rounded-lg border border-border text-sm">
          {options.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => { onChange([...value, p.id]); setQ(""); }}
                className="w-full px-2.5 py-1.5 text-left text-foreground hover:bg-muted/50">@{p.name}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One conversation: the record it is about, messages, reply box, resolve. */
export function ThreadView({ thread, messages, people, colleagues, onChanged }: {
  thread: Thread; messages: Message[]; people: Participant[]; colleagues: Person[]; onChanged: () => void;
}) {
  const { profile } = useAuth();
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void supabase.rpc("mark_comment_thread_read", { p_thread_id: thread.id }); }, [thread.id, messages.length]);

  const reply = async () => {
    if (!body.trim()) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("add_comment", { p_thread_id: thread.id, p_body: body.trim(), p_tag_more: tags.length ? tags : null });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setBody(""); setTags([]); onChanged();
  };
  const resolve = async (resolved: boolean) => {
    const { error } = await supabase.rpc("resolve_comment_thread", { p_thread_id: thread.id, p_resolved: resolved });
    if (error) setErr(friendlyDbError(error)); else onChanged();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
        <div className="min-w-0">
          <p className="lbl">About</p>
          <Link to={thread.record_path} className="text-sm font-medium text-brand-700 hover:underline">{thread.record_label}</Link>
          <p className="mt-0.5 text-xs text-muted-foreground">With {people.map((p) => p.name ?? "—").join(", ")}</p>
        </div>
        {thread.created_by === profile?.id && (
          <Button size="sm" variant="secondary" onClick={() => void resolve(!thread.resolved_at)}>
            <CheckCircle2 className="mr-1.5 h-4 w-4" strokeWidth={1.5} />{thread.resolved_at ? "Reopen" : "Mark resolved"}
          </Button>
        )}
      </div>
      {thread.resolved_at && <p className="text-xs text-up">Resolved {when(thread.resolved_at)}</p>}
      <ul className="flex flex-col gap-2">
        {messages.map((m) => (
          <li key={m.id} className={`rounded-lg px-3 py-2 text-sm ${m.author_id === profile?.id ? "bg-brand-50/60" : "bg-muted/50"}`}>
            <p className="text-xs text-muted-foreground">{m.author_name ?? "—"} · {when(m.created_at)}</p>
            <p className="mt-0.5 whitespace-pre-wrap text-foreground">{m.body}</p>
          </li>
        ))}
      </ul>
      {err && <p className="text-xs text-danger-700 dark:text-danger-500">{err}</p>}
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Reply…"
        className="rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground" />
      <TagPicker people={colleagues} value={tags} onChange={setTags} exclude={people.map((p) => p.user_id)} />
      <div className="flex justify-end">
        <Button size="sm" disabled={busy || !body.trim()} onClick={() => void reply()}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Reply
        </Button>
      </div>
    </div>
  );
}

/** The 💬 button on a record. Shows how many of the caller's threads are on it. */
export default function CommentsButton({ recordType, recordId, size = "sm" }: {
  recordType: CommentRecordType; recordId: string; size?: "sm" | "xs";
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ threads: Thread[]; messages: Message[]; people: Participant[] } | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const colleagues = useColleagues();

  const load = useCallback(async () => {
    try {
      const d = await loadThreads({ recordType, recordId });
      setData(d); setCount(d.threads.length);
    } catch (e) { setErr(friendlyDbError(e as never)); }
  }, [recordType, recordId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const start = async () => {
    if (!body.trim() || !tags.length) { setErr("Write something and tag at least one person."); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("start_comment_thread", { p_record_type: recordType, p_record_id: recordId, p_body: body.trim(), p_tagged: tags });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setBody(""); setTags([]); void load();
  };

  return (
    <>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="Comments — ask someone about this" aria-label="Comments"
        className={`inline-flex items-center gap-1 rounded text-muted-foreground hover:bg-border hover:text-foreground ${size === "xs" ? "p-0.5" : "px-1.5 py-1"}`}>
        <MessageSquare className={size === "xs" ? "h-3.5 w-3.5" : "h-4 w-4"} strokeWidth={1.5} />
        {count ? <span className="text-[10px] font-semibold">{count}</span> : null}
      </button>
      {open && (
        <Modal isOpen onClose={() => setOpen(false)} title="Comments" size="lg" error={err} onDismissError={() => setErr(null)}>
          <div className="flex flex-col gap-5" onClick={(e) => e.stopPropagation()}>
            {!data ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : (
              data.threads.map((t) => (
                <ThreadView key={t.id} thread={t} colleagues={colleagues}
                  messages={data.messages.filter((m) => m.thread_id === t.id)}
                  people={data.people.filter((p) => p.thread_id === t.id)} onChanged={() => void load()} />
              ))
            )}
            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <p className="lbl">New conversation</p>
              <p className="text-xs text-muted-foreground">Only the people you tag will see it. They get an email with a link here.</p>
              <TagPicker people={colleagues} value={tags} onChange={setTags} />
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="What needs explaining?"
                className="rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground" />
              <div className="flex justify-end">
                <Button size="sm" disabled={busy} onClick={() => void start()}>
                  {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Send
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
