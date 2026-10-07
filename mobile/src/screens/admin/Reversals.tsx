// Reversals — the phone version of the web page (0502-0506). Same database
// functions: reversible_actions() lists, reverse_action() previews and
// performs, so the phone and the web can never disagree about what a reversal
// does.
import { RotateCcw } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Checkbox, Chips, Empty, HStack, Input, RecordCard, SearchBar } from "../../components/ui";
import { q, rpc, sb } from "../../data/api/core";
import { fmtDate } from "../../lib/format";
import { pkr } from "../../lib/format";

type Action = {
  kind: string; source_id: string; occurred_at: string; title: string; detail: string | null;
  amount: number | null; reversal_id: string | null; reversed_at: string | null;
};
type Preview = { kind: string; source_id: string; title: string; blockers: string[]; effects: string[]; done: boolean };
type ReversalRow = { id: string; kind: string; title: string | null; mode: string; reason: string; reversed_by_name: string | null; reversed_at: string; effects: string[] };

// Same labels as the web's REVERSAL_KINDS.
const KINDS: Record<string, string> = {
  payslip_disbursement: "Salary disbursement", separation: "Firing / separation",
  separation_legacy: "Firing / separation (before Oct 2026)", rehire: "Rehire", lifecycle_change: "Status change",
  payroll_adjustment: "Payroll adjustment", advance: "Advance", attendance_verification: "Attendance verification",
  invoice_payment: "Client payment", invoice: "Invoice", write_off: "Receivable write-off", expense: "Expense",
  payable_settlement: "Payable settled", vendor_payment: "Vendor payment", bank_transfer: "Bank transfer",
  bank_to_custodian: "Cash withdrawal to custodian", custody_transfer: "Custody transfer", cash_deposit: "Cash deposit",
  cheque_clearance: "Cheque clearance", partner_entry: "Partner drawing / contribution", manual_journal: "Manual journal",
  expense_request_decision: "Expense request decision", inventory_purchase: "Inventory purchase",
  kit_event: "Kit issue / return / handover", clearance_ops: "Clearance (operations)", dues_release: "Final dues release",
  fixed_asset: "Asset capitalised", asset_disposal: "Asset disposal", depreciation_entry: "Depreciation (one month)",
};
const label = (k: string) => KINDS[k] ?? k.replace(/_/g, " ");
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

export function Reversals() {
  const [tab, setTab] = useState<"actions" | "history">("actions");
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState(daysAgo(60));
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Action[] | null>(null);
  const [history, setHistory] = useState<ReversalRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ kind: string; id: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, h] = await Promise.all([
        rpc<Action[]>("reversible_actions", { p_kind: kind || null, p_from: from || null, p_search: search.trim() || null, p_limit: 300 }),
        q<ReversalRow[]>(sb().from("reversals" as never).select("id, kind, title, mode, reason, reversed_by_name, reversed_at, effects")
          .order("reversed_at", { ascending: false }).limit(200)),
      ]);
      setRows(a ?? []); setHistory(h ?? []); setError(null);
    } catch (e) { setError(err(e)); setRows([]); }
  }, [kind, from, search]);

  useEffect(() => { const t = setTimeout(() => { void load(); }, 300); return () => clearTimeout(t); }, [load]);

  return (
    <Screen eyebrow="Admin" title="Reversals" subtitle="Undo a recorded action — reason kept"
      sticky={tab === "actions" ? <SearchBar value={search} onChange={setSearch} placeholder="Name, invoice, description" /> : undefined}>
      <Chips value={tab} onChange={setTab} items={[{ key: "actions", label: "Reversible" }, { key: "history", label: `History (${history.length})` }]} />
      <View style={{ height: 8 }} />
      {error && <Banner tone="danger" title={error} />}

      {tab === "actions" && (
        <>
          <HStack gap={10}>
            <View style={{ flex: 1.4 }}>
              <Select compact searchable label="Type" value={kind} onChange={setKind}
                options={[{ value: "", label: "All types" }, ...Object.entries(KINDS).map(([k, v]) => ({ value: k, label: v }))]} />
            </View>
            <Input style={{ flex: 1 }} label="Since" value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD" />
          </HStack>
          <View style={{ height: 10 }} />
          {!rows && <ActivityIndicator />}
          {rows && rows.length === 0 && <Empty title="Nothing recorded in this range matches." />}
          {(rows ?? []).map((a) => (
            <RecordCard key={`${a.kind}:${a.source_id}`} title={a.title} subtitle={`${label(a.kind)} · ${fmtDate(a.occurred_at)}`}
              badge={a.reversal_id ? <Badge label="Reversed" tone="warning" small /> : undefined}
              fields={[
                ...(a.detail ? [{ label: "Detail", value: a.detail }] : []),
                ...(a.amount != null ? [{ label: "Amount", value: pkr(Number(a.amount)), mono: true }] : []),
              ]}
              actions={a.reversal_id ? [] : [{ label: "Reverse", icon: RotateCcw, tone: "warning", onPress: () => setOpen({ kind: a.kind, id: a.source_id }) }]} />
          ))}
        </>
      )}

      {tab === "history" && (
        <>
          {history.length === 0 && <Empty title="Nothing has been reversed yet." />}
          {history.map((r) => (
            <Card key={r.id} style={{ marginBottom: 8 }}>
              <HStack>
                <Badge label={label(r.kind)} tone="neutral" small />
                {r.mode === "recover" && <Badge label="Recovered" tone="warning" small />}
              </HStack>
              <T v="bodyStrong" style={{ marginTop: 6 }}>{r.title ?? label(r.kind)}</T>
              <T v="small" muted>{fmtDate(r.reversed_at)} · {r.reversed_by_name ?? "—"} · “{r.reason}”</T>
              <View style={{ marginTop: 6, gap: 2 }}>
                {(r.effects ?? []).map((e, i) => <T key={i} v="small">• {e}</T>)}
              </View>
            </Card>
          ))}
        </>
      )}

      {open && <ReverseSheet kind={open.kind} id={open.id} onClose={() => { setOpen(null); void load(); }} />}
    </Screen>
  );
}

