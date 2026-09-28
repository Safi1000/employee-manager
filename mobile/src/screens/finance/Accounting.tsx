import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowDownToLine, ArrowRightLeft, Banknote, CheckCircle2, Download, FileText, History, Landmark, Paperclip, Pencil, Plus, Power, Receipt, Undo2, Wallet } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Chips, Empty, HStack, IconBtn, Input, ListCard, RecordCard, Row, SearchBar, Section, Segmented, StatGrid, Tabs, Toggle, toneOf } from "../../components/ui";
import { TODAY } from "../../data/seed";
import { useDB } from "../../data/store";
import {
  AccountingData, addBank, BankForm, bankTransfer, blankBank, bounceCheque, canClearCheque, cashDeposit, clearCheque, custodyTransfer, deleteLocation, editBank,
  loadAccounting, LocationForm, newCheque, payVendor, recordClientReceipt, recordWithholding, revertPayable, revertVendorPayment, saveLocation, setBankActive,
  setClientOpening, statementLedger, withdrawToCustodian,
} from "../../data/api/accounting";
import { loadBranding } from "../../data/api/exports";
import type { PickedFile } from "../../data/api/core";
import { useAuth } from "../../lib/auth";
import { pickDocument, takePhoto } from "../../lib/files";
import { fmtShort, pkr } from "../../lib/format";
import { inRegion, useRegion } from "../../lib/region";
import { generateDepositSlipPdf } from "../../lib/web/depositSlip";
import { exportBankStatement, exportClientStatementLedger, exportReceivableLedger, exportTable } from "../../lib/web/excel";
import { invoiceOutstanding } from "../../lib/web/supabase";
import { useTheme } from "../../theme/ThemeProvider";

type Tab = "receivables" | "payables" | "banks" | "custody";
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const KIND: Record<string, string> = {
  opening: "Opening", deposit: "Deposit", withdraw_to_cash: "Withdraw to Cash", payroll: "Payroll", reconcile: "Reconcile (Bank)", adjustment: "Adjustment",
  cash_adjustment: "Cash Adjustment", expense: "Expense", receipt: "Receipt", advance: "Advance", transfer: "Transfer", cheque: "Cheque",
};
const payableStatus = (p: any) => (p.payable_status === "Paid" ? "Paid" : p.due_date && p.due_date < TODAY ? "Overdue" : "Pending");

/** Loads the screen's data once and after every write (v bumps on reload). */
function useAccounting() {
  const { db, v } = useDB();
  const { can } = useAuth();
  const [data, setData] = useState<AccountingData | null>(null);
  const [e, setE] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await loadAccounting(db.company.id, can("banks.view"))); setE(null); } catch (x) { setE(err(x)); }
  }, [db.company.id, can]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
  useEffect(() => { void load(); }, [load, v]);
  return { data, error: e };
}

