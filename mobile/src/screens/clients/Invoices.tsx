import { useLocalSearchParams, useRouter } from "expo-router";
import { CheckCircle2, FileDown, ImageUp, LayoutTemplate, Paperclip, Pencil, Plus, Receipt, Trash2, Wallet, X } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, TextInput, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Chips, Empty, Fields, HStack, IconBtn, Input, Ledger, ListCard, RecordCard, Row, Section, StatGrid, Tabs, Toggle } from "../../components/ui";
import { Invoice, TODAY } from "../../data/seed";
import { bankOptions, clientName, custodianOptions, useDB } from "../../data/store";
import {
  amendPayment, createInvoice, deleteInvoice, deletePayment, downloadInvoicePdf, InvoiceForm, invoiceFormError, loadPayments, PaymentInput,
  recordPayment, removeInvoiceAttachment, setInvoiceStatus, suggestedWithholding, updateInvoice,
} from "../../data/api/invoices";
import { num, useInvoiceGenerator } from "../../data/api/invoiceGenerator";
import { downloadRecordPdf } from "../../data/api/invoices";
import { loadBranding, resetBranding } from "../../data/api/exports";
import { q, rpc, sb, type PickedFile } from "../../data/api/core";
import { useAuth } from "../../lib/auth";
import { pickDocument, pickImage } from "../../lib/files";
import { fmtDate, fmtMonth, fmtShort, pkr } from "../../lib/format";
import { inRegion, useRegion } from "../../lib/region";
import { CLIENT_INVOICE_GROUP_LABEL, DEFAULT_INVOICE_SETTINGS, invoiceOutstanding, SELECTABLE_INVOICE_GROUPS, type InvoiceStructureSettings } from "../../lib/web/supabase";
import { useTheme } from "../../theme/ThemeProvider";
import { fonts, radius } from "../../theme/tokens";

const STATUSES = ["Pending", "Delivered", "Unpaid", "Partly-Paid", "Paid"] as const;
const statusTone = (s: string) => (s === "Paid" ? "success" : s === "Partly-Paid" ? "info" : s === "Unpaid" ? "warning" : "neutral");
const outstandingOf = (i: Invoice) => invoiceOutstanding(i.raw ?? { invoice_amount: i.amount, amount_received: 0 });
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Invoices() {
  const router = useRouter();
  const { db } = useDB();
  const { can } = useAuth();
  const { regionId } = useRegion();
  const { toast } = useOverlay();
  const [tab, setTab] = useState<"ledger" | "generate">("ledger");
  const [genMode, setGenMode] = useState<"invoice" | "record">("invoice");
  const [client, setClient] = useState("");
  const [status, setStatus] = useState("all");
  const [month, setMonth] = useState("");
  const [form, setForm] = useState<Invoice | "new" | null>(null);
  const [structure, setStructure] = useState(false);
  const [payFor, setPayFor] = useState<Invoice | null>(null);
  const canEdit = can("invoices.edit");

  const list = db.invoices.filter((i) => inRegion(regionId, db.clients.find((c) => c.id === i.client_id)?.branch_id) && (!client || i.client_id === client) && (status === "all" || i.status === status) && (!month || i.month === month));
  const total = list.reduce((a, i) => a + i.amount, 0);
  const outstanding = list.reduce((a, i) => a + outstandingOf(i), 0);
  const months = [...new Set(db.invoices.map((i) => i.month))].sort().reverse();

  const pdf = (i: Invoice) => downloadInvoicePdf(i, db.clients.find((c) => c.id === i.client_id)?.raw, db.contracts.find((k) => k.id === i.contract_id)?.raw, db.company.id).catch((e) => toast(err(e), "danger"));

  return (
    <Screen
      region
      eyebrow="Clients & Contracts"
      title="Invoices"
      actions={canEdit ? <>
        <IconBtn icon={LayoutTemplate} label="Invoice structure" onPress={() => setStructure(true)} />
        <IconBtn icon={Plus} label="New invoice" filled onPress={() => setForm("new")} />
      </> : undefined}
      sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "ledger", label: "Invoices", count: list.length }, ...(canEdit ? [{ key: "generate" as const, label: "Generate" }] : [])]} />}
    >
      {tab === "ledger" && (
        <>
          <StatGrid items={[
            { label: "Total invoiced", value: pkr(total, { compact: true }), tone: "brand" },
            { label: "Total received", value: pkr(total - outstanding, { compact: true }), tone: "success" },
            { label: "Outstanding", value: pkr(outstanding, { compact: true }), tone: "warning" },
          ]} />
          <View style={{ marginTop: 12, gap: 8 }}>
            <Select compact clearable label="Client" value={client} onChange={setClient} placeholder="All" options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />
            <Select compact clearable label="Month" value={month} onChange={setMonth} placeholder="All" options={months.map((m) => ({ value: m, label: fmtMonth(m) }))} />
            <Chips value={status} onChange={setStatus} items={["all", ...STATUSES].map((s) => ({ key: s, label: s === "all" ? "All" : s }))} />
          </View>
          <View style={{ height: 12 }} />
          {list.map((i) => {
            const out = outstandingOf(i);
            return (
              <RecordCard key={i.id} title={clientName(db, i.client_id)} subtitle={i.number} badge={<Badge label={i.status} tone={statusTone(i.status)} />}
                onPress={() => router.push(`/invoices/${i.id}`)}
                fields={[
                  { label: "Month", value: fmtMonth(i.month) },
                  { label: "Amount", value: pkr(i.amount), mono: true },
                  { label: "Received", value: pkr(Number(i.raw?.amount_received ?? 0)), mono: true },
                  { label: "Outstanding", value: pkr(out), mono: true, tone: out > 0 ? "warning" : undefined },
                ]}
                actions={[
                  { label: "PDF", icon: FileDown, onPress: () => { void pdf(i); } },
                  ...(canEdit && out > 0 ? [{ label: "Record payment", icon: Wallet, onPress: () => setPayFor(i), tone: "brand" as const }] : []),
                ]} />
            );
          })}
          {list.length === 0 && <Empty icon={Receipt} title="No invoices match" />}
        </>
      )}

      {tab === "generate" && canEdit && (
        <>
          {/* Invoice = the receivable, total only. Detailed record = own record, never a receivable (0499). */}
          <Chips value={genMode} onChange={setGenMode} items={[{ key: "invoice", label: "Invoice" }, { key: "record", label: "Detailed record" }]} />
          <Generate key={genMode} mode={genMode} />
        </>
      )}

      {payFor && <RecordPaymentSheet invoice={payFor} onClose={() => setPayFor(null)} />}
      {form && <InvoiceFormSheet invoice={form === "new" ? null : form} onClose={() => setForm(null)} />}
      {structure && <StructureSheet onClose={() => setStructure(false)} />}
    </Screen>
  );
}

