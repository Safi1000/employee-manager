import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Lock } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth, hasPermission } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { formatDate } from "../../lib/date";
import { generateDailyOperationsReportPdf } from "../../lib/dailyReportPdf";

// Operations ▸ Daily Reports. One row per ACTIVE CLIENT for a chosen day, each
// with a free-text Details box; the branded PDF is built straight from those two
// columns. The old per-post form (post / required / present / exception note)
// was removed — this is a written client-by-client note, not a headcount
// reconciliation, and the headcount already lives on the Attendance board.
//
// "Active" is derived: a client with at least one contract in `active` status.
// There is no active flag on the client record itself.
//
// Details are stored per (client, DAY). Nothing needs clearing at midnight: a
// new day simply has no rows, so every box opens empty. Past days stay readable
// for the same reason, and are locked — the record of a day that has ended is
// not edited after the fact.

/**
 * Local calendar dates, never UTC.
 *
 * toISOString() converts to UTC first, and Pakistan is UTC+5 — so local midnight
 * is 19:00 the PREVIOUS day in UTC. Round-tripping a date through it silently
 * subtracts a day: "back" jumped two days at once and "next" appeared dead
 * because +1 day −1 timezone day landed back on the date you started from.
 */
const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const todayIso = () => isoOf(new Date());

const shiftDay = (iso: string, days: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  // Month is 0-based; Date normalises overflow, so day 0 and day 32 are fine.
  return isoOf(new Date(y, m - 1, d + days));
};

type ClientRow = { id: string; name: string };