export default function Accounting() {
  const { tab: initial } = useLocalSearchParams<{ tab?: Tab }>();
  const t = useTheme();
  const { can } = useAuth();
  const { toast } = useOverlay();
  const tabs = [
    ...(can("receivables.view") || can("accounting.edit") ? [{ key: "receivables" as Tab, label: "Receivables" }] : []),
    ...(can("payables.view") || can("accounting.edit") ? [{ key: "payables" as Tab, label: "Payables" }] : []),
    ...(can("banks.view") ? [{ key: "banks" as Tab, label: "Bank accounts" }, { key: "custody" as Tab, label: "Cash custody" }] : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs.some((x) => x.key === initial) ? initial! : tabs[0]?.key ?? "receivables");
  const [log, setLog] = useState(false);
  const { data, error } = useAccounting();

  const exportTab = async () => {
    if (!data) return;
    try {
      if (tab === "receivables") {
        exportReceivableLedger(data.receivables.filter((c) => c.invoices.length > 0 || Number(c.opening_balance ?? 0) > 0).map((c) => {
          const entries: any[] = [];
          if (Number(c.opening_balance ?? 0) > 0) entries.push({ kind: "invoice", date: c.created_at ?? "1970-01-01", description: "Opening Balance", invoiceAmount: Number(c.opening_balance) });
          for (const inv of c.invoices) {
            entries.push({ kind: "invoice", date: inv.invoice_date, description: `Invoice ${inv.invoice_number}`, invoiceAmount: Number(inv.invoice_amount) });
            for (const p of data.payments.filter((x) => x.invoice_id === inv.id)) {
              const bank = p.payment_mode === "Bank" && p.bank_account_id ? data.banks.find((b) => b.id === p.bank_account_id)?.bank_name ?? "Bank" : "Cash";
              entries.push({ kind: "payment", date: p.payment_date, description: `Payment via ${bank} · Invoice ${inv.invoice_number}`, amount: Number(p.amount) });
            }
          }
          return { name: `${c.name} (${c.client_code})`, entries };
        }) as never, "Receivable Ledger.xlsx");
      } else if (tab === "payables") {
        await exportTable({
          fileName: "Accounts Payable.xlsx", sheetName: "Payables", title: "Accounts Payable",
          headers: ["Date", "Vendor", "Category", "Client", "Description", "Amount", "Due Date", "Status"],
          rows: data.payables.map((p) => [p.expense_date, p.vendor?.name ?? "", p.category?.name ?? "", p.client?.name ?? "", p.description ?? "", Number(p.amount), p.due_date ?? "", payableStatus(p)]),
        } as never);
      } else if (tab === "banks") {
        const byId = new Map(data.banks.map((b) => [b.id, b]));
        await exportBankStatement(data.transactions.slice().sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1)).map((x) => {
          const bk = x.bank_account_id ? byId.get(x.bank_account_id) : null;
          return { date: String(x.created_at ?? "").slice(0, 10), kind: KIND[x.kind] ?? x.kind, description: x.description, bankName: bk ? `${bk.bank_name} (${bk.account_number})` : "Cash",
            credit: x.account_delta > 0 ? x.account_delta : 0, debit: x.account_delta < 0 ? -x.account_delta : 0, cashIn: x.cash_delta > 0 ? x.cash_delta : 0, cashOut: x.cash_delta < 0 ? -x.cash_delta : 0 };
        }), { bankLabel: "All Banks" } as never, "Bank Statement.xlsx");
      }
    } catch (x) { toast(err(x), "danger"); }
  };

  return (
    <Screen
      region
      eyebrow="Finance"
      title="Banks & Ledgers"
      actions={<>
        {tab !== "custody" && <IconBtn icon={Download} label="Export" onPress={() => { void exportTab(); }} />}
        {can("banks.view") && tab === "banks" && <IconBtn icon={History} label="Transactions" onPress={() => setLog(true)} />}
      </>}
      sticky={<Tabs value={tab} onChange={setTab} items={tabs} />}
    >
      {error ? <Banner tone="danger" title="Couldn't load" sub={error} /> : !data ? <ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} /> : (
        <>
          {tab === "receivables" && <Receivables data={data} />}
          {tab === "payables" && <Payables data={data} />}
          {tab === "banks" && <Banks data={data} />}
          {tab === "custody" && <Custody data={data} />}
          <Sheet open={log} onClose={() => setLog(false)} title="Transaction log" full>
            {data.transactions.slice(0, 200).map((x) => {
              const bk = data.banks.find((b) => b.id === x.bank_account_id);
              const delta = Number(x.account_delta) || Number(x.cash_delta) || 0;
              return (
                <Card key={x.id} style={{ marginBottom: 8 }}>
                  <HStack>
                    <View style={{ flex: 1 }}>
                      <T v="smallStrong" style={{ fontSize: 14 }}>{KIND[x.kind] ?? x.kind}</T>
                      <T v="small" muted>{bk ? bk.bank_name : "Cash"}{x.description ? ` · ${x.description}` : ""}</T>
                    </View>
                    <T v="monoLg" color={delta < 0 ? t.tone("danger").text : t.tone("success").text}>{pkr(delta, { sign: true, compact: true })}</T>
                  </HStack>
                  <T v="mono" muted style={{ fontSize: 11, marginTop: 6 }}>{fmtShort(String(x.created_at).slice(0, 10))}</T>
                </Card>
              );
            })}
          </Sheet>
        </>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------- Receivables
function Receivables({ data }: { data: AccountingData }) {
  const router = useRouter();
  const { can } = useAuth();
  const { regionId } = useRegion();
  const [q, setQ] = useState("");
  const [pay, setPay] = useState<any | null>(null);
  const [wht, setWht] = useState<any | null>(null);
  const [opening, setOpening] = useState<any | null>(null);
  const rows = data.receivables.filter((c) => inRegion(regionId, c.branch_id) && (!q || String(c.name).toLowerCase().includes(q.toLowerCase())));
  const tot = rows.reduce((a, r) => ({ opening: a.opening + Number(r.opening_balance ?? 0), invoiced: a.invoiced + r.total_invoiced, wht: a.wht + r.total_withholding, received: a.received + r.total_received, out: a.out + r.outstanding }), { opening: 0, invoiced: 0, wht: 0, received: 0, out: 0 });
  const canEdit = can("accounting.edit");
  return (
    <>
      <StatGrid items={[
        { label: "Opening", value: pkr(tot.opening, { compact: true }), tone: "neutral" }, { label: "Invoiced", value: pkr(tot.invoiced, { compact: true }), tone: "brand" },
        { label: "Withholding", value: pkr(tot.wht, { compact: true }), tone: "danger" }, { label: "Received", value: pkr(tot.received, { compact: true }), tone: "success" },
        { label: "Outstanding", value: pkr(tot.out, { compact: true }), tone: "warning" },
      ]} />
      <View style={{ marginVertical: 12 }}><SearchBar value={q} onChange={setQ} placeholder="Client" /></View>
      {rows.map((c) => (
        <RecordCard key={c.id} title={c.name} subtitle={c.client_code} onPress={() => router.push(`/accounting/statement/${c.id}`)} accent={c.outstanding > 0 ? "warning" : undefined}
          fields={[
            { label: "Opening", value: pkr(Number(c.opening_balance ?? 0), { compact: true }), mono: true }, { label: "Invoiced", value: pkr(c.total_invoiced, { compact: true }), mono: true },
            { label: "Withholding", value: pkr(c.total_withholding, { compact: true }), mono: true }, { label: "Received", value: pkr(c.total_received, { compact: true }), mono: true, tone: "success" },
            { label: "Outstanding", value: pkr(c.outstanding), mono: true, tone: c.outstanding > 0 ? "warning" : undefined, full: true },
          ]}
          actions={[
            { label: "Statement", icon: FileText, onPress: () => router.push(`/accounting/statement/${c.id}`) },
            ...(canEdit ? [
              { label: "Payment", icon: Wallet, onPress: () => setPay(c) },
              { label: "WHT", icon: Receipt, onPress: () => setWht(c) },
              { label: "Opening", icon: Pencil, onPress: () => setOpening(c) },
            ] : []),
          ]} />
      ))}
      {pay && <ReceiptSheet client={pay} data={data} onClose={() => setPay(null)} />}
      {wht && <WhtSheet client={wht} data={data} onClose={() => setWht(null)} />}
      {opening && <OpeningSheet client={opening} onClose={() => setOpening(null)} />}
    </>
  );

}

function ReceiptSheet({ client, data, onClose }: { client: any; data: AccountingData; onClose: () => void }) {
  const { act } = useDB();
  const open = client.invoices.filter((i: any) => invoiceOutstanding(i) > 0);
  const [f, setF] = useState({ via: "Bank" as "Bank" | "Cash" | "Cheque", amount: "", date: TODAY, bankId: data.banks.find((b) => b.active !== false)?.id ?? "", custodian: "", notes: "", standalone: open.length === 0, invoiceId: open[0]?.id ?? "", chequeNumber: "", chequeDate: TODAY });
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Record payment" subtitle={client.name}
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label="Record" full loading={busy} onPress={async () => {
        setBusy(true);
        const ok = await act(() => recordClientReceipt(client, { ...f, amount: Number(f.amount), custodian: data.custodians.find((c) => c.locationId === f.custodian) }), f.via === "Cheque" ? "Cheque recorded — clears later" : "Payment recorded");
        setBusy(false);
        if (ok) onClose();
      }} /></>}>
      <Chips value={f.via} onChange={(v) => setF({ ...f, via: v })} items={[{ key: "Bank", label: "Bank" }, { key: "Cash", label: "Cash" }, { key: "Cheque", label: "Cheque" }]} />
      <View style={{ height: 10 }} />
      <Toggle label="On account (no invoice)" sub={open.length === 0 ? "Nothing is open — this clears the opening balance" : undefined} value={f.standalone} onChange={(v) => setF({ ...f, standalone: v })} />
      {!f.standalone && <Select label="Invoice" required value={f.invoiceId} onChange={(v) => setF({ ...f, invoiceId: v })} options={open.map((i: any) => ({ value: i.id, label: i.invoice_number, sub: `outstanding ${pkr(invoiceOutstanding(i))}` }))} />}
      <Input label="Amount" required amount value={f.amount} onChangeText={(v) => setF({ ...f, amount: v })} />
      <Input label="Date" value={f.date} onChangeText={(v) => setF({ ...f, date: v })} placeholder="YYYY-MM-DD" />
      {(f.via === "Bank" || f.via === "Cheque") && <Select label={f.via === "Cheque" ? "Deposit into" : "Bank account"} required value={f.bankId} onChange={(v) => setF({ ...f, bankId: v })} options={data.banks.filter((b) => b.active !== false).map((b) => ({ value: b.id, label: b.bank_name, sub: b.account_number }))} />}
      {f.via === "Cash" && <Select label="Received by" required value={f.custodian} onChange={(v) => setF({ ...f, custodian: v })} options={data.custodians.map((c) => ({ value: c.locationId!, label: c.fullName }))} />}
      {f.via === "Cheque" && (
        <HStack gap={10}>
          <Input style={{ flex: 1 }} label="Cheque #" required value={f.chequeNumber} onChangeText={(v) => setF({ ...f, chequeNumber: v })} />
          <Input style={{ flex: 1 }} label="Cheque date" required value={f.chequeDate} onChangeText={(v) => setF({ ...f, chequeDate: v })} />
        </HStack>
      )}
      <Input label="Notes" value={f.notes} onChangeText={(v) => setF({ ...f, notes: v })} />
      <T v="small" muted>Withholding is recorded separately with WHT, against the receipt it was deducted from.</T>
    </Sheet>
  );
}

