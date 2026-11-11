import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Loader2, Undo2, Upload } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { supabase, friendlyDbError, fetchAllRows } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useRegion } from "../lib/region";
import { formatDate } from "../lib/date";
import { downloadTemplate, readTemplate, codeFor, daysIn, type Parsed, type TemplateGuard } from "../lib/attendanceImport";
import { askReason } from "./askReason";

/**
 * IMPORT A MONTH (0638, 3 Nov 2026). Pick the client and month → download the
 * template (prefilled with the guards and what Bastion already has) → fill it →
 * upload → read the dry run → confirm with a reason. Nothing is written before
 * the confirm, and the confirm is all or nothing. The latest import for the
 * client and month can be undone here.
 */
type Client = { id: string; name: string; branch_id: string | null };
type GuardResult = { employee_id: string; name: string; code: string; added: number | null; changed: number | null; removed: number | null; same: number | null; app_replaced: number | null; error: string | null };
type RunResult = { preview: boolean; import_id: string | null; guards: GuardResult[]; totals: { guards: number; added: number; changed: number; removed: number; same: number; app_replaced: number; refused: number }; same_file_imported_before: boolean };
type PastImport = { id: string; file_name: string | null; note: string; guards: number; marks_added: number; marks_changed: number; marks_removed: number; created_at: string; undone_at: string | null; undo_reason: string | null };

type Pageable = { range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }> };
const lastMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };

export default function AttendanceImportModal({ isOpen, onClose, onImported }: { isOpen: boolean; onClose: () => void; onImported?: () => void }) {
  const { company } = useAuth();
  const { regionId } = useRegion();
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [month, setMonth] = useState(lastMonth());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [rowsForRpc, setRowsForRpc] = useState<{ employee_id: string; marks: Record<string, string> }[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [done, setDone] = useState<RunResult | null>(null);
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  const [replaceApp, setReplaceApp] = useState(false);
  const [past, setPast] = useState<PastImport[]>([]);

  const client = clients.find((c) => c.id === clientId);
  const reset = () => { setFile(null); setParsed(null); setRowsForRpc([]); setWarnings([]); setResult(null); setDone(null); setNote(""); setChecked(false); setReplaceApp(false); setErr(null); };

  useEffect(() => {
    if (!isOpen || !company?.id) return;
    void supabase.from("clients").select("id, name, branch_id").eq("company_id", company.id).order("name").then(({ data }) => {
      setClients(((data ?? []) as Client[]).filter((c) => !/\(merged/i.test(c.name) && (!regionId || c.branch_id === regionId)));
    });
  }, [isOpen, company?.id, regionId]);

  const loadPast = useCallback(async () => {
    if (!clientId) { setPast([]); return; }
    const { data } = await supabase.from("attendance_imports")
      .select("id, file_name, note, guards, marks_added, marks_changed, marks_removed, created_at, undone_at, undo_reason")
      .eq("client_id", clientId).eq("period_month", `${month}-01`).order("created_at", { ascending: false });
    setPast((data ?? []) as PastImport[]);
  }, [clientId, month]);
  useEffect(() => { void loadPast(); }, [loadPast]);
  useEffect(() => { reset(); }, [clientId, month]);

  // ── Template: the client's guards (active, plus anyone marked there this month) and their marks.
  const template = async () => {
    if (!client || !company?.id) return;
    setBusy("template"); setErr(null);
    try {
      const first = `${month}-01`, last = `${month}-${String(daysIn(month)).padStart(2, "0")}`;
      const [emps, recs, sites] = await Promise.all([
        fetchAllRows<{ id: string; guard_code: string | null; full_name: string }>(() =>
          supabase.from("employees").select("id, guard_code, full_name").eq("company_id", company.id).eq("client_id", client.id).eq("lifecycle_state", "active").order("full_name") as unknown as Pageable),
        fetchAllRows<{ employee_id: string; attendance_date: string; status: string; site_id: string | null }>(() =>
          supabase.from("attendance_records").select("employee_id, attendance_date, status, site_id").eq("worked_for_client_id", client.id).gte("attendance_date", first).lte("attendance_date", last).order("attendance_date") as unknown as Pageable),
        supabase.from("sites").select("id, name").eq("client_id", client.id),
      ]);
      const extraIds = [...new Set(recs.map((r) => r.employee_id))].filter((id) => !emps.some((e) => e.id === id));
      const extra = extraIds.length
        ? ((await supabase.from("employees").select("id, guard_code, full_name").in("id", extraIds)).data ?? []) as typeof emps
        : [];
      const siteName = new Map(((sites.data ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]));
      const guards: TemplateGuard[] = [...emps, ...extra].filter((e) => e.guard_code).map((e) => {
        const mine = recs.filter((r) => r.employee_id === e.id);
        const marks: Record<number, string> = {};
        for (const r of mine) marks[Number(r.attendance_date.slice(8, 10))] = codeFor(r.status);
        const site = mine.map((r) => r.site_id).filter(Boolean).pop();
        return { guard_code: e.guard_code!, full_name: e.full_name, site: site ? siteName.get(site) ?? "" : "", marks };
      }).sort((a, b) => a.site.localeCompare(b.site) || a.full_name.localeCompare(b.full_name));
      await downloadTemplate({ clientId: client.id, clientName: client.name, month, guards });
    } catch (e) { setErr(friendlyDbError(e)); }
    setBusy(null);
  };

  // ── Upload: read the file, check it is this client's month, match codes, then dry-run.
  const upload = async (f: File) => {
    if (!client || !company?.id) return;
    reset(); setFile(f); setBusy("read");
    try {
      const p = await readTemplate(f);
      setParsed(p);
      const problems = [...p.problems];
      if (p.clientId !== client.id) problems.unshift(`This sheet is for a different client. It was downloaded for client id ${p.clientId}, and you picked ${client.name}.`);
      if (p.month !== month) problems.unshift(`This sheet is for ${p.month}, and you picked ${month}.`);
      const codes = [...new Set(p.rows.map((r) => r.guard_code))];
      const dupes = p.rows.filter((r, i) => p.rows.findIndex((x) => x.guard_code === r.guard_code) !== i);
      for (const d of dupes) problems.push(`${d.guard_code} is in the sheet twice (row ${d.line}).`);
      const { data: emps, error } = codes.length
        ? await supabase.from("employees").select("id, guard_code, full_name").eq("company_id", company.id).in("guard_code", codes)
        : { data: [], error: null };
      if (error) throw error;
      const byCode = new Map(((emps ?? []) as { id: string; guard_code: string; full_name: string }[]).map((e) => [e.guard_code.toUpperCase(), e]));
      const warn: string[] = [];
      const out: { employee_id: string; marks: Record<string, string> }[] = [];
      for (const r of p.rows) {
        const e = byCode.get(r.guard_code);
        if (!e) { problems.push(`Row ${r.line}: no guard has the code ${r.guard_code}.`); continue; }
        if (r.name && e.full_name.toLowerCase().replace(/\s+/g, "") !== r.name.toLowerCase().replace(/\s+/g, "")) {
          warn.push(`Row ${r.line}: ${r.guard_code} is ${e.full_name} in Bastion; the sheet says "${r.name}". The code decides — check it is the same man.`);
        }
        out.push({ employee_id: e.id, marks: r.marks });
      }
      setWarnings(warn);
      if (problems.length) { setParsed({ ...p, problems }); setBusy(null); return; }
      setRowsForRpc(out);
      await dryRun(out, p.sha256, f.name, false);
    } catch (e) { setErr(e instanceof Error ? e.message : friendlyDbError(e)); }
    setBusy(null);
  };

  const dryRun = async (rows = rowsForRpc, sha = parsed?.sha256, name = file?.name, app = replaceApp) => {
    if (!client) return;
    setBusy("preview");
    const { data, error } = await supabase.rpc("import_attendance_month", {
      p_client_id: client.id, p_month: `${month}-01`, p_rows: rows, p_file_name: name ?? null, p_file_sha256: sha ?? null,
      p_note: null, p_preview: true, p_replace_app_marks: app,
    });
    setBusy(null);
    if (error) { setErr(friendlyDbError(error)); return; }
    setResult(data as RunResult);
  };

  const commit = async () => {
    if (!client || !result) return;
    setBusy("commit"); setErr(null);
    const { data, error } = await supabase.rpc("import_attendance_month", {
      p_client_id: client.id, p_month: `${month}-01`, p_rows: rowsForRpc, p_file_name: file?.name ?? null, p_file_sha256: parsed?.sha256 ?? null,
      p_note: note.trim(), p_preview: false, p_replace_app_marks: replaceApp,
    });
    setBusy(null);
    if (error) { setErr(friendlyDbError(error)); return; }
    setDone(data as RunResult); setResult(null);
    void loadPast(); onImported?.();
  };

  const undo = async (imp: PastImport) => {
    const reason = await askReason({
      title: "Undo attendance import",
      subject: { title: `Import of ${formatDate(imp.created_at)}` },
      warning: "Every mark it wrote is removed — including any edited since — and the marks it replaced come back.",
      label: "Why is it being undone?",
      confirmLabel: "Undo import",
      tone: "danger",
    });
    if (!reason) return;
    setBusy("undo"); setErr(null);
    const { error } = await supabase.rpc("undo_attendance_import", { p_import_id: imp.id, p_reason: reason.trim() });
    setBusy(null);
    if (error) { setErr(friendlyDbError(error)); return; }
    reset(); void loadPast(); onImported?.();
  };

  const t = result?.totals;
  const blocked = !!result && (result.totals.refused > 0);
  const nothingToDo = !!t && t.added + t.changed + t.removed === 0;
  const latestLive = past.find((p) => !p.undone_at);
  const sorted = useMemo(() => (result?.guards ?? []).slice().sort((a, b) => Number(!!b.error) - Number(!!a.error) || ((b.removed ?? 0) - (a.removed ?? 0))), [result]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Import a month of attendance" size="lg" error={err} onDismissError={() => setErr(null)}
      footer={result && !done ? (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why — e.g. HRO's confirmed October sheet" className="flex-1 px-3 py-2 rounded-lg border border-border bg-card text-sm" />
          <Button variant="primary" disabled={blocked || nothingToDo || !checked || note.trim().length < 5 || busy === "commit"} onClick={() => void commit()}>
            {busy === "commit" ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}Import
          </Button>
        </div>
      ) : undefined}>
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card">
            <option value="">Pick the client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="month" value={month} max={new Date().toISOString().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card" />
        </div>

        {client && (
          <div className="rounded-xl border border-border p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1 min-w-0 text-muted-foreground">1. Download the template for {client.name}, {month}. It lists the guards and what Bastion already has.</span>
              <Button variant="secondary" size="sm" disabled={busy === "template"} onClick={() => void template()}>
                {busy === "template" ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Download className="w-4 h-4 mr-1.5" />}Template
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1 min-w-0 text-muted-foreground">2. Fill the days (P, L, A, R or blank) and upload it. Nothing is saved until you confirm.</span>
              <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm cursor-pointer hover:bg-muted ${busy ? "opacity-50 pointer-events-none" : ""}`}>
                {busy === "read" || busy === "preview" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}Upload
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
              </label>
            </div>
            {file && <p className="text-xs text-muted-foreground inline-flex items-center gap-1"><FileSpreadsheet className="w-3.5 h-3.5" />{file.name}{parsed ? ` · ${parsed.rows.length} guard${parsed.rows.length === 1 ? "" : "s"}` : ""}</p>}
          </div>
        )}

        {parsed && parsed.problems.length > 0 && (
          <div className="rounded-lg border border-down/30 bg-down/10 p-3 text-down">
            <p className="font-semibold mb-1 inline-flex items-center gap-1.5"><AlertCircle className="w-4 h-4" />The sheet can't be imported yet — fix these and upload again:</p>
            <ul className="list-disc pl-5 space-y-0.5 text-xs">{parsed.problems.slice(0, 40).map((p, i) => <li key={i}>{p}</li>)}</ul>
            {parsed.problems.length > 40 && <p className="text-xs mt-1">…and {parsed.problems.length - 40} more.</p>}
          </div>
        )}
        {warnings.length > 0 && (
          <div className="rounded-lg border border-heed/30 bg-heed/10 p-3 text-xs">
            <p className="font-semibold mb-1">Names that differ from Bastion — the guard code decides, so check each is the same man:</p>
            <ul className="list-disc pl-5 space-y-0.5">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        )}

        {result && t && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {[["Guards", t.guards], ["Days added", t.added], ["Days changed", t.changed], ["Days removed", t.removed], ["Unchanged", t.same]].map(([l, v]) => (
                <div key={l as string} className="rounded-lg border border-border px-3 py-2">
                  <div className="text-[11px] text-muted-foreground">{l}</div>
                  <div className={`font-ledger text-lg font-semibold ${l === "Days removed" && Number(v) > 0 ? "text-down" : ""}`}>{v}</div>
                </div>
              ))}
            </div>
            {result.same_file_imported_before && <p className="text-xs text-heed">This exact file was imported for this client and month before.</p>}
            {blocked && <p className="text-down text-xs font-semibold">{t.refused} guard{t.refused === 1 ? " is" : "s are"} refused — nothing can be imported until every guard passes. Fix them and upload again.</p>}
            {nothingToDo && !blocked && <p className="text-xs text-muted-foreground">Bastion already matches this sheet — nothing to import.</p>}
            <div className="rounded-xl border border-border overflow-x-auto max-h-80">
              <table className="w-full text-xs">
                <thead className="bg-muted/60 sticky top-0"><tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1.5">Guard</th><th className="px-2 py-1.5 text-right">Added</th><th className="px-2 py-1.5 text-right">Changed</th><th className="px-2 py-1.5 text-right">Removed</th><th className="px-2 py-1.5 text-right">Same</th><th className="px-2 py-1.5">Note</th>
                </tr></thead>
                <tbody>
                  {sorted.map((g) => (
                    <tr key={g.employee_id} className="border-t border-border align-top">
                      <td className="px-2 py-1.5"><div className="text-foreground">{g.name}</div><div className="text-muted-foreground">{g.code}</div></td>
                      <td className="px-2 py-1.5 text-right font-ledger">{g.added ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-ledger">{g.changed ?? "—"}</td>
                      <td className={`px-2 py-1.5 text-right font-ledger ${(g.removed ?? 0) > 0 ? "text-down" : ""}`}>{g.removed ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-ledger text-muted-foreground">{g.same ?? "—"}</td>
                      <td className="px-2 py-1.5">{g.error ? <span className="text-down">{g.error}</span> : (g.app_replaced ?? 0) > 0 ? <span className="text-heed">replaces {g.app_replaced} field-app mark{g.app_replaced === 1 ? "" : "s"}</span> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.guards.some((g) => g.error?.includes("field app")) || replaceApp ? (
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={replaceApp} onChange={(e) => { setReplaceApp(e.target.checked); void dryRun(rowsForRpc, parsed?.sha256, file?.name, e.target.checked); }} className="mt-0.5" />
                <span>Replace field-app marks. These were made on site by a supervisor; only tick this if the sheet is the better record for those days.</span>
              </label>
            ) : null}
            {!blocked && !nothingToDo && (
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5" />
                <span>I have checked these numbers{t.removed ? `, including the ${t.removed} day${t.removed === 1 ? "" : "s"} that will be removed` : ""}. Guards not in the sheet are not touched.</span>
              </label>
            )}
          </div>
        )}

        {done && (
          <div className="rounded-lg border border-up/30 bg-up/10 p-3 text-up inline-flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5" />
            <span>Imported: {done.totals.added} day{done.totals.added === 1 ? "" : "s"} added, {done.totals.changed} changed, {done.totals.removed} removed across {done.totals.guards} guard{done.totals.guards === 1 ? "" : "s"}. It can be undone below.</span>
          </div>
        )}

        {past.length > 0 && (
          <div className="rounded-xl border border-border p-3">
            <p className="lbl mb-1.5">Imports for this client and month</p>
            <ul className="space-y-1.5 text-xs">
              {past.map((p) => (
                <li key={p.id} className="flex items-start gap-2">
                  <span className="flex-1 min-w-0">
                    <span className={p.undone_at ? "line-through text-muted-foreground" : "text-foreground"}>{formatDate(p.created_at)} · {p.file_name ?? "file"} · {p.guards} guards · +{p.marks_added} / ~{p.marks_changed} / −{p.marks_removed}</span>
                    <span className="block text-muted-foreground">{p.note}{p.undone_at ? ` — undone ${formatDate(p.undone_at)}: ${p.undo_reason ?? ""}` : ""}</span>
                  </span>
                  {p.id === latestLive?.id && (
                    <button type="button" disabled={busy === "undo"} onClick={() => void undo(p)} className="inline-flex items-center gap-1 text-down hover:underline disabled:opacity-50"><Undo2 className="w-3.5 h-3.5" />Undo</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
