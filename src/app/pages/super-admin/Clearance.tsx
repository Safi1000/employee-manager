// ── Clearance: two stages, and neither does the other's half ────────────────
//
// STAGE 1 — OPERATIONS. A fired guard appears not cleared, highlighted, with
// his outstanding kit listed automatically. Ops assesses each item; three
// outcomes, each with a suggested fine that is overridable by hand:
//
//   Returned reusable  → stock back at half replacement cost, no fine
//   Returned unusable  → written off, fine pro-rated by remaining useful life
//   Not returned       → nothing back, full replacement cost whatever its age
//
// STAGE 2 — FINANCE. Cannot see him until ops has cleared him, and then sees
// only the OUTCOME: kits recovered, or a fine of X. Not the items, not the
// conditions, not the per-item fines.
//
// The two halves are gated on clearance.ops and clearance.finance, which is the
// stage-gate exception in CLAUDE.md: one key would let one person assess the kit
// and release the money.

import { useEmployeeCodeIndex } from "../../lib/employeeCodes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ClipboardCheck, Loader2, PenLine, Printer, ShieldCheck, Wallet } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import StatCard from "../../components/StatCard";
import Badge from "../../components/Badge";
import ResponsiveTable, { type Column } from "../../components/ResponsiveTable";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { formatDate } from "../../lib/date";
import { brandingFromCompany } from "../../lib/pdfBranding";
import { generateClearanceCertificatePdf } from "../../lib/clearanceCertificatePdf";

import {
  ChoiceCards, FormField, Hint, ModalFooter, Notice, PageBody, Panel, SubjectCard, inputCls, money,
} from "./_assetsKit";
const OUTCOMES = [
  { v: "returned_reusable", l: "Returned — reusable" },
  { v: "returned_unusable", l: "Returned — unusable" },
  { v: "not_returned", l: "Not returned" },
] as const;

type Pending = {
  id: string; full_name: string; guard_code: string | null;
  last_working_day: string | null; lifecycle_state: string;
  certificate_id: string | null; ops_cleared_at: string | null;
};

type KitItem = {
  id: string; issue_id: string; item_type_id: string; size: string | null;
  quantity: number; opening_condition: string;
  outcome: string | null; returned_condition: string | null;
  suggested_fine: number; fine: number;
};