function WhtSheet({ client, data, onClose }: { client: any; data: AccountingData; onClose: () => void }) {
  const { act } = useDB();
  const invIds = new Set(client.invoices.map((i: any) => i.id));
  const receipts = data.payments.filter((p) => p.client_id === client.id || (p.invoice_id && invIds.has(p.invoice_id))).sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1));
  const [id, setId] = useState(receipts[0]?.id ?? "");
  const r = receipts.find((x) => x.id === id);
  const rate = Number(client.withholding_tax_rate ?? 0);
  const [amt, setAmt] = useState(r ? (Number(r.withholding_amount) > 0 ? String(r.withholding_amount) : rate > 0 ? String(Math.round(Number(r.amount) * rate) / 100) : "") : "");
  return (
    <Sheet open onClose={onClose} title="Record withholding" subtitle={client.name}
      footer={<Button label="Save" full onPress={async () => { if (await act(() => recordWithholding(id, Number(amt)), "Withholding recorded")) onClose(); }} />}>
      {receipts.length === 0 ? <Banner tone="info" title="No receipts yet" sub="Withholding is recorded against a receipt." /> : (
        <>
          <Select label="Receipt" required value={id} onChange={(v) => { setId(v); const x = receipts.find((y) => y.id === v); setAmt(x ? (Number(x.withholding_amount) > 0 ? String(x.withholding_amount) : rate > 0 ? String(Math.round(Number(x.amount) * rate) / 100) : "") : ""); }}
            options={receipts.map((p) => ({ value: p.id, label: `${pkr(Number(p.amount))} · ${fmtShort(p.payment_date)}`, sub: p.payment_mode }))} />
          <Input label="Withheld amount" amount value={amt} onChangeText={setAmt} />
          <T v="small" muted>Enter 0 to clear it. Prefilled at the client&apos;s agreed rate.</T>
        </>
      )}
    </Sheet>
  );
}

function OpeningSheet({ client, onClose }: { client: any; onClose: () => void }) {
  const { act } = useDB();
  const [v, setV] = useState(String(client.opening_balance ?? 0));
  return (
    <Sheet open onClose={onClose} title="Opening balance" subtitle={client.name} footer={<Button label="Save" full onPress={async () => { if (await act(() => setClientOpening(client.id, Number(v)), "Opening balance saved")) onClose(); }} />}>
      <Input label="Opening receivable" amount value={v} onChangeText={setV} />
    </Sheet>
  );
}

export function ClientStatement() {
  const t = useTheme();
  const { clientId } = useLocalSearchParams<{ clientId: string }>();
  const { toast } = useOverlay();
  const { data } = useAccounting();
  const [month, setMonth] = useState<string>("all");
  const c = data?.receivables.find((x) => x.id === clientId);
  const ledger = useMemo(() => (c && data ? statementLedger(c, data, month) : null), [c, data, month]);
  if (!data) return <Screen title="Statement"><ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} /></Screen>;
  if (!c || !ledger) return <Screen title="Statement"><Empty title="Client not found" /></Screen>;
  const months = [...new Set(data.invoices.filter((i) => i.client_id === c.id).map((i) => String(i.service_month ?? i.period_start ?? i.invoice_date ?? "").slice(0, 7)))].sort().reverse();
  return (
    <Screen eyebrow="Client statement" title={c.name} actions={<IconBtn icon={ArrowDownToLine} label="Download" onPress={() => {
      exportClientStatementLedger({
        clientName: c.name, clientCode: c.client_code, periodLabel: ledger.scopeLabel, opening: ledger.opening,
        rows: ledger.entries.map((e) => ({ date: e.date, label: e.label, reference: e.reference, account: e.account, debit: e.debit, credit: e.credit, withholding: e.withholding, balance: e.balance })),
        debits: ledger.debits, credits: ledger.credits, withheld: ledger.withheld, closing: ledger.closing, fileName: `Client Statement - ${c.name} - ${ledger.scopeLabel}.xlsx`,
      } as never).catch((e) => toast(err(e), "danger"));
    }} />}>
      <Select compact label="Month" value={month} onChange={setMonth} options={[{ value: "all", label: "All months" }, ...months.map((m) => ({ value: m, label: m }))]} />
      <View style={{ height: 10 }} />
      <StatGrid items={[
        { label: "Opening", value: pkr(ledger.opening, { compact: true }) }, { label: "Invoiced", value: pkr(ledger.debits, { compact: true }), tone: "brand" },
        { label: "Received", value: pkr(ledger.credits, { compact: true }), tone: "success" }, { label: "Withholding", value: pkr(ledger.withheld, { compact: true }), tone: "danger" },
        { label: "Closing", value: pkr(ledger.closing), tone: "warning" },
      ]} />
      {month === "all" && Math.abs(ledger.closing - ledger.rowOutstanding) > 0.5 && <Banner tone="danger" title="Statement disagrees with the receivables row" sub={`Row says ${pkr(ledger.rowOutstanding)}, statement closes at ${pkr(ledger.closing)}.`} />}
      <Section title="Ledger" count={ledger.entries.length}>
        <ListCard>
          {ledger.entries.map((l, i) => (
            <Row key={l.key} last={i === ledger.entries.length - 1} title={l.label} subtitle={[l.reference, l.account].filter(Boolean).join(" · ")} meta={fmtShort(l.date)}
              right={<View style={{ alignItems: "flex-end" }}>
                <T v="mono">{l.debit ? `+${pkr(l.debit, { compact: true })}` : `−${pkr(l.credit, { compact: true })}`}</T>
                <T v="mono" muted style={{ fontSize: 11 }}>bal {pkr(l.balance, { compact: true })}</T>
              </View>} />
          ))}
        </ListCard>
      </Section>
    </Screen>
  );
}