/** Generate tab: drafts per contract for the period, Clear, then post all cleared. */
function Generate({ mode }: { mode: "invoice" | "record" }) {
  const t = useTheme();
  const { db, act } = useDB();
  const { toast } = useOverlay();
  const [company, setCompany] = useState<any | null>(null);
  useEffect(() => { loadBranding(db.company.id).then((b) => setCompany(b.company)).catch(() => setCompany({})); }, [db.company.id]);
  const { regionId } = useRegion();
  const g = useInvoiceGenerator(company, regionId, mode);
  const { confirm } = useOverlay();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clearedCount = Object.values(g.isInvoiceMode ? g.simpleDrafts : g.drafts).filter((d) => d.status === "Cleared").length;
  if (g.loading || !company) return <ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} />;
  const d = open && !g.isInvoiceMode ? g.drafts[open] : null;
  const sd = open && g.isInvoiceMode ? g.simpleDrafts[open] : null;
  const f = d ? g.figures(d) : null;
  return (
    <>
      <HStack gap={10}>
        <Input style={{ flex: 1 }} label="Period" value={g.period} onChangeText={g.setPeriod} placeholder="YYYY-MM" />
        <View style={{ flex: 1.3 }}><Select label="Invoice group" value={g.group} onChange={(v) => g.setGroup(v as typeof g.group)} options={SELECTABLE_INVOICE_GROUPS.map((x) => ({ value: x, label: CLIENT_INVOICE_GROUP_LABEL[x] }))} /></View>
      </HStack>
      <Chips value={g.statusFilter} onChange={g.setStatusFilter} items={[{ key: "all", label: "All" }, { key: "pending", label: "Pending" }, { key: "cleared", label: "Cleared" }]} />
      <T v="small" muted style={{ marginBottom: 6 }}>
        {g.isInvoiceMode
          ? "The invoice the client is billed: number, date, period and one total. Posting creates an Unpaid receivable."
          : "Detailed breakdown for your own record only. Saving creates no invoice and no receivable."}
      </T>
      {g.isInvoiceMode && g.outOfWindowInvoices.length > 0 && <Banner tone="warning" title={`${g.outOfWindowInvoices.length} invoice(s) outside their contract window`} sub={g.outOfWindowInvoices.slice(0, 4).map((x) => `${x.clientName} ${x.inv.invoice_number}`).join(" · ")} />}
      <View style={{ height: 10 }} />
      {g.rows.map((r) => {
        if (r.kind === "record") {
          const rec = r.record;
          return <RecordCard key={r.key} title={r.client.name} subtitle={`${r.contract.contract_code} · ${rec.invoice_number}`} badge={<Badge label="Recorded" tone="neutral" small />}
            fields={[{ label: "Total due", value: pkr(Number(rec.total_due)), mono: true }]}
            actions={[
              { label: "PDF", icon: FileDown, onPress: () => { downloadRecordPdf(rec, r.client, r.contract, db.company.id).catch((e) => toast(err(e), "danger")); } },
              { label: "Delete", icon: Trash2, onPress: async () => {
                if (!(await confirm({ title: `Delete record ${rec.invoice_number}?`, message: "This does not affect any invoice.", confirmLabel: "Delete", tone: "danger" }))) return;
                g.deleteRecord(rec).catch((e) => toast(err(e), "danger"));
              } },
            ]} />;
        }
        if (r.kind === "draft" && g.isInvoiceMode) {
          const x = g.simpleDrafts[r.key]!;
          return (
            <RecordCard key={r.key} title={r.client.name} subtitle={`${r.contract.contract_code} · ${x.invoiceNumber}`}
              badge={<Badge label={x.status === "Cleared" ? "Cleared" : "Draft"} tone={x.status === "Cleared" ? "success" : "info"} small />}
              fields={[{ label: "Period", value: `${fmtShort(x.periodStart)} – ${fmtShort(x.periodEnd)}` }, { label: "Total", value: pkr(num(x.total)), mono: true }]}
              actions={[
                { label: "Edit", icon: Pencil, onPress: () => setOpen(r.key) },
                { label: x.status === "Cleared" ? "Reopen" : "Mark cleared", icon: CheckCircle2, onPress: () => { g.toggleCleared(r.key).catch((e) => toast(err(e), "danger")); } },
              ]} />
          );
        }
        if (r.kind === "existing") {
          return <RecordCard key={r.key} title={r.client.name} subtitle={`${r.contract.contract_code} · ${r.invoice.invoice_number}`} badge={<Badge label={r.invoice.status} tone={statusTone(r.invoice.status)} small />}
            fields={[{ label: "Total due", value: pkr(Number(r.invoice.total_due ?? r.invoice.invoice_amount)), mono: true }]} />;
        }
        const dr = g.drafts[r.key]!;
        const fx = g.figures(dr);
        return (
          <RecordCard key={r.key} title={r.client.name} subtitle={`${r.contract.contract_code} · ${dr.invoiceNumber}`}
            badge={<Badge label={dr.status === "Cleared" ? "Cleared" : "Draft"} tone={dr.status === "Cleared" ? "success" : "info"} small />}
            fields={[{ label: "Period", value: `${fmtShort(dr.periodStart)} – ${fmtShort(dr.periodEnd)}` }, { label: "Total due", value: pkr(fx.totalDue), mono: true }]}
            actions={[
              { label: "Review", icon: Pencil, onPress: () => setOpen(r.key) },
              { label: dr.status === "Cleared" ? "Reopen" : "Mark cleared", icon: CheckCircle2, onPress: () => { g.toggleCleared(r.key).catch((e) => toast(err(e), "danger")); } },
            ]} />
        );
      })}
      {g.rows.length === 0 && <Empty title="Nothing to generate" sub="Every contract in this group already has an invoice for the period." />}
      <Button label={g.isInvoiceMode ? `Generate ${clearedCount} cleared` : `Save ${clearedCount} cleared as records`} full style={{ marginTop: 10 }} loading={busy} disabled={!clearedCount} onPress={async () => {
        setBusy(true);
        let msg = "";
        const ok = await act(async () => { msg = await g.generateAllCleared(); });
        setBusy(false);
        if (ok) toast(msg);
      }} />

      {sd && open && (
        <Sheet open onClose={() => setOpen(null)} title={`${sd.client.name} — ${sd.contractCode}`}>
          <Input label="Invoice number" value={sd.invoiceNumber} onChangeText={(v) => g.patchSimple(open, { invoiceNumber: v })} />
          <Input label="Invoice date" value={sd.invoiceDate} onChangeText={(v) => g.patchSimple(open, { invoiceDate: v })} placeholder="YYYY-MM-DD" />
          <HStack gap={10}>
            <Input style={{ flex: 1 }} label="Period start" value={sd.periodStart} onChangeText={(v) => g.patchSimple(open, { periodStart: v })} />
            <Input style={{ flex: 1 }} label="Period end" value={sd.periodEnd} onChangeText={(v) => g.patchSimple(open, { periodEnd: v })} />
          </HStack>
          <Input label="Total amount" amount value={sd.total} onChangeText={(v) => g.patchSimple(open, { total: v })} />
          <T v="small" muted>Edits save automatically as a draft.</T>
        </Sheet>
      )}

      {d && f && open && (
        <Sheet open onClose={() => setOpen(null)} title={`${d.client.name} — ${d.contractCode}`} subtitle={`${fmtShort(d.periodStart)} – ${fmtShort(d.periodEnd)}`} full>
          <Input label="Invoice number" value={d.invoiceNumber} onChangeText={(v) => g.patchDraft(open, { invoiceNumber: v })} />
          <HStack gap={10}>
            <Input style={{ flex: 1 }} label="Period start" value={d.periodStart} onChangeText={(v) => g.patchDraft(open, { periodStart: v })} />
            <Input style={{ flex: 1 }} label="Period end" value={d.periodEnd} onChangeText={(v) => g.patchDraft(open, { periodEnd: v })} />
          </HStack>
          {(d.client.invoice_group ?? "FIXED") === "VARIABLE" ? (
            <>
              <T v="eyebrow" muted style={{ marginVertical: 8 }}>Grid — last column is the amount</T>
              {d.variableRows.map((row, ri) => (
                <Card key={ri} style={{ marginBottom: 8 }}>
                  {d.variableColumns.map((col, ci) => (
                    <View key={ci} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      {ri === 0 && ci !== d.variableColumns.length - 1
                        ? <TextInput value={col} onChangeText={(v) => g.grid.setHeader(open, ci, v)} style={{ width: 110, color: t.mutedFg, fontFamily: fonts.body, fontSize: 12 }} />
                        : <T v="small" muted style={{ width: 110 }}>{col}</T>}
                      <TextInput value={row[ci] ?? ""} onChangeText={(v) => g.grid.setCell(open, ri, ci, v)} keyboardType={ci === d.variableColumns.length - 1 ? "decimal-pad" : "default"}
                        style={{ flex: 1, color: t.fg, fontFamily: fonts.body, fontSize: 15, backgroundColor: t.input, borderRadius: radius.md, borderWidth: 1, borderColor: t.border, paddingHorizontal: 10, height: 38 }} />
                      {ri === 0 && ci !== d.variableColumns.length - 1 && d.variableColumns.length > 1 ? <Pressable onPress={() => g.grid.removeColumn(open, ci)}><X size={14} color={t.mutedFg} /></Pressable> : null}
                    </View>
                  ))}
                  {d.variableRows.length > 1 && <Button size="sm" variant="ghost" label="Remove row" onPress={() => g.grid.removeRow(open, ri)} />}
                </Card>
              ))}
              <HStack>
                <Button size="sm" variant="secondary" icon={Plus} label="Row" onPress={() => g.grid.addRow(open)} />
                <Button size="sm" variant="secondary" icon={Plus} label="Column" onPress={() => g.grid.addColumn(open)} />
              </HStack>
            </>
          ) : (
            <>
              <T v="eyebrow" muted style={{ marginVertical: 8 }}>Lines</T>
              {d.lines.map((l, i) => (
                <Card key={i} style={{ marginBottom: 8 }}>
                  <Input label="Label" value={l.label} onChangeText={(v) => g.patchDraft(open, { lines: d.lines.map((x, j) => (j === i ? { ...x, label: v } : x)) })} />
                  <HStack gap={10}>
                    <Input style={{ flex: 1 }} label="Qty" keyboardType="numeric" value={l.quantity} onChangeText={(v) => g.patchDraft(open, { lines: d.lines.map((x, j) => (j === i ? { ...x, quantity: v } : x)) })} />
                    <Input style={{ flex: 1.4 }} label="Rate" amount value={l.unit_rate} onChangeText={(v) => g.patchDraft(open, { lines: d.lines.map((x, j) => (j === i ? { ...x, unit_rate: v } : x)) })} />
                  </HStack>
                  <Ledger label="Line" value={pkr(num(l.quantity) * num(l.unit_rate))} />
                </Card>
              ))}
              {f.computed.map((tx, i) => <Ledger key={i} label={`${tx.name} ${tx.rate}%`} value={pkr(tx.amount)} />)}
            </>
          )}
          <Ledger label="Subtotal" value={pkr(f.subtotal)} top />
          {d.previousBalance > 0 && <Toggle label={`Carry previous balance (${pkr(d.previousBalance)})`} value={d.includePreviousBalance} onChange={(v) => g.patchDraft(open, { includePreviousBalance: v })} />}
          <Ledger label="Total due" value={pkr(f.totalDue)} strong />
          {(d.client.invoice_group ?? "FIXED") !== "VARIABLE" && (
            <>
              <Input label="Override total" amount value={d.overrideTotal} onChangeText={(v) => g.patchDraft(open, { overrideTotal: v })} placeholder="Leave blank to use the computed total" />
              {f.overridden && <Input label="Override reason" required value={d.overrideReason} onChangeText={(v) => g.patchDraft(open, { overrideReason: v })} />}
            </>
          )}
          {(d.client.remit_accounts ?? []).length > 0 && <Select label="Remit to" value={String(d.remitIndex)} onChange={(v) => g.patchDraft(open, { remitIndex: Number(v) })} options={(d.client.remit_accounts ?? []).map((r, i) => ({ value: String(i), label: r.account_title || r.bank_name, sub: r.account_number }))} />}
          <Input label="Notes" multiline value={d.notes} onChangeText={(v) => g.patchDraft(open, { notes: v })} />
          <T v="small" muted>Edits save automatically as a draft.</T>
        </Sheet>
      )}
    </>
  );
}