export default function FieldOps() {
  const { company, profile } = useAuth();
  // Writing daily reports requires roster.edit (super_admin + SSA implicit).
  // Backend RLS (0313) enforces it on daily_client_reports; folding it into
  // `locked` makes the textarea read-only AND blocks saveOne for view-only users.
  const canWriteReports = hasPermission(profile, "roster.edit");
  const companyId = company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [date, setDate] = useState(todayIso());
  const [clients, setClients] = useState<ClientRow[]>([]);
  /** client_id -> details, for the selected day. */
  const [details, setDetails] = useState<Map<string, string>>(new Map());
  /** Clients whose box is mid-save or just saved, for the inline hint. */
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [savedAt, setSavedAt] = useState<Map<string, number>>(new Map());

  const isToday = date === todayIso();
  // A day that has ended is a record, not a draft. Future days cannot be typed
  // into either — there is nothing to report on a day that has not happened.
  const locked = !isToday || !canWriteReports;

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setErr(null);
    const [cli, rep] = await Promise.all([
      // Active = has at least one active contract. The inner join is what does
      // the filtering; !inner makes PostgREST drop clients with no match.
      supabase
        .from("clients")
        .select("id, name, contracts!inner(id, status)")
        .eq("company_id", companyId)
        .eq("contracts.status", "active")
        .order("name"),
      supabase
        .from("daily_client_reports")
        .select("client_id, details")
        .eq("company_id", companyId)
        .eq("report_date", date),
    ]);
    if (cli.error) { setErr(cli.error.message); setLoading(false); return; }
    if (rep.error) { setErr(rep.error.message); setLoading(false); return; }

    // A client with two active contracts comes back twice through the join.
    const seen = new Map<string, ClientRow>();
    for (const c of (cli.data ?? []) as any[]) {
      if (!seen.has(c.id)) seen.set(c.id, { id: c.id, name: c.name });
    }
    setClients([...seen.values()]);
    setDetails(
      new Map(((rep.data ?? []) as any[]).map((r) => [r.client_id as string, (r.details ?? "") as string])),
    );
    setLoading(false);
  }, [companyId, date]);

  useEffect(() => { load(); }, [load]);

  /**
   * Save one client's note. Called on blur rather than on every keystroke — the
   * field is a paragraph, not a search box, and a write per character would be
   * both noisy and racy. An empty note deletes its row, so an accidental entry
   * can be taken back and the day is not littered with blanks.
   */
  const saveOne = async (clientId: string, value: string) => {
    if (locked) return;
    setSaving((prev) => new Set(prev).add(clientId));
    setErr(null);
    const text = value.trim();
    const { data: userData } = await supabase.auth.getUser();
    const { error } = text
      ? await supabase.from("daily_client_reports").upsert(
          {
            company_id: companyId,
            client_id: clientId,
            report_date: date,
            details: text,
            updated_by: userData.user?.id ?? null,
          },
          { onConflict: "company_id,client_id,report_date" },
        )
      : await supabase
          .from("daily_client_reports")
          .delete()
          .eq("company_id", companyId)
          .eq("client_id", clientId)
          .eq("report_date", date);
    setSaving((prev) => { const n = new Set(prev); n.delete(clientId); return n; });
    if (error) { setErr(error.message); return; }
    setSavedAt((prev) => new Map(prev).set(clientId, Date.now()));
  };

  const rowsForPdf = useMemo(
    () => clients.map((c) => ({ client_name: c.name, details: details.get(c.id) ?? null })),
    [clients, details],
  );
  const filledCount = useMemo(
    () => clients.filter((c) => (details.get(c.id) ?? "").trim().length > 0).length,
    [clients, details],
  );

  const exportPdf = async () => {
    generateDailyOperationsReportPdf(company, date, rowsForPdf);
    setBusy(true);
    const { data: userData } = await supabase.auth.getUser();
    // The export record keeps its original column names; here total_posts counts
    // the clients listed and `reported` the ones with a note written.
    const { error } = await supabase.from("daily_report_exports").insert({
      company_id: companyId,
      report_date: date,
      total_posts: clients.length,
      reported: filledCount,
      silent: clients.length - filledCount,
      exceptions: 0,
      generated_by: userData.user?.id ?? null,
    });
    setBusy(false);
    if (error) setErr(error.message);
  };

  return (
    // Header is a SIBLING of the scroll area, not a child of it — that is what
    // makes it stay put. Inside the scrolling div its `sticky top-0` had no
    // fixed ancestor to pin against and it just scrolled away with the content.
    <>
      <Header
        title="Daily Reports"
        subtitle="A written note per active client, day by day, exported as a branded PDF"
      />

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

        <div className="space-y-3 pt-2 md:pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDate((d) => shiftDay(d, -1))}
                className="w-8 h-8 grid place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent"
                aria-label="Previous day"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <input
                type="date"
                value={date}
                max={todayIso()}
                onChange={(e) => setDate(e.target.value || todayIso())}
                className="px-3 py-2 border border-border rounded-md text-sm bg-card"
              />
              <button
                type="button"
                onClick={() => setDate((d) => shiftDay(d, 1))}
                disabled={isToday}
                className="w-8 h-8 grid place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent disabled:opacity-40 disabled:pointer-events-none"
                aria-label="Next day"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              {!isToday && (
                <Button variant="secondary" size="sm" onClick={() => setDate(todayIso())}>
                  Today
                </Button>
              )}
            </div>
            <Button variant="secondary" size="sm" disabled={busy || clients.length === 0} onClick={exportPdf}>
              Download PDF
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            {formatDate(date)} · {clients.length} active client{clients.length === 1 ? "" : "s"} ·{" "}
            {filledCount} with details
            {locked && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-700 dark:text-amber-500">
                <Lock className="w-3 h-3" /> past day — read only
              </span>
            )}
          </p>

          {/* Not a <table>: with only two columns, a fixed 16rem client column
              left roughly 60px for the details box on a phone. As a grid the
              name sits above its textarea on mobile and beside it on desktop,
              and the textarea is always full width. */}
          <div className="border border-border rounded-md">
            <div className="hidden md:grid md:grid-cols-[16rem_1fr] bg-slate-50 dark:bg-card text-xs text-muted-foreground uppercase">
              <div className="px-3 py-2">Client</div>
              <div className="px-3 py-2">Details</div>
            </div>
            <div className="divide-y divide-border">
              {clients.map((c) => (
                <DetailsRow
                  key={c.id}
                  client={c}
                  value={details.get(c.id) ?? ""}
                  locked={locked}
                  saving={saving.has(c.id)}
                  savedAt={savedAt.get(c.id)}
                  onChange={(v) => setDetails((prev) => new Map(prev).set(c.id, v))}
                  onCommit={(v) => saveOne(c.id, v)}
                />
              ))}
              {clients.length === 0 && !loading && (
                <div className="px-3 py-4 text-muted-foreground text-sm">
                  No clients with an active contract.
                </div>
              )}
              {loading && (
                <div className="px-3 py-4 text-muted-foreground text-sm">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * One client's line. Keeps its own draft while focused so a reload of the day's
 * saved values cannot yank half-typed text out from under the cursor, and only
 * writes on blur.
 */
function DetailsRow({
  client, value, locked, saving, savedAt, onChange, onCommit,
}: {
  client: ClientRow;
  value: string;
  locked: boolean;
  saving: boolean;
  savedAt: number | undefined;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  const committed = useRef(value);
  useEffect(() => { committed.current = value; }, [client.id]);

  return (
    <div className="md:grid md:grid-cols-[16rem_1fr] md:items-start">
      <div className="px-3 pt-2 md:py-2 text-foreground font-medium text-sm md:whitespace-nowrap md:truncate">
        {client.name}
      </div>
      <div className="px-3 pb-2 pt-1 md:py-2">
        {locked ? (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{value.trim() || "—"}</p>
        ) : (
          <div className="flex items-start gap-2">
            <textarea
              rows={2}
              value={value}
              placeholder="Details for this client today…"
              onChange={(e) => onChange(e.target.value)}
              onBlur={(e) => {
                // Nothing typed since the last save = nothing to write.
                if (e.target.value === committed.current) return;
                committed.current = e.target.value;
                onCommit(e.target.value);
              }}
              className="flex-1 min-w-0 px-3 py-2 border border-border rounded-md text-sm bg-card resize-y min-h-[38px]"
            />
            <span className="text-[11px] text-muted-foreground pt-2.5 w-12 shrink-0">
              {saving ? "saving…" : savedAt ? "saved" : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