// ---------------------------------------------------------------- Payables
function Payables({ data }: { data: AccountingData }) {
  const { act } = useDB();
  const { can } = useAuth();
  const { confirm } = useOverlay();
  const [status, setStatus] = useState("all");
  const [sub, setSub] = useState<"bills" | "payments">("bills");
  const [paying, setPaying] = useState<{ vendorId: string; vendorName: string; expenseId: string | null; owed: number } | null>(null);
  const paidOf = (p: any) => (p.payable_status === "Paid" ? Number(p.amount) : data.paidByExpense.get(p.id) ?? 0);
  const owedOf = (p: any) => Number(p.amount) - paidOf(p);
  const list = data.payables.filter((p) => status === "all" || payableStatus(p) === status);
  const sum = (s: string) => data.payables.filter((p) => payableStatus(p) === s).reduce((a, p) => a + owedOf(p), 0);
  const canEdit = can("accounting.edit");
  return (
    <>
      <StatGrid items={[
        { label: "Pending", value: pkr(sum("Pending"), { compact: true }), tone: "warning" }, { label: "Overdue", value: pkr(sum("Overdue"), { compact: true }), tone: "danger" },
        { label: "Paid", value: pkr(data.payables.reduce((a, p) => a + paidOf(p), 0), { compact: true }), tone: "success" }, { label: "Total", value: pkr(data.payables.reduce((a, p) => a + Number(p.amount), 0), { compact: true }) },
      ]} />
      <View style={{ marginVertical: 12 }}><Segmented value={sub} onChange={setSub} items={[{ key: "bills", label: "Bills" }, { key: "payments", label: "Vendor payments", count: data.vendorPayments.length }]} /></View>
      {sub === "bills" ? (
        <>
          <Chips value={status} onChange={setStatus} items={["all", "Pending", "Overdue", "Paid"].map((s) => ({ key: s, label: s === "all" ? "All" : s }))} />
          <View style={{ height: 10 }} />
          {list.map((p) => (
            <RecordCard key={p.id} title={p.vendor?.name ?? "Vendor"} subtitle={p.category?.name} badge={<Badge label={payableStatus(p)} tone={toneOf(payableStatus(p))} />}
              fields={[{ label: "Amount", value: pkr(Number(p.amount)), mono: true }, { label: "Owed", value: pkr(owedOf(p)), mono: true, tone: owedOf(p) > 0 ? "warning" : undefined }, { label: "Due", value: fmtShort(p.due_date) }, { label: "Expense date", value: fmtShort(p.expense_date) }, { label: "Description", value: p.description ?? "—", full: true }]}
              actions={canEdit ? (p.payable_status === "Paid"
                ? [{ label: "Revert to pending", icon: Undo2, onPress: async () => { if (await confirm({ title: `Revert payment for "${p.vendor?.name ?? "vendor"}"?`, message: "The original deduction is reversed.", confirmLabel: "Revert", tone: "danger" })) await act(() => revertPayable(p.id), "Reverted to pending"); } }]
                : [
                  { label: "Pay this bill", icon: Wallet, tone: "brand" as const, onPress: () => setPaying({ vendorId: p.vendor_id, vendorName: p.vendor?.name ?? "Vendor", expenseId: p.id, owed: owedOf(p) }) },
                  { label: "Pay vendor", onPress: () => setPaying({ vendorId: p.vendor_id, vendorName: p.vendor?.name ?? "Vendor", expenseId: null, owed: data.payables.filter((x) => x.vendor_id === p.vendor_id && x.payable_status !== "Paid").reduce((a, x) => a + owedOf(x), 0) }) },
                ]) : undefined} />
          ))}
          {list.length === 0 && <Empty title="No payables" />}
        </>
      ) : (
        <>
          {data.vendorPayments.map((vp) => (
            <RecordCard key={vp.id} title={pkr(Number(vp.amount))} subtitle={`${data.payables.find((x) => x.vendor_id === vp.vendor_id)?.vendor?.name ?? "Vendor"} · ${vp.paid_via}`}
              fields={[{ label: "Paid on", value: fmtShort(vp.paid_on) }, { label: "Notes", value: vp.notes ?? "—" }]}
              actions={canEdit ? [{ label: "Revert", icon: Undo2, onPress: async () => { if (await confirm({ title: `Revert this vendor payment of ${pkr(Number(vp.amount))}?`, message: "The bills it cleared go back to what they owed, and the money is returned.", confirmLabel: "Revert", tone: "danger" })) await act(() => revertVendorPayment(vp.id), "Payment reverted"); } }] : undefined} />
          ))}
          {data.vendorPayments.length === 0 && <Empty title="No vendor payments" />}
        </>
      )}
      {paying && <PayVendorSheet target={paying} data={data} onClose={() => setPaying(null)} />}
    </>
  );
}

function PayVendorSheet({ target, data, onClose }: { target: { vendorId: string; vendorName: string; expenseId: string | null; owed: number }; data: AccountingData; onClose: () => void }) {
  const { act } = useDB();
  const [amount, setAmount] = useState(target.expenseId ? String(target.owed) : "");
  const [via, setVia] = useState<"Cash" | "Bank">("Cash");
  const [bankId, setBankId] = useState(data.banks[0]?.id ?? "");
  const [cust, setCust] = useState("");
  return (
    <Sheet open onClose={onClose} title={`Pay ${target.vendorName}`} subtitle={`Owed ${pkr(target.owed)} · applied oldest bill first`}
      footer={<Button label="Pay" full onPress={async () => {
        if (await act(() => payVendor({ vendorId: target.vendorId, amount: Number(amount), owed: target.owed, via, bankId, custodian: data.custodians.find((c) => c.locationId === cust), expenseId: target.expenseId }), "Payment recorded")) onClose();
      }} />}>
      <Input label="Amount" amount value={amount} onChangeText={setAmount} />
      <Chips value={via} onChange={setVia} items={[{ key: "Cash", label: "Cash" }, { key: "Bank", label: "Bank" }]} />
      <View style={{ height: 10 }} />
      {via === "Bank" ? <Select label="Bank account" required value={bankId} onChange={setBankId} options={data.banks.map((b) => ({ value: b.id, label: b.bank_name, sub: b.account_number }))} />
        : <Select label="Paid by" required value={cust} onChange={setCust} options={data.custodians.map((c) => ({ value: c.locationId!, label: c.fullName }))} />}
    </Sheet>
  );
}