/** Preview → reason → reverse, through the same function as the web popup. */
export function ReverseSheet({ kind, id, onClose }: { kind: string; id: string; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState<"error" | "recover">("error");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Preview | null>(null);

  useEffect(() => {
    let c = false;
    rpc<Preview>("reverse_action", { p_kind: kind, p_id: id, p_reason: null, p_preview: true, p_mode: mode })
      .then((p) => { if (!c) { setPreview(p); setError(null); } })
      .catch((e) => { if (!c) setError(err(e)); });
    return () => { c = true; };
  }, [kind, id, mode]);

  const blocked = (preview?.blockers.length ?? 0) > 0;
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = await rpc<Preview>("reverse_action", { p_kind: kind, p_id: id, p_reason: reason.trim(), p_preview: false, p_mode: mode });
      setDone(r);
    } catch (e) { setError(err(e)); }
    setBusy(false);
  };

  return (
    <Sheet open onClose={onClose} title={done ? "Reversed" : `Reverse ${label(kind).toLowerCase()}`} subtitle={preview?.title} error={error} full
      footer={done
        ? <Button label="Close" full onPress={onClose} />
        : <><Button label="Cancel" variant="secondary" full onPress={onClose} />
            <Button label="Reverse" full loading={busy} disabled={!preview || blocked || reason.trim().length < 5} onPress={go} /></>}>
      {!preview && !error && <ActivityIndicator />}
      {preview && (
        <View style={{ gap: 12 }}>
          {done && <Banner tone="success" title="Reversed. It is on the History tab with your reason." />}
          {!done && blocked && <Banner tone="danger" title="This can't be reversed yet" sub={preview.blockers.join("\n")} />}
          {!done && kind === "payslip_disbursement" && (
            <View style={{ gap: 4 }}>
              <T v="eyebrow" muted>What kind of mistake?</T>
              <Checkbox value={mode === "error"} onChange={() => setMode("error")} label="It never really happened" sub="Wrong bank, entered twice — undo the books only" />
              <Checkbox value={mode === "recover"} onChange={() => setMode("recover")} label="It happened; he must pay it back" sub="The money stays out and becomes an advance against him" />
            </View>
          )}
          <View style={{ gap: 4 }}>
            <T v="eyebrow" muted>{done ? "What it did" : "What will happen"}</T>
            {(done ?? preview).effects.map((e, i) => <T key={i} v="small">• {e}</T>)}
          </View>
          {!done && !blocked && (
            <Input label="Reason" required multiline value={reason} onChangeText={setReason} placeholder="e.g. Paid from the wrong bank account" />
          )}
          {!done && <T v="small" muted>The ledger is never edited: the opposite entry is posted. A reversal cannot itself be reversed.</T>}
        </View>
      )}
    </Sheet>
  );
}