export function InvoiceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { db, v, act } = useDB();
  const { can } = useAuth();
  const { toast, confirm } = useOverlay();
  const [pay, setPay] = useState(false);
  const [edit, setEdit] = useState(false);
  const [payments, setPayments] = useState<any[]>([]);
  const [amend, setAmend] = useState<any | null>(null);
  const i = db.invoices.find((x) => x.id === id);
  useEffect(() => { if (id) loadPayments(id).then(setPayments).catch(() => setPayments([])); }, [id, v]);
  if (!i) return <Screen title="Invoice"><Empty title="Invoice not found" /></Screen>;
  const out = outstandingOf(i);
  const canEdit = can("invoices.edit");
  const r = i.raw ?? {};

  return (
    <Screen
      eyebrow={i.number}
      title={clientName(db, i.client_id)}
      subtitle={`${fmtMonth(i.month)} · issued ${fmtDate(i.date)}`}
      actions={<>
        <IconBtn icon={FileDown} label="PDF" onPress={() => { downloadInvoicePdf(i, db.clients.find((c) => c.id === i.client_id)?.raw, db.contracts.find((k) => k.id === i.contract_id)?.raw, db.company.id).catch((e) => toast(err(e), "danger")); }} />
        {canEdit && <IconBtn icon={Pencil} label="Edit" onPress={() => setEdit(true)} />}
      </>}
      footer={canEdit && out > 0 ? <Button label="Record payment" icon={Wallet} full onPress={() => setPay(true)} /> : undefined}
    >
      <Card>
        <Badge label={i.status} tone={statusTone(i.status)} dot />
        <View style={{ marginTop: 12 }}>
          <Ledger label="Invoice amount" value={pkr(i.amount)} />
          {r.total_due != null && Number(r.total_due) !== i.amount ? <Ledger label="Total due (incl. previous balance)" value={pkr(Number(r.total_due))} /> : null}
          <Ledger label="Received (incl. withholding)" value={pkr(Number(r.amount_received ?? 0))} tone="success" />
          <Ledger label="Outstanding" value={pkr(out)} strong top tone={out > 0 ? "warning" : undefined} />
        </View>
      </Card>
      {canEdit && (
        <Section title="Status">
          <Chips value={i.status} onChange={(s) => { void act(() => setInvoiceStatus(i.id, s), `Marked ${s}`); }} items={STATUSES.map((s) => ({ key: s, label: s }))} />
        </Section>
      )}
      <Section title="Details">
        <Card><Fields items={[
          { label: "Contract", value: db.contracts.find((k) => k.id === i.contract_id)?.code ?? "—", mono: true },
          { label: "Period", value: r.period_start ? `${fmtShort(r.period_start)} – ${fmtShort(r.period_end)}` : "—" },
          { label: "Attachment", value: r.attachment_file_name ?? (r.drive_file_id ? "On Drive" : "None") },
          { label: "Notes", value: i.notes || "—", full: true },
        ]} /></Card>
        {r.drive_view_url ? <Button size="sm" variant="secondary" icon={Paperclip} label="Open attachment" style={{ marginTop: 8 }} onPress={() => { Linking.openURL(r.drive_view_url).catch(() => {}); }} /> : null}
      </Section>
      <Section title="Payments" count={payments.length}>
        {payments.length ? (
          <ListCard>
            {payments.map((p, n) => (
              <Row key={p.id} last={n === payments.length - 1} title={pkr(Number(p.amount))} subtitle={p.notes ?? undefined}
                meta={`${fmtShort(p.payment_date)} · ${p.payment_mode}${Number(p.withholding_amount) ? ` · WHT ${pkr(Number(p.withholding_amount))}` : ""}`}
                onPress={canEdit ? () => setAmend(p) : undefined} />
            ))}
          </ListCard>
        ) : <T v="small" muted>No payments yet.</T>}
      </Section>
      {canEdit && (
        <Button label="Delete invoice" icon={Trash2} variant="ghost" style={{ marginTop: 20 }} onPress={async () => {
          if (await confirm({ title: `Delete invoice "${i.number}"?`, message: "This cannot be undone.", confirmLabel: "Delete", tone: "danger" })) {
            if (await act(() => deleteInvoice(i), "Invoice deleted")) router.back();
          }
        }} />
      )}
      {pay && <RecordPaymentSheet invoice={i} onClose={() => setPay(false)} />}
      {edit && <InvoiceFormSheet invoice={i} onClose={() => setEdit(false)} />}
      {amend && <AmendPaymentSheet payment={amend} onClose={() => setAmend(null)} />}
    </Screen>
  );
}