// ---------------------------------------------------------------- Banks, cheques, deposits
function Banks({ data }: { data: AccountingData }) {
  const { db, act } = useDB();
  const { can } = useAuth();
  const { toast, confirm } = useOverlay();
  const [sub, setSub] = useState<"cheques" | "deposits">("cheques");
  const [sheet, setSheet] = useState<null | "cheque" | "deposit" | "withdraw" | "wire" | "bank">(null);
  const [bankEdit, setBankEdit] = useState<{ id: string | null; f: BankForm } | null>(null);
  const [target, setTarget] = useState<any | null>(null);
  const [bounce, setBounce] = useState<any | null>(null);
  const [reason, setReason] = useState("");
  const canEdit = can("accounting.edit");
  const company = { id: db.company.id, name: db.company.name };
  const bankTotal = data.banks.reduce((a, b) => a + Number(b.balance ?? 0), 0);
  const transit = data.cheques.filter((c) => c.status === "pending").reduce((a, c) => a + ((c.direction ?? "outgoing") === "incoming" ? Number(c.amount) : 0), 0);

  const slip = async (d: any) => {
    const bank = data.banks.find((b) => b.id === d.bank_account_id);
    const who = data.custodians.find((c) => c.locationId === d.cash_location_id)?.fullName ?? "—";
    const { company: co } = await loadBranding(db.company.id);
    generateDepositSlipPdf({ slipNumber: d.slip_number, date: d.deposit_date, bankName: bank?.bank_name ?? "—", accountNumber: bank?.account_number ?? "—", amount: Number(d.amount), depositedBy: who, reference: d.notes }, co);
  };

  return (
    <>
      <StatGrid items={[
        { label: "Cash in hand", value: pkr(data.cashInHand, { compact: true }), tone: "success", hint: "all custodians" },
        { label: "Bank balance", value: pkr(bankTotal, { compact: true }), tone: "brand" },
        { label: "Incoming cheques", value: pkr(transit, { compact: true }), tone: "warning", hint: "pending" },
        { label: "Total position", value: pkr(data.cashInHand + bankTotal, { compact: true }) },
      ]} />
      {canEdit && (
        <HStack wrap style={{ marginTop: 12 }}>
          <Button size="sm" variant="secondary" icon={ArrowRightLeft} label="Transfer" onPress={() => setSheet("wire")} />
          <Button size="sm" variant="secondary" icon={Banknote} label="Cash deposit" onPress={() => setSheet("deposit")} />
          <Button size="sm" variant="secondary" icon={Plus} label="Bank account" onPress={() => setBankEdit({ id: null, f: blankBank() })} />
        </HStack>
      )}
      <Section title="Accounts" count={data.banks.length}>
        {data.banks.map((b) => (
          <RecordCard key={b.id} title={b.bank_name} subtitle={b.account_number} badge={<Badge label={b.active === false ? "Inactive" : b.account_type} small tone={b.active === false ? "neutral" : "info"} />} leading={<Landmark size={20} />}
            fields={[{ label: "Owner", value: b.owner_type }, { label: "Balance", value: pkr(Number(b.balance)), mono: true, tone: "brand" }, { label: "IBAN", value: b.iban ?? "—", mono: true, full: true }]}
            actions={canEdit ? [
              { label: "Withdraw", icon: Banknote, onPress: () => { setTarget(b); setSheet("withdraw"); } },
              { label: "Edit", icon: Pencil, onPress: () => setBankEdit({ id: b.id, f: { bank_name: b.bank_name, account_number: b.account_number, account_type: b.account_type, opening_balance: "", owner_type: b.owner_type, owner_partner_id: b.owner_partner_id ?? "", owner_client_id: b.owner_client_id ?? "", iban: b.iban ?? "", branch_code: b.branch_code ?? "", branch_name: b.branch_name ?? "", swift_code: b.swift_code ?? "", currency_code: b.currency_code ?? "PKR" } }) },
              { label: b.active === false ? "Activate" : "Deactivate", icon: Power, onPress: async () => {
                if (await confirm({ title: b.active === false ? `Activate ${b.bank_name}?` : `Deactivate ${b.bank_name}?`, message: b.active === false ? "It will be selectable again." : "Its balance and history are kept; it just won't appear in new selection lists.", confirmLabel: "Confirm" })) await act(() => setBankActive(b.id, b.active === false), "Saved");
              } },
            ] : undefined} />
        ))}
      </Section>
      <View style={{ marginTop: 18 }}>
        <Segmented value={sub} onChange={setSub} items={[{ key: "cheques", label: "Cheques", count: data.cheques.length }, { key: "deposits", label: "Cash deposits", count: data.deposits.length }]} />
      </View>
      {canEdit && sub === "cheques" && <Button style={{ marginTop: 10 }} size="sm" variant="secondary" icon={Plus} label="New cheque" onPress={() => setSheet("cheque")} />}
      <View style={{ marginTop: 10 }}>
        {sub === "cheques" ? data.cheques.map((c) => {
          const incoming = (c.direction ?? "outgoing") === "incoming";
          const linked = data.linkedSums.get(c.id) ?? 0;
          const clearable = canClearCheque(c, linked);
          return (
            <RecordCard key={c.id} title={`#${c.cheque_number} · ${c.recipient ?? "—"}`} subtitle={data.banks.find((b) => b.id === c.bank_account_id)?.bank_name} badge={<Badge label={c.status} tone={toneOf(c.status)} />}
              fields={[{ label: "Direction", value: incoming ? "Incoming" : c.cheque_type === "cash" ? "Cash cheque" : "Payment" }, { label: "Amount", value: pkr(Number(c.amount)), mono: true }, { label: "Date", value: fmtShort(c.cheque_date) },
                ...(c.cheque_type === "payment" && !incoming ? [{ label: "Linked", value: pkr(linked), mono: true, tone: clearable ? undefined : ("warning" as const) }] : [])]}
              actions={[
                ...(c.drive_view_url ? [{ label: "View", icon: Paperclip, onPress: () => { Linking.openURL(c.drive_view_url).catch(() => {}); } }] : []),
                ...(canEdit && c.status === "pending" ? [
                  { label: "Cleared", icon: CheckCircle2, onPress: async () => {
                    if (!clearable) return toast(`Linked items total ${pkr(linked)} must equal the cheque amount ${pkr(Number(c.amount))} before clearing.`, "danger");
                    if (await confirm({ title: `Mark cheque #${c.cheque_number} cleared?`, message: incoming ? `${pkr(Number(c.amount))} is credited to the bank.` : c.cheque_type === "payment" ? "Bank stays deducted; linked items are recognised now." : `${pkr(Number(c.amount))} is added to the custodian's cash.`, confirmLabel: "Clear" })) await act(() => clearCheque(c.id), "Cheque cleared");
                  } },
                  { label: "Bounce", tone: "danger" as const, onPress: () => { setReason(""); setBounce(c); } },
                ] : []),
              ]} />
          );
        }) : data.deposits.map((d) => (
          <RecordCard key={d.id} title={pkr(Number(d.amount))} subtitle={`Slip ${d.slip_number} · ${data.banks.find((b) => b.id === d.bank_account_id)?.bank_name ?? "—"}`}
            fields={[{ label: "Date", value: fmtShort(d.deposit_date) }, { label: "Deposited by", value: data.custodians.find((c) => c.locationId === d.cash_location_id)?.fullName ?? "—" }, { label: "Reference", value: d.notes ?? "—", full: true }]}
            actions={[{ label: "Deposit slip", icon: FileText, onPress: () => { slip(d).catch((e) => toast(err(e), "danger")); } }, ...(d.drive_view_url ? [{ label: "Scan", icon: Paperclip, onPress: () => { Linking.openURL(d.drive_view_url).catch(() => {}); } }] : [])]} />
        ))}
      </View>

      {sheet === "cheque" && <ChequeSheet data={data} onClose={() => setSheet(null)} />}
      {sheet === "deposit" && <DepositSheet data={data} onClose={() => setSheet(null)} onDone={(d) => { void slip(d).catch(() => {}); }} />}
      {sheet === "withdraw" && target && <WithdrawSheet bank={target} data={data} onClose={() => setSheet(null)} />}
      {sheet === "wire" && <TransferSheet data={data} onClose={() => setSheet(null)} />}
      {bankEdit && <BankSheet init={bankEdit} data={data} onClose={() => setBankEdit(null)} />}
      <Sheet open={!!bounce} onClose={() => setBounce(null)} title={`Bounce cheque #${bounce?.cheque_number ?? ""}?`} subtitle={bounce && (bounce.direction ?? "outgoing") === "incoming" ? "No balance change — the bank was never credited." : "The deduction is reversed."}
        footer={<Button label="Bounce" variant="danger" full onPress={async () => { if (await act(() => bounceCheque(bounce.id, reason), "Cheque bounced")) setBounce(null); }} />}>
        <Input label="Reason" value={reason} onChangeText={setReason} multiline />
      </Sheet>
      <T v="small" muted style={{ marginTop: 10 }}>{company.name}</T>
    </>
  );
}

