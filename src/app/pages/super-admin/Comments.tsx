import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Loader2, MessageSquare } from "lucide-react";
import Header from "../../components/Header";
import { ThreadView, loadThreads, useColleagues, type Message, type Participant, type Thread } from "../../components/CommentsButton";
import { useAuth } from "../../lib/auth";
import { friendlyDbError } from "../../lib/supabase";

/**
 * Comments inbox (0606): every conversation the signed-in person is in — and
 * only those; nobody else's are readable. Unread threads first. The email a
 * tag or reply sends links here with ?thread=<id>.
 */

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function Comments() {
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ threads: Thread[]; messages: Message[]; people: Participant[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState<"open" | "resolved">("open");
  const colleagues = useColleagues();
  const selected = params.get("thread");

  const load = useCallback(async () => {
    try { setData(await loadThreads({})); } catch (e) { setErr(friendlyDbError(e as never)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.threads
      .filter((t) => (show === "open" ? !t.resolved_at : !!t.resolved_at) || t.id === selected)
      .map((t) => {
        const msgs = data.messages.filter((m) => m.thread_id === t.id);
        const last = msgs[msgs.length - 1];
        const me = data.people.find((p) => p.thread_id === t.id && p.user_id === profile?.id);
        const unread = msgs.some((m) => m.author_id !== profile?.id && (!me?.last_read_at || m.created_at > me.last_read_at));
        return { t, last, unread };
      })
      .sort((a, b) => Number(b.unread) - Number(a.unread) || (b.last?.created_at ?? "").localeCompare(a.last?.created_at ?? ""));
  }, [data, show, selected, profile?.id]);

  const current = data?.threads.find((t) => t.id === selected) ?? null;

  return (
    <div className="flex h-full flex-col">
      <Header title="Comments" subtitle="Conversations you started or were tagged in. Only the people in a conversation can see it." />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        {err && <p className="mb-3 text-sm text-danger-700 dark:text-danger-500">{err}</p>}
        <div className="grid gap-4 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <div className="rounded-2xl border border-border bg-card">
            <div className="flex gap-1 border-b border-border p-2">
              {(["open", "resolved"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setShow(k)}
                  className={`rounded-lg px-3 py-1 text-xs font-medium ${show === k ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                  {k === "open" ? "Open" : "Resolved"}
                </button>
              ))}
            </div>
            {!data ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : rows.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                {show === "open" ? "No open conversations. Use the 💬 button on an expense, invoice, employee or payslip to ask someone about it." : "Nothing resolved yet."}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {rows.map(({ t, last, unread }) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => setParams({ thread: t.id })}
                      className={`w-full px-3 py-2.5 text-left hover:bg-muted/40 ${t.id === selected ? "bg-muted/60" : ""}`}>
                      <p className={`truncate text-sm ${unread ? "font-semibold text-foreground" : "text-foreground"}`}>
                        {unread && <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-brand-500 align-middle" />}
                        {t.record_label}
                      </p>
                      {last && (
                        <p className="truncate text-xs text-muted-foreground">{last.author_name ?? "—"}: {last.body} · {when(last.created_at)}</p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 md:p-5">
            {current && data ? (
              <ThreadView thread={current} colleagues={colleagues}
                messages={data.messages.filter((m) => m.thread_id === current.id)}
                people={data.people.filter((p) => p.thread_id === current.id)} onChanged={() => void load()} />
            ) : (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                <MessageSquare className="h-6 w-6" strokeWidth={1.5} />
                {selected && data ? "This conversation isn't one you're in." : "Choose a conversation."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