function PaymentModeFields({ f, set }: { f: PaymentInput; set: (p: Partial<PaymentInput>) => void }) {
  const { db } = useDB();
  const { can } = useAuth();
  const banking = can("banks.view");
  return (
    <>
      <Input label="Amount" required amount value={f.amount} onChangeText={(x) => set({ amount: x.replace(/[^\d.]/g, "") })} />
      <Input label="Date" value={f.date} onChangeText={(x) => set({ date: x })} placeholder="YYYY-MM-DD" />
      <Chips value={f.mode} onChange={(m) => set({ mode: m })} items={[{ key: "Cash", label: "Cash" }, { key: "Bank", label: "Bank" }]} />
      <View style={{ height: 10 }} />
      {f.mode === "Bank" && <Select label="Bank account" required value={f.bank_account_id} onChange={(x) => set({ bank_account_id: x })} options={bankOptions(db, banking)} />}
      {f.mode === "Cash" && <Select label="Received by" required value={f.custodian_location_id} onChange={(x) => set({ custodian_location_id: x })} options={custodianOptions(db, banking)} />}
      {f.mode === "Cash" && <T v="small" muted style={{ marginTop: -8, marginBottom: 10 }}>Cash is held by a person. The ledger posts this receipt to their account.</T>}
      <Input label="Notes" value={f.notes} onChangeText={(x) => set({ notes: x })} />
    </>
  );
}