function ChequeSheet({ data, onClose }: { data: AccountingData; onClose: () => void }) {
  const { db, act } = useDB();
  const [f, setF] = useState({ bankId: "", number: "", amount: "", date: TODAY, direction: "outgoing" as "outgoing" | "incoming", type: "payment" as "payment" | "cash", recipient: "", notes: "", cust: "" });
  const [file, setFile] = useState<PickedFile | null>(null);
  const bank = data.banks.find((b) => b.id === f.bankId);
  return (
    <Sheet open onClose={onClose} title={f.direction === "incoming" ? "Record deposit cheque" : "New cheque"}
      footer={<Button label="Save cheque" full onPress={async () => {
        if (await act(() => newCheque({ bankId: f.bankId, number: f.number, amount: Number(f.amount), date: f.date, direction: f.direction, type: f.type, recipient: f.recipient, notes: f.notes, custodian: data.custodians.find((c) => c.locationId === f.cust), bankBalance: Number(bank?.balance ?? 0), file }, { id: db.company.id, name: db.company.name }), "Cheque recorded")) onClose();
      }} />}>
      <Chips value={f.direction} onChange={(v) => setF({ ...f, direction: v })} items={[{ key: "outgoing", label: "Outgoing" }, { key: "incoming", label: "Incoming" }]} />
      <View style={{ height: 10 }} />
      {f.direction === "outgoing" && <Chips value={f.type} onChange={(v) => setF({ ...f, type: v })} items={[{ key: "payment", label: "Payment" }, { key: "cash", label: "Cash (to a custodian)" }]} />}
      <View style={{ height: 10 }} />
      <Select label="Bank" required value={f.bankId} onChange={(v) => setF({ ...f, bankId: v })} options={data.banks.filter((b) => b.active !== false).map((b) => ({ value: b.id, label: b.bank_name, sub: `${b.account_number} · ${pkr(Number(b.balance))}` }))} />
      <HStack gap={10}>
        <Input style={{ flex: 1 }} label="Cheque #" required value={f.number} onChangeText={(v) => setF({ ...f, number: v })} />
        <Input style={{ flex: 1 }} label="Date" required value={f.date} onChangeText={(v) => setF({ ...f, date: v })} />
      </HStack>
      <Input label="Amount" required amount value={f.amount} onChangeText={(v) => setF({ ...f, amount: v })} />
      {f.direction === "outgoing" && f.type === "cash"
        ? <Select label="Cash goes to" required value={f.cust} onChange={(v) => setF({ ...f, cust: v })} options={data.custodians.map((c) => ({ value: c.locationId!, label: c.fullName }))} />
        : <Input label={f.direction === "incoming" ? "Received from" : "Payee"} value={f.recipient} onChangeText={(v) => setF({ ...f, recipient: v })} />}
      <Input label="Notes" value={f.notes} onChangeText={(v) => setF({ ...f, notes: v })} />
      {file ? <T v="small" style={{ marginBottom: 6 }}>{file.name}</T> : null}
      <HStack>
        <Button size="sm" variant="secondary" label="Photo" onPress={() => takePhoto().then((x) => x && setFile(x)).catch(() => {})} />
        <Button size="sm" variant="secondary" label="File" onPress={() => pickDocument().then((x) => x && setFile(x)).catch(() => {})} />
      </HStack>
    </Sheet>
  );
}