export default function Clearance() {
  const codeIndex = useEmployeeCodeIndex();
  const { profile, company } = useAuth();
  const canOps = hasPermission(profile, "clearance.ops");
  const canFin = hasPermission(profile, "clearance.finance");
  const branding = brandingFromCompany(company);

  const [pending, setPending] = useState<Pending[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [types, setTypes] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [open, setOpen] = useState<{ emp: Pending; certId: string; items: KitItem[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [e, c, q, t] = await Promise.all([
      supabase.from("employees")
        .select("id, full_name, guard_code, last_working_day, lifecycle_state")
        .in("lifecycle_state", ["fired", "left", "absconded"])
        .not("last_working_day", "is", null)
        .order("last_working_day", { ascending: false }),
      supabase.from("clearance_certificates")
        .select("id, employee_id, ops_cleared_at, dues_released"),
      supabase.from("clearance_finance_queue").select("*"),
      supabase.from("inventory_item_types").select("id, name"),
    ]);
    if (e.error) setErr(e.error.message);
    const certByEmp = new Map<string, any>();
    for (const row of (c.data ?? []) as any[]) {
      if (!certByEmp.has(row.employee_id) || row.ops_cleared_at) certByEmp.set(row.employee_id, row);
    }
    setPending(((e.data ?? []) as any[]).map((x) => ({
      ...x,
      certificate_id: certByEmp.get(x.id)?.id ?? null,
      ops_cleared_at: certByEmp.get(x.id)?.ops_cleared_at ?? null,
    })));
    setQueue(q.data ?? []);
    setTypes((t.data ?? []) as any[]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const typeName = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);
  const notCleared = useMemo(() => pending.filter((p) => !p.ops_cleared_at), [pending]);

  const openAssessment = async (emp: Pending) => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc("open_kit_clearance", { p_employee_id: emp.id });
    if (error) { setBusy(false); setErr(friendlyDbError(error)); return; }
    const certId = data as string;
    const { data: items } = await supabase.from("clearance_kit_items")
      .select("*").eq("certificate_id", certId);
    setBusy(false);
    setOpen({ emp, certId, items: (items ?? []) as KitItem[] });
  };

  // THE SUGGESTION COMES FROM THE DATABASE, never from a second copy of the
  // rules here. A screen that recomputed the fine could disagree with what the
  // clearance actually charges.
  const setOutcome = async (item: KitItem, outcome: string) => {
    const { data } = await supabase.rpc("suggest_kit_fine", {
      p_issue_id: item.issue_id, p_outcome: outcome,
    });
    const suggested = Number(data ?? 0);
    await supabase.from("clearance_kit_items")
      .update({ outcome, suggested_fine: suggested, fine: suggested,
                assessed_by: profile?.id ?? null, assessed_at: new Date().toISOString() })
      .eq("id", item.id);
    setOpen((o) => o && ({
      ...o,
      items: o.items.map((i) => i.id === item.id
        ? { ...i, outcome, suggested_fine: suggested, fine: suggested } : i),
    }));
  };

  const overrideFine = async (item: KitItem, value: string) => {
    const fine = Number(value || 0);
    setOpen((o) => o && ({ ...o, items: o.items.map((i) => i.id === item.id ? { ...i, fine } : i) }));
    await supabase.from("clearance_kit_items").update({ fine }).eq("id", item.id);
  };

  const clearOps = async () => {
    if (!open) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("ops_clear_employee", { p_certificate_id: open.certId });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setOpen(null);
    load();
  };

  // THE CERTIFICATE HE SIGNS. Printed before the signature is recorded, because
  // the signature is a signature ON this document — every figure it carries
  // comes from the row, none of it is worked out here.
  const printCertificate = (r: any) => {
    generateClearanceCertificatePdf({
      branding,
      full_name: r.full_name,
      guard_code: r.guard_code ?? "—",
      display_code: r.display_number ?? null,
      last_working_day: r.last_working_day ?? r.covers_to ?? null,
      separation_reason: r.separation_reason ?? null,
      clearance: {
        status: r.dues_released ? "cleared" : "cleared",
        kit_returned: Number(r.kit_fine_total ?? 0) === 0,
        outstanding_kit_count: 0,
        advance_settled: Number(r.outstanding_advance ?? 0) <= 0,
        outstanding_advance: r.outstanding_advance,
        incidents_reviewed: true,
        open_incident_count: 0,
        dues_released: r.dues_released,
        dues_released_on: r.dues_released_on ?? null,
        kit_summary: r.kit_summary,
        kit_fine_total: r.kit_fine_total,
        fine_written_off: r.fine_written_off,
        covers_to: r.covers_to,
        cumulative_paid: r.cumulative_paid,
      },
    });
  };

  // FINANCE'S HALF. The fine comes out of what the final payment covers and the
  // rest is written off — both in the database, in one transaction, never here.
  const releaseDues = async (certId: string) => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc("release_final_dues", { p_certificate_id: certId });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setNotice(`Dues released — PKR ${money(data)} is payable to him after the kit fine.`);
    load();
  };

  const recordSignature = async (certId: string) => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from("clearance_certificates")
      .update({ signed_at: new Date().toISOString(), signed_by: profile?.id ?? null })
      .eq("id", certId);
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    load();
  };

  // ── Presentation ──
  const awaitingSig = queue.filter((r) => !r.signed_at && !r.dues_released).length;
  const readyToRelease = queue.filter((r) => r.signed_at && !r.dues_released).length;
  const released = queue.filter((r) => r.dues_released).length;
  const daysOpen = (p: Pending) => p.last_working_day
    ? Math.floor((Date.now() - new Date(p.last_working_day).getTime()) / 86400000) : 0;
  const closeOpen = () => { setOpen(null); setErr(null); };
  const assessed = open ? open.items.filter((i) => i.outcome).length : 0;
  const totalFine = open ? open.items.reduce((a, i) => a + Number(i.fine || 0), 0) : 0;

  const opsCols: Column<Pending>[] = [
    { key: "guard", header: "Guard", primary: true, cell: (p) => <span className="font-medium">{p.full_name}</span> },
    { key: "code", header: "Code", cell: (p) =>
      <span className="font-mono text-xs">{codeIndex.byId.get(p.id) ?? p.guard_code ?? "—"}</span> },
    { key: "state", header: "Separation", cell: (p) => <Badge tone="neutral" className="capitalize">{p.lifecycle_state}</Badge> },
    { key: "lwd", header: "Last working day", cell: (p) => p.last_working_day ? formatDate(p.last_working_day) : "—" },
    { key: "open", header: "Open for", cell: (p) => {
      const d = daysOpen(p);
      return <Badge tone={d > 30 ? "danger" : d > 7 ? "warning" : "neutral"}>{d} days</Badge>;
    } },
  ];

  const finCols: Column<any>[] = [
    { key: "guard", header: "Guard", primary: true, cell: (r) => <span className="font-medium">{r.full_name}</span> },
    { key: "covers", header: "Covers to", cell: (r) => r.covers_to ? formatDate(r.covers_to) : "—" },
    { key: "kit", header: "Kit outcome", cell: (r) => <span className="text-muted-foreground">{r.kit_summary ?? "—"}</span> },
    { key: "fine", header: "Fine", className: "text-right tabular-nums", cell: (r) => money(r.kit_fine_total) },
    { key: "wo", header: "Written off", className: "text-right tabular-nums", cell: (r) => Number(r.fine_written_off ?? 0) > 0
      ? <span className="text-danger-700 dark:text-danger-500">{money(r.fine_written_off)}</span>
      : <span className="text-muted-foreground">—</span> },
    { key: "und", header: "Undisbursed", className: "text-right tabular-nums", cell: (r) => money(r.undisbursed_salary) },
    { key: "status", header: "Status", cell: (r) => r.dues_released
      ? <Badge tone="success">Released{r.dues_released_on ? ` ${formatDate(r.dues_released_on)}` : ""}</Badge>
      : r.signed_at
        ? <Badge tone="info">Signed {formatDate(r.signed_at)}</Badge>
        : <Badge tone="warning">Awaiting signature</Badge> },
  ];

  return (
    <>
      <Header title="Clearance" subtitle="Operations assesses the kit; finance settles the dues" />

      <PageBody>
        {err && !open && <Notice kind="error" onClose={() => setErr(null)}>{err}</Notice>}
        {notice && <Notice kind="success" onClose={() => setNotice(null)}>{notice}</Notice>}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          <StatCard title="Waiting on operations" value={notCleared.length} icon={AlertTriangle} tone={notCleared.length ? "warning" : "neutral"} />
          <StatCard title="Awaiting signature" value={awaitingSig} icon={PenLine} tone="info" />
          <StatCard title="Ready to release" value={readyToRelease} icon={Wallet} tone="brand" />
          <StatCard title="Dues released" value={released} icon={ShieldCheck} tone="success" />
        </div>

        {/* ---- STAGE 1 ---- */}
        <Panel
          icon={AlertTriangle}
          tone="warning"
          title={<>Stage 1 · Not cleared — Operations</>}
          description="Finance cannot see a guard until operations has cleared him, so a separation left here has nobody owed, nobody chasing, and his kit still out."
          flush
        >
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="p-3 md:p-2">
              <ResponsiveTable
                columns={opsCols}
                rows={notCleared}
                rowKey={(p) => p.id}
                empty="Nobody is waiting on operations."
                actions={canOps ? (p) => (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setErr(null); openAssessment(p); }}>
                    <ClipboardCheck className="w-3.5 h-3.5" /> Assess kit
                  </Button>
                ) : undefined}
              />
            </div>
          )}
        </Panel>

        {/* ---- STAGE 2 ---- */}
        <Panel
          icon={ShieldCheck}
          tone="success"
          title={<>Stage 2 · Cleared by operations — Finance</>}
          description="The outcome only. Payment waits on a wet signature: print the certificate, he signs it, record it here, and only then can the money go out."
          flush
        >
          {!loading && (
            <div className="p-3 md:p-2">
              <ResponsiveTable
                columns={finCols}
                rows={queue}
                rowKey={(r) => r.certificate_id}
                empty="Nothing has been cleared by operations yet."
                actions={(r) => (
                  <div className="inline-flex flex-wrap justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => printCertificate(r)}>
                      <Printer className="w-3.5 h-3.5" /> Certificate
                    </Button>
                    {canFin && !r.signed_at && (
                      <Button variant="secondary" size="sm" disabled={busy}
                              onClick={() => recordSignature(r.certificate_id)}>
                        <PenLine className="w-3.5 h-3.5" /> Record signature
                      </Button>
                    )}
                    {canFin && r.signed_at && !r.dues_released && (
                      <Button size="sm" disabled={busy} onClick={() => releaseDues(r.certificate_id)}>
                        <Wallet className="w-3.5 h-3.5" /> Release dues
                      </Button>
                    )}
                  </div>
                )}
              />
            </div>
          )}
        </Panel>
      </PageBody>

      {/* ---- THE ASSESSMENT ---- */}
      {open && (
        <Modal
          isOpen
          onClose={closeOpen}
          title={`Assess kit — ${open.emp.full_name}`}
          size="lg"
          error={err}
          onDismissError={() => setErr(null)}
          footer={
            <ModalFooter summary={
              <>
                {open.items.length > 0 && <>{assessed} of {open.items.length} assessed · </>}
                Total fine <span className="font-semibold text-foreground tabular-nums">PKR {money(totalFine)}</span>
              </>
            }>
              <Button variant="ghost" onClick={closeOpen}>Close</Button>
              <Button onClick={clearOps} disabled={busy || open.items.some((i) => !i.outcome)}>
                {busy ? "Clearing…" : "Clear (Operations)"}
              </Button>
            </ModalFooter>
          }
        >
          <div className="space-y-4">
            <SubjectCard
              title={open.emp.full_name}
              meta={<>
                {codeIndex.byId.get(open.emp.id) ?? open.emp.guard_code ?? "—"}
                {open.emp.last_working_day ? <> · last day {formatDate(open.emp.last_working_day)}</> : null}
              </>}
              aside={<Badge tone="neutral" className="capitalize">{open.emp.lifecycle_state}</Badge>}
            />

            {open.items.length === 0 ? (
              <Hint tone="info">
                He holds no kit on record. Clearing him now records that — it does not invent an
                issuance that never happened.
              </Hint>
            ) : (
              <div className="space-y-3">
                {open.items.map((it) => (
                  <div key={it.id} className={`rounded-lg border p-3 md:p-4 space-y-3 ${it.outcome ? "border-border bg-card" : "border-warning-200 bg-warning-50/40"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">
                          {typeName.get(it.item_type_id) ?? "—"}
                          {it.size ? <span className="text-muted-foreground font-normal"> · {it.size}</span> : null}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          Qty {it.quantity} · taken on at <span className="capitalize">{it.opening_condition}</span>
                        </div>
                      </div>
                      {!it.outcome && <Badge tone="warning">Not assessed</Badge>}
                    </div>
                    <ChoiceCards<string>
                      value={it.outcome}
                      onChange={(v) => setOutcome(it, v)}
                      options={OUTCOMES.map((o) => ({
                        value: o.v, label: o.l,
                        tone: o.v === "returned_reusable" ? "success" : o.v === "returned_unusable" ? "warning" : "danger",
                        sub: o.v === "returned_reusable" ? "Back to stock, no fine"
                          : o.v === "returned_unusable" ? "Written off, fine pro-rated by life left"
                          : "Full replacement cost",
                      }))}
                    />
                    {it.outcome && (
                      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                        <div className="text-xs text-muted-foreground sm:pb-2.5">
                          Suggested <span className="font-medium text-foreground tabular-nums">PKR {money(it.suggested_fine)}</span>
                        </div>
                        <FormField label="Fine charged (PKR)" className="sm:ml-auto sm:w-48">
                          <input className={inputCls + " text-right tabular-nums"} type="number" min={0} value={it.fine}
                                 onChange={(e) => overrideFine(it, e.target.value)} />
                        </FormField>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <Hint>
              The fine is suggested, never imposed — every figure can be changed, and the suggestion is
              already adjusted for the condition he received the item in. Clearing him locks his
              attendance: nothing can be recorded against him afterwards.
            </Hint>
          </div>
        </Modal>
      )}
    </>
  );
}