function RecordPaymentSheet({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const { db, act } = useDB();
  const out = outstandingOf(invoice);
  const rate = Number(db.clients.find((c) => c.id === invoice.client_id)?.raw?.withholding_tax_rate ?? 0);
  const [f, setF] = useState<PaymentInput>({ amount: "", date: TODAY, mode: "Bank", bank_account_id: "", custodian_location_id: "", notes: "", withholding: suggestedWithholding(out, rate) });
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Record payment" subtitle={`${invoice.number} · outstanding ${pkr(out)}`}
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label="Record" full loading={busy} onPress={async () => {
        setBusy(true); const ok = await act(() => recordPayment(invoice.id, f), `${pkr(Number(f.amount) || 0)} recorded`); setBusy(false); if (ok) onClose();
      }} /></>}>
      <PaymentModeFields f={f} set={(p) => setF({ ...f, ...p })} />
      <Input label="Withholding tax deducted" amount value={f.withholding} onChangeText={(x) => setF({ ...f, withholding: x })} />
      <T v="small" muted>Prefilled from the client&apos;s agreed rate. Allocation runs oldest-first across the client&apos;s invoices.</T>
    </Sheet>
  );
}

function AmendPaymentSheet({ payment, onClose }: { payment: any; onClose: () => void }) {
  const { act } = useDB();
  const { confirm } = useOverlay();
  const [f, setF] = useState<PaymentInput>({
    amount: String(payment.amount), date: payment.payment_date, mode: payment.payment_mode, bank_account_id: payment.bank_account_id ?? "",
    custodian_location_id: payment.custodian_location_id ?? "", notes: payment.notes ?? "", withholding: "",
  });
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Edit payment" subtitle="Withholding is split across invoices and can't be re-apportioned here."
      footer={<>
        <Button label="Delete" variant="danger" full onPress={async () => {
          if (await confirm({ title: `Delete this ${pkr(Number(payment.amount))} payment?`, message: "The amount and its withholding are reversed from balances.", confirmLabel: "Delete", tone: "danger" })) {
            if (await act(() => deletePayment(payment.id), "Payment deleted")) onClose();
          }
        }} />
        <Button label="Save" full loading={busy} onPress={async () => { setBusy(true); const ok = await act(() => amendPayment(payment.id, f), "Payment updated"); setBusy(false); if (ok) onClose(); }} />
      </>}>
      <PaymentModeFields f={f} set={(p) => setF({ ...f, ...p })} />
    </Sheet>
  );
}