function DepositSheet({ data, onClose, onDone }: { data: AccountingData; onClose: () => void; onDone: (d: any) => void }) {
  const { db, act } = useDB();
  const [f, setF] = useState({ bankId: data.banks[0]?.id ?? "", amount: "", date: TODAY, description: "", notes: "", cust: "" });
  const [file, setFile] = useState<PickedFile | null>(null);
  const c = data.custodians.find((x) => x.locationId === f.cust);
  return (
    <Sheet open onClose={onClose} title="Cash deposit" subtitle="Cash moves from a custodian into the bank."
      footer={<Button label="Deposit" full onPress={async () => {
        let dep: any = null;
        const ok = await act(async () => { dep = await cashDeposit(f.bankId, c, Number(f.amount), f.date, [f.description.trim(), f.notes.trim()].filter(Boolean).join(" · "), file, { id: db.company.id, name: db.company.name }); }, "Cash deposited");
        if (ok) { onClose(); if (dep) onDone({ ...dep, bank_account_id: f.bankId, amount: Number(f.amount), deposit_date: f.date, notes: f.description, cash_location_id: f.cust }); }
      }} />}>
      <Select label="Deposited by" required value={f.cust} onChange={(v) => setF({ ...f, cust: v })} options={data.custodians.map((x) => ({ value: x.locationId!, label: x.fullName, sub: `holds ${pkr(x.held)}` }))} />
      <Select label="Into bank" required value={f.bankId} onChange={(v) => setF({ ...f, bankId: v })} options={data.banks.filter((b) => b.active !== false).map((b) => ({ value: b.id, label: b.bank_name, sub: b.account_number }))} />
      <Input label="Amount" required amount value={f.amount} onChangeText={(v) => setF({ ...f, amount: v })} />
      <Input label="Date" value={f.date} onChangeText={(v) => setF({ ...f, date: v })} />
      <Input label="Description" value={f.description} onChangeText={(v) => setF({ ...f, description: v })} />
      <Input label="Notes" value={f.notes} onChangeText={(v) => setF({ ...f, notes: v })} />
      {file ? <T v="small" style={{ marginBottom: 6 }}>{file.name}</T> : null}
      <Button size="sm" variant="secondary" label="Photo of the stamped slip" onPress={() => takePhoto().then((x) => x && setFile(x)).catch(() => {})} />
    </Sheet>
  );
}

function WithdrawSheet({ bank, data, onClose }: { bank: any; data: AccountingData; onClose: () => void }) {
  const { act } = useDB();
  const [amount, setAmount] = useState("");
  const [cust, setCust] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <Sheet open onClose={onClose} title={`Withdraw from ${bank.bank_name}`} subtitle={`Balance ${pkr(Number(bank.balance))}`}
      footer={<Button label="Withdraw" full onPress={async () => { if (await act(() => withdrawToCustodian({ id: bank.id, raw: bank, name: bank.bank_name }, data.custodians.find((c) => c.locationId === cust), Number(amount), TODAY, notes), "Withdrawn to cash")) onClose(); }} />}>
      <Select label="Cash goes to" required value={cust} onChange={setCust} options={data.custodians.map((c) => ({ value: c.locationId!, label: c.fullName }))} />
      <Input label="Amount" required amount value={amount} onChangeText={setAmount} />
      <Input label="Notes" value={notes} onChangeText={setNotes} />
    </Sheet>
  );
}

function TransferSheet({ data, onClose }: { data: AccountingData; onClose: () => void }) {
  const { act } = useDB();
  const [f, setF] = useState({ from: "", to: "", amount: "", date: TODAY, notes: "" });
  const opts = data.banks.filter((b) => b.active !== false).map((b) => ({ value: b.id, label: b.bank_name, sub: `${b.account_number} · ${pkr(Number(b.balance))}` }));
  return (
    <Sheet open onClose={onClose} title="Bank transfer"
      footer={<Button label="Transfer" full onPress={async () => { if (await act(() => bankTransfer(f.from, f.to, Number(f.amount), f.date, f.notes), "Transfer recorded")) onClose(); }} />}>
      <Select label="From" required value={f.from} onChange={(v) => setF({ ...f, from: v })} options={opts} />
      <Select label="To" required value={f.to} onChange={(v) => setF({ ...f, to: v })} options={opts} />
      <Input label="Amount" required amount value={f.amount} onChangeText={(v) => setF({ ...f, amount: v })} />
      <Input label="Date" value={f.date} onChangeText={(v) => setF({ ...f, date: v })} />
      <Input label="Notes" value={f.notes} onChangeText={(v) => setF({ ...f, notes: v })} />
    </Sheet>
  );
}

function BankSheet({ init, data, onClose }: { init: { id: string | null; f: BankForm }; data: AccountingData; onClose: () => void }) {
  const { act } = useDB();
  const [f, setF] = useState<BankForm>(init.f);
  const set = <K extends keyof BankForm>(k: K, v: BankForm[K]) => setF({ ...f, [k]: v });
  return (
    <Sheet open onClose={onClose} title={init.id ? "Edit bank account" : "Add bank account"} full
      footer={<Button label="Save" full onPress={async () => { if (await act(() => (init.id ? editBank(init.id, f) : addBank(f)), "Bank account saved")) onClose(); }} />}>
      <Input label="Bank name" required value={f.bank_name} onChangeText={(v) => set("bank_name", v)} />
      <Input label="Account number" required value={f.account_number} onChangeText={(v) => set("account_number", v)} />
      <Select label="Type" value={f.account_type} onChange={(v) => set("account_type", v)} options={["Current", "Savings"].map((x) => ({ value: x, label: x }))} />
      {!init.id && <Input label="Opening balance" amount value={f.opening_balance} onChangeText={(v) => set("opening_balance", v)} />}
      <Select label="Owner" value={f.owner_type} onChange={(v) => set("owner_type", v as BankForm["owner_type"])} options={[{ value: "company", label: "Company" }, { value: "partner", label: "Partner" }, { value: "client", label: "Client" }]} />
      {f.owner_type === "partner" && <Select label="Partner" required value={f.owner_partner_id} onChange={(v) => set("owner_partner_id", v)} options={data.partners.map((p) => ({ value: p.id, label: p.name }))} />}
      {f.owner_type === "client" && <Select label="Client" required value={f.owner_client_id} onChange={(v) => set("owner_client_id", v)} options={data.clients.map((c) => ({ value: c.id, label: c.name }))} />}
      <Input label="IBAN" value={f.iban} autoCapitalize="characters" onChangeText={(v) => set("iban", v)} />
      <HStack gap={10}>
        <Input style={{ flex: 1 }} label="Branch code" value={f.branch_code} onChangeText={(v) => set("branch_code", v)} />
        <Input style={{ flex: 1 }} label="SWIFT" value={f.swift_code} autoCapitalize="characters" onChangeText={(v) => set("swift_code", v)} />
      </HStack>
      <Input label="Branch name" value={f.branch_name} onChangeText={(v) => set("branch_name", v)} />
      <Input label="Currency" value={f.currency_code} autoCapitalize="characters" onChangeText={(v) => set("currency_code", v)} />
    </Sheet>
  );
}

// ---------------------------------------------------------------- Cash custody
function Custody({ data }: { data: AccountingData }) {
  const { db, act } = useDB();
  const { can } = useAuth();
  const { confirm } = useOverlay();
  const [loc, setLoc] = useState<LocationForm | null>(null);
  const [xfer, setXfer] = useState(false);
  const canEdit = can("accounting.edit");
  const heldBy = new Map(data.custodians.map((c) => [c.locationId, c.held]));
  const custodyLocs = data.locations.filter((l) => l.location_type === "CUSTODIAN");
  return (
    <>
      <StatGrid items={[
        { label: "Cash in hand", value: pkr(data.cashInHand, { compact: true }), tone: "success" },
        { label: "Opening (all custodians)", value: pkr(data.cashOpening, { compact: true }) },
      ]} />
      {canEdit && (
        <HStack wrap style={{ marginTop: 12 }}>
          <Button size="sm" variant="secondary" icon={ArrowRightLeft} label="Transfer cash" onPress={() => setXfer(true)} />
          <Button size="sm" variant="secondary" icon={Plus} label="Add custodian" onPress={() => setLoc({ name: "", location_type: "CUSTODIAN", employee_id: "", partner_id: "", branch_id: "", opening_balance: "", is_active: true })} />
        </HStack>
      )}
      <Section title="Custodians" count={custodyLocs.length}>
        {custodyLocs.map((l) => (
          <RecordCard key={l.id} title={l.name} subtitle={l.custodian_partner_id ? "Partner" : "Office staff"} badge={<Badge label={l.is_active ? "Active" : "Inactive"} tone={l.is_active ? "success" : "neutral"} small />}
            fields={[{ label: "Opening", value: pkr(Number(l.opening_balance ?? 0)), mono: true }, { label: "Holds", value: heldBy.has(l.id) ? pkr(heldBy.get(l.id)!) : "—", mono: true, tone: "success" }]}
            actions={canEdit ? [
              { label: "Edit", icon: Pencil, onPress: () => setLoc({ id: l.id, name: l.name, location_type: l.location_type, employee_id: l.custodian_employee_id ?? "", partner_id: l.custodian_partner_id ?? "", branch_id: l.branch_id ?? "", opening_balance: String(l.opening_balance ?? 0), is_active: !!l.is_active }) },
              { label: "Delete", tone: "danger" as const, onPress: async () => {
                const hasHistory = data.payments.some((p) => p.custodian_location_id === l.id) || data.deposits.some((d) => d.cash_location_id === l.id) || (heldBy.get(l.id) ?? 0) !== Number(l.opening_balance ?? 0);
                if (await confirm({ title: `Delete custodian "${l.name}"?`, message: "This cannot be undone.", confirmLabel: "Delete", tone: "danger" })) await act(() => deleteLocation(l, hasHistory), "Custodian deleted");
              } },
            ] : undefined} />
        ))}
      </Section>
      {loc && <LocationSheet f={loc} data={data} onClose={() => setLoc(null)} />}
      {xfer && <CustodyTransferSheet data={data} onClose={() => setXfer(false)} />}
      <T v="small" muted style={{ marginTop: 8 }}>{db.company.name}</T>
    </>
  );
}

function LocationSheet({ f: init, data, onClose }: { f: LocationForm; data: AccountingData; onClose: () => void }) {
  const { db, act } = useDB();
  const [f, setF] = useState<LocationForm>(init);
  const staff = db.employees.filter((e) => e.category === "office_staff" && e.lifecycle === "active");
  return (
    <Sheet open onClose={onClose} title={f.id ? "Edit custodian" : "Add custodian"}
      footer={<Button label="Save" full onPress={async () => {
        const name = f.employee_id ? staff.find((s) => s.id === f.employee_id)?.name ?? null : f.partner_id ? data.partners.find((p) => p.id === f.partner_id)?.name ?? null : null;
        if (await act(() => saveLocation(db.company.id, f, name, data.locations), "Custodian saved")) onClose();
      }} />}>
      <Select label="Office staff member" clearable value={f.employee_id} onChange={(v) => setF({ ...f, employee_id: v, partner_id: "" })} options={staff.map((s) => ({ value: s.id, label: s.name }))} />
      <Select label="…or a partner" clearable value={f.partner_id} onChange={(v) => setF({ ...f, partner_id: v, employee_id: "" })} options={data.partners.map((p) => ({ value: p.id, label: p.name }))} />
      {!f.employee_id && !f.partner_id && <Input label="Name" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} />}
      <Select label="Region" clearable value={f.branch_id} onChange={(v) => setF({ ...f, branch_id: v })} options={db.branches.map((b) => ({ value: b.id, label: b.name }))} />
      <Input label="Opening balance" amount value={f.opening_balance} onChangeText={(v) => setF({ ...f, opening_balance: v })} />
      <Toggle label="Active" value={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} />
    </Sheet>
  );
}

function CustodyTransferSheet({ data, onClose }: { data: AccountingData; onClose: () => void }) {
  const { act } = useDB();
  const [f, setF] = useState({ fromType: "staff" as "staff" | "bank", fromLocation: "", fromBank: "", to: "", amount: "", date: TODAY, notes: "" });
  const people = data.custodians.map((c) => ({ value: c.locationId!, label: c.fullName, sub: `holds ${pkr(c.held)}` }));
  return (
    <Sheet open onClose={onClose} title="Transfer cash"
      footer={<Button label="Transfer" full onPress={async () => { if (await act(() => custodyTransfer({ ...f, amount: Number(f.amount) }), "Transfer recorded")) onClose(); }} />}>
      <Chips value={f.fromType} onChange={(v) => setF({ ...f, fromType: v })} items={[{ key: "staff", label: "From a custodian" }, { key: "bank", label: "From a bank" }]} />
      <View style={{ height: 10 }} />
      {f.fromType === "staff" ? <Select label="From" required value={f.fromLocation} onChange={(v) => setF({ ...f, fromLocation: v })} options={people} />
        : <Select label="From bank" required value={f.fromBank} onChange={(v) => setF({ ...f, fromBank: v })} options={data.banks.filter((b) => b.active !== false).map((b) => ({ value: b.id, label: b.bank_name, sub: b.account_number }))} />}
      <Select label="To" required value={f.to} onChange={(v) => setF({ ...f, to: v })} options={people} />
      <Input label="Amount" required amount value={f.amount} onChangeText={(v) => setF({ ...f, amount: v })} />
      <Input label="Date" value={f.date} onChangeText={(v) => setF({ ...f, date: v })} />
      <Input label="Notes" value={f.notes} onChangeText={(v) => setF({ ...f, notes: v })} />
    </Sheet>
  );
}