function InvoiceFormSheet({ invoice, onClose }: { invoice: Invoice | null; onClose: () => void }) {
  const { db, act } = useDB();
  const { toast, confirm } = useOverlay();
  const r = invoice?.raw ?? {};
  const [f, setF] = useState<InvoiceForm>({
    client_id: invoice?.client_id ?? "", contract_id: r.contract_id ?? "", invoice_number: r.invoice_number ?? "",
    invoice_date: (r.invoice_date ?? TODAY).slice(0, 7), invoice_amount: invoice ? String(invoice.amount) : "", notes: r.notes ?? "",
  });
  const [file, setFile] = useState<PickedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const e = invoiceFormError(f, db.invoices, db.contracts, invoice?.id);
    if (e) return toast(e, "danger");
    setBusy(true);
    const company = { id: db.company.id, name: db.company.name };
    const ok = await act(() => (invoice ? updateInvoice(invoice, f, file, company) : createInvoice(f, file, company)), invoice ? "Invoice saved" : "Invoice created");
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Sheet open onClose={onClose} title={invoice ? "Edit invoice" : "New invoice"}
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label="Save" full loading={busy} onPress={save} /></>}>
      <Select label="Client" required value={f.client_id} onChange={(x) => setF({ ...f, client_id: x, contract_id: "" })} options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />
      {f.client_id ? <Select label="Contract" clearable value={f.contract_id} onChange={(x) => setF({ ...f, contract_id: x })} options={db.contracts.filter((k) => k.client_id === f.client_id).map((k) => ({ value: k.id, label: k.code, sub: k.status }))} /> : null}
      <Input label="Invoice number" required value={f.invoice_number} onChangeText={(x) => setF({ ...f, invoice_number: x })} autoCapitalize="characters" />
      <Input label="Invoice month" required value={f.invoice_date} onChangeText={(x) => setF({ ...f, invoice_date: x })} placeholder="YYYY-MM" />
      <Input label="Amount" required amount value={f.invoice_amount} onChangeText={(x) => setF({ ...f, invoice_amount: x })} />
      <Input label="Notes" multiline value={f.notes} onChangeText={(x) => setF({ ...f, notes: x })} />
      <T v="smallStrong" soft style={{ marginBottom: 6 }}>Attachment{r.attachment_file_name ? ` (current: ${r.attachment_file_name})` : ""}</T>
      {file ? <T v="small" style={{ marginBottom: 6 }}>{file.name} — replaces the current file</T> : null}
      <HStack>
        <Button size="sm" variant="secondary" icon={Paperclip} label={file ? "Change" : "Attach"} onPress={() => pickDocument().then((x) => x && setFile(x)).catch(() => {})} />
        {invoice && (r.drive_file_id || r.attachment_path) ? <Button size="sm" variant="ghost" label="Remove current" onPress={async () => {
          if (await confirm({ title: "Remove the current attachment?", confirmLabel: "Remove", tone: "danger" })) await act(() => removeInvoiceAttachment(invoice), "Attachment removed");
        }} /> : null}
      </HStack>
    </Sheet>
  );
}

/** InvoiceStructureModal: company invoice identity, images (≤ 400 KB) and template toggles, via update_invoice_structure. */
function StructureSheet({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const { db, act } = useDB();
  const { toast } = useOverlay();
  const [c, setC] = useState<any | null>(null);
  const [s, setS] = useState<InvoiceStructureSettings>(DEFAULT_INVOICE_SETTINGS);
  const [phones, setPhones] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    // The stored row, not the branding copy — that one has images inlined.
    const raw = await q<any>(sb().from("companies").select("*").eq("id", db.company.id).single());
    setC({ legal_name: raw.legal_name ?? "", registration_line: raw.registration_line ?? "", legal_address: raw.legal_address ?? "", contact_email: raw.contact_email ?? "",
      website: raw.website ?? "", tax_ntn: raw.tax_ntn ?? "", signature_label: raw.signature_label ?? "", logo_url: raw.logo_url ?? null, stamp_url: raw.stamp_url ?? null });
    setPhones(((raw.contact_phones ?? (raw.contact_phone ? [raw.contact_phone] : [])) as string[]).join(", "));
    setS({ ...DEFAULT_INVOICE_SETTINGS, ...(raw.invoice_settings ?? {}) });
  }, [db.company.id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
  useEffect(() => { void load(); }, [load]);
  const image = async (key: "logo_url" | "stamp_url" | "watermark") => {
    const f = await pickImage();
    if (!f) return;
    if ((f.size ?? 0) > 400 * 1024) return toast("Please choose an image under 400 KB.", "danger");
    const { File } = await import("expo-file-system");
    const dataUrl = `data:${f.type};base64,${new File(f.uri).base64Sync()}`;
    if (key === "watermark") setS({ ...s, watermark_url: dataUrl }); else setC({ ...c, [key]: dataUrl });
  };
  if (!c) return <Sheet open onClose={onClose} title="Invoice structure"><ActivityIndicator color={t.brand[500]} /></Sheet>;
  return (
    <Sheet open onClose={onClose} title="Invoice structure" full
      footer={<Button label="Save" full loading={busy} onPress={async () => {
        setBusy(true);
        const ok = await act(() => rpc("update_invoice_structure", {
          p_legal_name: c.legal_name.trim() || null, p_registration_line: c.registration_line.trim() || null, p_legal_address: c.legal_address.trim() || null,
          p_contact_email: c.contact_email.trim() || null, p_contact_phones: phones.split(",").map((p) => p.trim()).filter(Boolean), p_website: c.website.trim() || null,
          p_tax_ntn: c.tax_ntn.trim() || null, p_signature_label: c.signature_label.trim() || null, p_logo_url: c.logo_url, p_stamp_url: c.stamp_url, p_invoice_settings: s,
        }).catch((e) => {
          const m = err(e);
          throw new Error(/companies_company_prefix_unique|duplicate key/.test(m) ? `Prefix "${s.company_prefix}" is already used by another company. Choose a different one.` : /prefix is locked/i.test(m) ? "The company prefix is locked because guards already have permanent codes under it." : m);
        }), "Invoice structure saved");
        resetBranding();
        setBusy(false);
        if (ok) onClose();
      }} />}>
      <Input label="Legal name" value={c.legal_name} onChangeText={(x) => setC({ ...c, legal_name: x })} />
      <Input label="Registration line" value={c.registration_line} onChangeText={(x) => setC({ ...c, registration_line: x })} />
      <Input label="Head office address" multiline value={c.legal_address} onChangeText={(x) => setC({ ...c, legal_address: x })} />
      <Input label="Email" value={c.contact_email} autoCapitalize="none" onChangeText={(x) => setC({ ...c, contact_email: x })} />
      <Input label="Phones (comma separated)" value={phones} onChangeText={setPhones} />
      <Input label="Website" value={c.website} autoCapitalize="none" onChangeText={(x) => setC({ ...c, website: x })} />
      <Input label="Tax NTN" value={c.tax_ntn} onChangeText={(x) => setC({ ...c, tax_ntn: x })} />
      <Input label="Signature label" value={c.signature_label} onChangeText={(x) => setC({ ...c, signature_label: x })} />
      <Input label="Company prefix" value={s.company_prefix ?? ""} autoCapitalize="characters" onChangeText={(x) => setS({ ...s, company_prefix: x })} />
      <Input label="Brand colour (hex)" value={s.brand_color ?? ""} onChangeText={(x) => setS({ ...s, brand_color: x })} placeholder="#1e40af" />
      <HStack wrap>
        <Button size="sm" variant="secondary" icon={ImageUp} label={c.logo_url ? "Replace logo" : "Logo"} onPress={() => image("logo_url")} />
        <Button size="sm" variant="secondary" icon={ImageUp} label={c.stamp_url ? "Replace stamp" : "Stamp"} onPress={() => image("stamp_url")} />
        <Button size="sm" variant="secondary" icon={ImageUp} label={s.watermark_url ? "Replace watermark" : "Watermark"} onPress={() => image("watermark")} />
      </HStack>
      <Toggle label="Fixed: show previous balance" value={!!s.fixed_show_previous_balance} onChange={(x) => setS({ ...s, fixed_show_previous_balance: x })} />
      <Toggle label="Variable: show previous balance" value={!!s.variable_show_previous_balance} onChange={(x) => setS({ ...s, variable_show_previous_balance: x })} />
      <Toggle label="Show stamp" value={!!s.general_show_stamp} onChange={(x) => setS({ ...s, general_show_stamp: x })} />
      <Toggle label="SLA taxes from the client's tax profile" value={!!s.sla_taxes_dynamic} onChange={(x) => setS({ ...s, sla_taxes_dynamic: x })} />
      <Toggle label="Show watermark" value={!!s.show_watermark} onChange={(x) => setS({ ...s, show_watermark: x })} />
      {s.show_watermark && <Input label="Watermark opacity (0–1)" keyboardType="decimal-pad" value={String(s.watermark_opacity ?? 0.1)} onChangeText={(x) => setS({ ...s, watermark_opacity: Number(x) || 0 })} />}
    </Sheet>
  );
}

