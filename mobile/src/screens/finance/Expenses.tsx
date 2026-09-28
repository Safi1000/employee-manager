import { Camera, CheckCircle2, Download, Eye, FilePlus2, Lock, Pencil, Plus, Power, Store, Tags, Trash2, Undo2 } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { Bars, Progress } from "../../components/Charts";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Chips, Empty, Fields, HStack, IconBtn, Input, ListCard, RecordCard, Row, SearchBar, Section, StatGrid, Tabs, Toggle, toneOf } from "../../components/ui";
import { THIS_MONTH, TODAY } from "../../data/seed";
import { useDB } from "../../data/store";
import {
  addAdvance, addExpense, advanceError, AdvanceForm, amendAdvance, amendExpense, blankExpense, decideInstance, deleteAdvance, deleteCategory, deleteExpense,
  deleteFixed, deleteVendor, expenseError, ExpenseForm, expenseFormFrom, ExpensesData, FixedForm, isAmortising, loadExpensesData, loadReceipts, PREPAID_THRESHOLD,
  reopenInstance, saveCategory, saveFixed, saveInstance, saveVendor, setExpenseApproval, toggleFixed,
} from "../../data/api/expenses";
import type { PickedFile } from "../../data/api/core";
import { useAuth } from "../../lib/auth";
import { pickDocument, takePhoto } from "../../lib/files";
import { fmtMonth, fmtShort, pkr } from "../../lib/format";
import { inRegion, useRegion } from "../../lib/region";
import { exportAdvances, exportExpenses } from "../../lib/web/excel";
import { useTheme } from "../../theme/ThemeProvider";

type Tab = "expenses" | "fixed" | "advances" | "deferred";
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useExpenses(month: string) {
  const { db, v } = useDB();
  const { can } = useAuth();
  const [data, setData] = useState<ExpensesData | null>(null);
  const [e, setE] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await loadExpensesData(db.company.id, can("banks.view"), month)); setE(null); } catch (x) { setE(err(x)); }
  }, [db.company.id, can, month]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
  useEffect(() => { void load(); }, [load, v]);
  return { data, error: e };
}

export default function Expenses() {
  const t = useTheme();
  const { can } = useAuth();
  const { toast } = useOverlay();
  const [tab, setTab] = useState<Tab>("expenses");
  const [month, setMonth] = useState(THIS_MONTH);
  const { data, error } = useExpenses(month);
  const [edit, setEdit] = useState<any | "new" | null>(null);
  const [adv, setAdv] = useState<any | "new" | null>(null);
  const [fixed, setFixed] = useState<any | "new" | null>(null);
  const [vendors, setVendors] = useState(false);
  const [cats, setCats] = useState(false);
  const canEdit = can("expenses.edit");
  const pending = data?.instances.filter((i) => i.status === "pending").length ?? 0;
  // The web's ExportButton, tab for tab: what the tab SHOWS is what is exported.
  const doExport = () => {
    if (!data) return;
    const today = new Date().toISOString().slice(0, 10);
    const bankName = (id: string | null) => data.banks.find((b) => b.id === id)?.bank_name;
    const run = tab === "advances"
      ? exportAdvances(data.advances.map((a) => ({
        date: a.advance_date, employee: `${a.employee?.guard_code ?? a.employee?.employee_code ?? ""} ${a.employee?.full_name ?? ""}`.trim(), client: a.client?.name ?? "",
        amount: Number(a.amount), mode: a.payment_mode === "Bank" && bankName(a.bank_account_id) ? `Bank · ${bankName(a.bank_account_id)}` : a.payment_mode, remarks: a.notes ?? "",
      })), `Advances ${today}.xlsx`)
      : tab === "fixed"
        ? exportExpenses(data.instances.map((i) => ({
          date: i.period_month, particulars: `${i.description ?? ""}${i.status === "pending" ? " (pending)" : i.status === "denied" ? " (denied)" : ""}`.trim(),
          category: i.category?.name ?? "", client: i.client?.name ?? "Office", amount: Number(i.amount), mode: i.payment_mode,
        })), `Fixed Expenses ${month}.xlsx`)
        : tab === "deferred"
          ? exportExpenses(data.deferred.map((d) => ({
            date: d.expense_date, particulars: `${d.description ?? ""} — ${d.months_released}/${d.months_total} months released`.trim(), category: d.category_name ?? "",
            client: d.shape === "prepaid" ? "Prepaid" : "Service period", amount: Number(d.remaining), mode: `${d.period_start}–${d.period_end}`,
          })), `Deferred Expenses ${today}.xlsx`)
          : exportExpenses(data.expenses.filter((x) => x.expense_date.startsWith(month)).map((e) => ({
            date: e.expense_date, particulars: e.description ?? "", category: e.category?.name ?? "", client: e.client?.name ?? "Office", amount: Number(e.amount),
            mode: e.payment_mode === "Bank" && e.bank?.bank_name ? `Bank · ${e.bank.bank_name}` : e.payment_mode,
          })), `Expenses ${today}.xlsx`);
    Promise.resolve(run).catch((e) => toast(err(e), "danger"));
  };
  return (
    <Screen
      region
      eyebrow="Finance"
      title="Expenses & Advances"
      actions={<>
        <IconBtn icon={Download} label="Export" onPress={doExport} />
        {canEdit && <IconBtn icon={Store} label="Manage vendors" onPress={() => setVendors(true)} />}
        {canEdit && <IconBtn icon={Tags} label="Categories" onPress={() => setCats(true)} />}
        {canEdit && tab !== "deferred" && <IconBtn icon={Plus} label="Add" filled onPress={() => (tab === "advances" ? setAdv("new") : tab === "fixed" ? setFixed("new") : setEdit("new"))} />}
      </>}
      sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "expenses", label: "Expenses" }, { key: "fixed", label: "Fixed", count: pending || undefined }, { key: "advances", label: "Advances" }, { key: "deferred", label: "Deferred", count: data?.deferred.length }]} />}
    >
      {error ? <Banner tone="danger" title="Couldn't load" sub={error} /> : !data ? <ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} /> : (
        <>
          {tab === "expenses" && <ExpenseList data={data} month={month} setMonth={setMonth} onEdit={setEdit} />}
          {tab === "fixed" && <Fixed data={data} month={month} setMonth={setMonth} onEdit={setFixed} />}
          {tab === "advances" && <Advances data={data} onEdit={setAdv} />}
          {tab === "deferred" && <Deferred data={data} />}
          {edit && <ExpenseSheet data={data} expense={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
          {adv && <AdvanceSheet data={data} advance={adv === "new" ? null : adv} onClose={() => setAdv(null)} />}
          {fixed && <FixedSheet data={data} template={fixed === "new" ? null : fixed} month={month} onClose={() => setFixed(null)} />}
          {vendors && <VendorsSheet data={data} onClose={() => setVendors(false)} />}
          {cats && <CategoriesSheet data={data} onClose={() => setCats(false)} />}
        </>
      )}
    </Screen>
  );
}

function ExpenseList({ data, month, setMonth, onEdit }: { data: ExpensesData; month: string; setMonth: (m: string) => void; onEdit: (x: any) => void }) {
  const { act } = useDB();
  const { can } = useAuth();
  const { regionId } = useRegion();
  const { confirm, toast } = useOverlay();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [mode, setMode] = useState("all");
  const [view, setView] = useState<any | null>(null);
  const [receipts, setReceipts] = useState<any[]>([]);
  const list = data.expenses.filter((x) => x.expense_date.startsWith(month) && inRegion(regionId, x.branch_id) && (!cat || x.category_id === cat) && (mode === "all" || x.payment_mode === mode) && (!q || `${x.description ?? ""} ${x.vendor?.name ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  const byCat = Object.entries(list.reduce<Record<string, number>>((a, x) => ((a[x.category?.name ?? "—"] = (a[x.category?.name ?? "—"] ?? 0) + Number(x.amount)), a), {})).sort((a, b) => b[1] - a[1]);
  const total = list.reduce((a, x) => a + Number(x.amount), 0);
  const months = [...new Set([month, ...data.expenses.map((x) => x.expense_date.slice(0, 7))])].sort().reverse();
  const open = async (x: any) => { setView(x); setReceipts([]); setReceipts(await loadReceipts(x.id).catch(() => [])); };
  return (
    <>
      <StatGrid items={[{ label: `Spend · ${fmtMonth(month)}`, value: pkr(total, { compact: true }), tone: "danger" }, { label: "Awaiting approval", value: String(list.filter((x) => !x.approved_at).length), tone: "warning" }]} />
      <Section title="By category">
        <Card><Bars data={byCat.slice(0, 6).map(([label, value]) => ({ label, value, sub: `${Math.round((value / Math.max(1, total)) * 100)}% of month` }))} format={(n) => pkr(n, { compact: true })} /></Card>
      </Section>
      <View style={{ gap: 8, marginTop: 16, marginBottom: 12 }}>
        <SearchBar value={q} onChange={setQ} placeholder="Description or vendor" />
        <HStack>
          <View style={{ flex: 1 }}><Select compact label="Month" value={month} onChange={setMonth} options={months.map((m) => ({ value: m, label: fmtMonth(m) }))} /></View>
          <View style={{ flex: 1 }}><Select compact clearable label="Category" value={cat} onChange={setCat} placeholder="All" options={data.categories.map((c) => ({ value: c.id, label: c.name }))} /></View>
        </HStack>
        <Chips value={mode} onChange={setMode} items={["all", "Cash", "Bank", "Cheque", "Payable"].map((m) => ({ key: m, label: m === "all" ? "Any mode" : m }))} />
      </View>
      {list.map((x) => (
        <RecordCard key={x.id} title={x.description || x.category?.name || "Expense"} subtitle={`${fmtShort(x.expense_date)}${x.vendor?.name ? ` · ${x.vendor.name}` : ""}`}
          badge={<Badge label={x.payment_mode} tone={x.payment_mode === "Payable" ? "warning" : "neutral"} small />}
          right={<T v="monoLg" style={{ fontSize: 15 }}>{pkr(Number(x.amount), { compact: true })}</T>}
          fields={[{ label: "Category", value: x.category?.name ?? "—" }, { label: "Client", value: x.client?.name ?? "Office" }, { label: "By", value: x.expense_by_emp?.full_name ?? "—" }, { label: "Status", value: x.approved_at ? "Approved · locked" : "Awaiting approval", tone: x.approved_at ? "success" : "warning" }]}
          actions={[
            { label: "View", icon: Eye, onPress: () => { void open(x); } },
            ...(can("expenses.edit") && !x.approved_at ? [{ label: "Edit", icon: Pencil, onPress: () => onEdit(x) }] : []),
            ...(can("expenses.approve") ? [{ label: x.approved_at ? "Unapprove" : "Approve", icon: x.approved_at ? Lock : CheckCircle2, tone: x.approved_at ? undefined : ("success" as const), onPress: async () => {
              if (await confirm({ title: `${x.approved_at ? "Unapprove" : "Approve"} ${pkr(Number(x.amount))}?`, message: x.approved_at ? "Unlocks it for edits. The unapproval is recorded." : `${x.category?.name ?? ""} · ${x.description ?? ""} · ${x.payment_mode}. Approval locks it against edits and deletion.`, confirmLabel: x.approved_at ? "Unapprove" : "Approve" })) {
                await act(() => setExpenseApproval(x.id, !x.approved_at), x.approved_at ? "Expense unlocked" : "Expense approved");
              }
            } }] : []),
          ]} />
      ))}
      {list.length === 0 && <Empty title="No expenses this month" />}
      <Sheet open={!!view} onClose={() => setView(null)} title="Expense details" footer={can("expenses.edit") && view && !view.approved_at ? <Button label="Delete" icon={Trash2} variant="danger" full onPress={async () => {
        if (await confirm({ title: "Delete expense?", message: "Any cash/bank movement is reversed.", confirmLabel: "Delete", tone: "danger" })) { if (await act(() => deleteExpense(view), "Expense deleted")) setView(null); }
      }} /> : undefined}>
        {view && (
          <>
            <Fields items={[
              { label: "Amount", value: pkr(Number(view.amount)), mono: true }, { label: "Date", value: fmtShort(view.expense_date) }, { label: "Category", value: view.category?.name ?? "—" },
              { label: "Nature", value: view.pl_category === "cost_of_services" ? "Cost of Services" : "Operating Expense" }, { label: "Vendor", value: view.vendor?.name ?? "—" },
              { label: "Client", value: view.client?.name ?? "Office (no client)" }, { label: "Mode", value: view.payment_mode }, { label: "Expense by", value: view.expense_by_emp?.full_name ?? "—" },
              { label: "Description", value: view.description ?? "—", full: true }, { label: "Notes", value: view.notes ?? "—", full: true },
            ]} />
            <Section title="Receipts" count={receipts.length}>
              <ListCard>{receipts.map((r, i) => <Row key={r.id} last={i === receipts.length - 1} title={r.file_name ?? "Receipt"} onPress={() => { Linking.openURL(r.drive_view_url).catch(() => toast("Could not open the file", "danger")); }} />)}</ListCard>
            </Section>
          </>
        )}
      </Sheet>
    </>
  );

}

function PayModeFields({ data, mode, set, f, modes }: { data: ExpensesData; mode: string; set: (p: any) => void; f: { bank_account_id: string; cheque_id: string; custodian: string; due_date?: string; vendor_id?: string }; modes: string[] }) {
  const { can } = useAuth();
  const banking = can("banks.view");
  return (
    <>
      <Chips value={mode} onChange={(m) => set({ payment_mode: m })} items={modes.map((m) => ({ key: m, label: m }))} />
      <View style={{ height: 10 }} />
      {mode === "Cash" && <Select label="Paid by" required value={f.custodian} onChange={(v) => set({ custodian: v })} options={data.custodians.map((c) => ({ value: c.locationId!, label: c.fullName, sub: banking ? `holds ${pkr(c.held)}` : undefined }))} />}
      {mode === "Bank" && <Select label="Bank account" required value={f.bank_account_id} onChange={(v) => set({ bank_account_id: v })} options={data.banks.filter((b) => b.active !== false).map((b) => ({ value: b.id, label: b.bank_name, sub: banking ? `${b.account_number} · ${pkr(Number(b.balance))}` : b.account_number }))} />}
      {mode === "Cheque" && <Select label="Pending cheque" required value={f.cheque_id} onChange={(v) => set({ cheque_id: v })} options={data.cheques.filter((c) => (c.direction ?? "outgoing") === "outgoing" && c.cheque_type === "payment").map((c) => ({ value: c.id, label: `#${c.cheque_number}`, sub: `left ${pkr(Number(c.amount) - (data.linked.get(c.id) ?? 0))}` }))} />}
      {mode === "Payable" && f.vendor_id !== undefined && <Select label="Vendor" required value={f.vendor_id} onChange={(v) => set({ vendor_id: v })} options={data.vendors.map((x) => ({ value: x.id, label: x.name }))} />}
      {mode === "Payable" && f.due_date !== undefined && <Input label="Due date" required value={f.due_date} onChangeText={(v) => set({ due_date: v })} placeholder="YYYY-MM-DD" />}
    </>
  );
}

function ExpenseSheet({ data, expense, onClose }: { data: ExpensesData; expense: any | null; onClose: () => void }) {
  const { db, act } = useDB();
  const { can } = useAuth();
  const { toast, confirm } = useOverlay();
  const [f, setF] = useState<ExpenseForm>(() => (expense ? expenseFormFrom(expense, data.custodians) : blankExpense(TODAY)));
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [coverage, setCoverage] = useState<"month" | "period" | "prepaid">(expense?.coverage_start ? "prepaid" : expense?.service_start ? "period" : "month");
  const set = (p: Partial<ExpenseForm>) => setF({ ...f, ...p });
  const clients = db.clients.map((c) => ({ id: c.id, branch_id: c.branch_id }));
  const save = async () => {
    const form: ExpenseForm = { ...f, coverage_start: coverage === "prepaid" ? f.coverage_start : "", coverage_end: coverage === "prepaid" ? f.coverage_end : "", service_start: coverage === "period" ? f.service_start : "", service_end: coverage === "period" ? f.service_end : "" };
    const e = expenseError(form, data, expense);
    if (e) return toast(e, "danger");
    const c = data.custodians.find((x) => x.locationId === form.custodian);
    if (!expense && form.payment_mode === "Cash" && can("banks.view") && c && Number(form.amount) > c.held) {
      if (!(await confirm({ title: "More than the custodian holds", message: `This expense (${pkr(Number(form.amount))}) exceeds ${c.fullName}'s held cash (${pkr(c.held)}). Record it anyway?`, confirmLabel: "Record" }))) return;
    }
    setBusy(true);
    const company = { id: db.company.id, name: db.company.name };
    const ok = await act(() => (expense ? amendExpense(expense, form, data, clients, replace ? files : null, company) : addExpense(form, data, clients, files, company)), expense ? "Expense saved" : "Expense added");
    setBusy(false);
    if (ok) onClose();
  };
  const addFile = async (src: "camera" | "file") => { try { const x = src === "camera" ? await takePhoto() : await pickDocument(); if (x) setFiles([...files, x]); } catch (e) { toast(err(e), "danger"); } };
  return (
    <Sheet open onClose={onClose} title={expense ? "Edit expense" : "Add expense"} full footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label="Save" full loading={busy} onPress={save} /></>}>
      <Select label="Category" required value={f.category_id} onChange={(v) => set({ category_id: v })} options={data.categories.map((c) => ({ value: c.id, label: c.name }))} />
      <Select label="Client" clearable value={f.client_id} onChange={(v) => set({ client_id: v })} placeholder="Office (no client)" options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />
      <Select label="Region" clearable value={f.branch_id} onChange={(v) => set({ branch_id: v })} placeholder="From the client, else head office" options={db.branches.map((b) => ({ value: b.id, label: b.name }))} />
      <Input label="Amount" required amount value={f.amount} onChangeText={(v) => set({ amount: v })} />
      <Input label="Date" required value={f.expense_date} onChangeText={(v) => set({ expense_date: v })} placeholder="YYYY-MM-DD" />
      <Input label="Description" value={f.description} onChangeText={(v) => set({ description: v })} />
      <PayModeFields data={data} mode={f.payment_mode} set={set} f={{ bank_account_id: f.bank_account_id, cheque_id: f.cheque_id, custodian: f.custodian, due_date: f.due_date, vendor_id: f.vendor_id }} modes={["Cash", "Bank", "Cheque", "Payable"]} />
      <Select label="Expense by" clearable value={f.expense_by} onChange={(v) => set({ expense_by: v })} options={db.employees.filter((e) => e.category === "office_staff" && e.lifecycle === "active").map((e) => ({ value: e.id, label: e.name }))} />
      <Select label="Cost lands in" value={coverage} onChange={(v) => setCoverage(v as typeof coverage)} options={[
        { value: "month", label: "The expense's own month" }, { value: "period", label: "A service period (days)" },
        ...(Number(f.amount) >= PREPAID_THRESHOLD ? [{ value: "prepaid", label: "Prepaid — spread over months" }] : []),
      ]} />
      {coverage === "period" && <HStack gap={10}><Input style={{ flex: 1 }} label="Service from" value={f.service_start} onChangeText={(v) => set({ service_start: v })} placeholder="YYYY-MM-DD" /><Input style={{ flex: 1 }} label="Service to" value={f.service_end} onChangeText={(v) => set({ service_end: v })} placeholder="YYYY-MM-DD" /></HStack>}
      {coverage === "prepaid" && <HStack gap={10}><Input style={{ flex: 1 }} label="Covers from" value={f.coverage_start} onChangeText={(v) => set({ coverage_start: v })} placeholder="YYYY-MM" /><Input style={{ flex: 1 }} label="Covers to" value={f.coverage_end} onChangeText={(v) => set({ coverage_end: v })} placeholder="YYYY-MM" /></HStack>}
      {coverage === "prepaid" && !isAmortising({ ...f }) && <T v="small" muted style={{ marginTop: -6, marginBottom: 10 }}>Prepaid applies from {pkr(PREPAID_THRESHOLD)} with both months set.</T>}
      <Input label="Notes" value={f.notes} onChangeText={(v) => set({ notes: v })} />
      {expense && <Toggle label="Replace receipts" sub={expense.receipt_file_name ? `Current: ${expense.receipt_file_name}` : "No receipt attached"} value={replace} onChange={setReplace} />}
      {(!expense || replace) && (
        <>
          {files.map((x, i) => <T key={i} v="small">• {x.name}</T>)}
          <HStack style={{ marginTop: 6 }}>
            <Button size="sm" variant="secondary" icon={Camera} label="Photo" onPress={() => addFile("camera")} />
            <Button size="sm" variant="secondary" icon={FilePlus2} label="File" onPress={() => addFile("file")} />
          </HStack>
          {expense && replace && files.length === 0 && <T v="small" muted style={{ marginTop: 6 }}>Saving with no file removes the current receipt.</T>}
        </>
      )}
    </Sheet>
  );
}

function AdvanceSheet({ data, advance, onClose }: { data: ExpensesData; advance: any | null; onClose: () => void }) {
  const { db, act } = useDB();
  const { toast } = useOverlay();
  const [f, setF] = useState<AdvanceForm>(() => advance ? {
    employee_id: advance.employee_id, amount: String(advance.amount), advance_date: advance.advance_date, payment_mode: advance.payment_mode, client_id: advance.client_id ?? "",
    bank_account_id: advance.bank_account_id ?? "", cheque_id: advance.cheque_id ?? "", notes: advance.notes ?? "", custodian: advance.custodian_location_id ?? "",
  } : { employee_id: "", amount: "", advance_date: TODAY, payment_mode: "Cash", client_id: "", bank_account_id: "", cheque_id: "", notes: "", custodian: "" });
  const [file, setFile] = useState<PickedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<AdvanceForm>) => setF({ ...f, ...p });
  const save = async () => {
    const same = advance && f.payment_mode === advance.payment_mode && (f.payment_mode === "Cash" || f.bank_account_id === advance.bank_account_id);
    const e = advanceError(f, data, same ? Number(advance.amount) : 0);
    if (e) return toast(e, "danger");
    setBusy(true);
    const company = { id: db.company.id, name: db.company.name };
    const ok = await act(() => (advance ? amendAdvance(advance.id, f, file, company) : addAdvance(f, file, company)), advance ? "Advance saved" : "Advance recorded");
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Sheet open onClose={onClose} title={advance ? "Edit advance" : "Add advance"} full footer={<Button label="Save" full loading={busy} onPress={save} />}>
      <Select label="Employee" required searchable value={f.employee_id} onChange={(v) => set({ employee_id: v, client_id: db.employees.find((x) => x.id === v)?.client_id ?? "" })} options={db.employees.filter((x) => x.lifecycle === "active").map((x) => ({ value: x.id, label: x.name, sub: x.code }))} />
      <Input label="Amount" required amount value={f.amount} onChangeText={(v) => set({ amount: v })} />
      <Input label="Date" required value={f.advance_date} onChangeText={(v) => set({ advance_date: v })} />
      <PayModeFields data={data} mode={f.payment_mode} set={set} f={{ bank_account_id: f.bank_account_id, cheque_id: f.cheque_id, custodian: f.custodian }} modes={["Cash", "Bank", "Cheque"]} />
      <Input label="Notes" value={f.notes} onChangeText={(v) => set({ notes: v })} />
      {file ? <T v="small" style={{ marginBottom: 6 }}>{file.name}</T> : advance?.attachment_file_name ? <T v="small" muted style={{ marginBottom: 6 }}>Attached: {advance.attachment_file_name}</T> : null}
      <HStack>
        <Button size="sm" variant="secondary" icon={Camera} label="Photo" onPress={() => takePhoto().then((x) => x && setFile(x)).catch(() => {})} />
        <Button size="sm" variant="secondary" icon={FilePlus2} label="File" onPress={() => pickDocument().then((x) => x && setFile(x)).catch(() => {})} />
      </HStack>
    </Sheet>
  );
}

function Fixed({ data, month, setMonth, onEdit }: { data: ExpensesData; month: string; setMonth: (m: string) => void; onEdit: (x: any) => void }) {
  const { act } = useDB();
  const { can } = useAuth();
  const { confirm } = useOverlay();
  const [decide, setDecide] = useState<{ row: any; action: "approve" | "deny" } | null>(null);
  const [note, setNote] = useState("");
  const [cust, setCust] = useState("");
  const [inst, setInst] = useState<any | null>(null);
  const [instF, setInstF] = useState({ amount: "", description: "", notes: "", due_date: "" });
  const sum = (s: string) => data.instances.filter((f) => f.status === s).reduce((a, f) => a + Number(f.amount), 0);
  return (
    <>
      <Input label="Month" value={month} onChangeText={setMonth} placeholder="YYYY-MM" />
      <StatGrid items={[{ label: "Awaiting decision", value: pkr(sum("pending"), { compact: true }), tone: "warning" }, { label: "Approved · posted", value: pkr(sum("approved"), { compact: true }), tone: "success" }, { label: "Denied", value: pkr(sum("denied"), { compact: true }) }]} />
      <Section title={`Instances · ${fmtMonth(month)}`}>
        {data.instances.map((i) => (
          <RecordCard key={i.id} title={i.description || i.category?.name || "Fixed expense"} subtitle={`${i.category?.name ?? ""}${i.vendor?.name ? ` · ${i.vendor.name}` : ""}`} badge={<Badge label={i.status} tone={i.status === "pending" ? "warning" : toneOf(i.status)} small />}
            fields={[{ label: "Amount", value: pkr(Number(i.amount)), mono: true }, { label: "Mode", value: i.payment_mode }, { label: "Client", value: i.client?.name ?? "Office" }]}
            actions={[
              ...(can("expenses.edit") && i.status === "pending" ? [{ label: "Edit", icon: Pencil, onPress: () => { setInst(i); setInstF({ amount: String(i.amount), description: i.description ?? "", notes: i.notes ?? "", due_date: i.due_date ?? "" }); } }] : []),
              ...(can("expenses.approve") && i.status === "pending" ? [
                { label: "Approve", tone: "success" as const, onPress: () => { setNote(""); setCust(data.templates.find((t) => t.id === i.fixed_expense_id)?.custodian_location_id ?? ""); setDecide({ row: i, action: "approve" }); } },
                { label: "Deny", tone: "danger" as const, onPress: () => { setNote(""); setDecide({ row: i, action: "deny" }); } },
              ] : []),
              ...(can("expenses.approve") && i.status === "denied" ? [{ label: "Reopen", icon: Undo2, onPress: () => { void act(() => reopenInstance(i.id), "Reopened"); } }] : []),
            ]} />
        ))}
        {data.instances.length === 0 && <Empty title="Nothing due this month" />}
      </Section>
      <Section title="Templates" count={data.templates.length}>
        {data.templates.map((d) => (
          <RecordCard key={d.id} title={d.description || d.category?.name || "Untitled"} subtitle={d.category?.name} badge={<Badge label={d.is_active ? "Active" : "Stopped"} tone={d.is_active ? "success" : "neutral"} small />}
            fields={[{ label: "Amount", value: pkr(Number(d.amount)), mono: true }, { label: "Mode", value: d.payment_mode }, { label: "From", value: fmtMonth(String(d.start_month).slice(0, 7)) }, { label: "Until", value: d.end_month ? fmtMonth(String(d.end_month).slice(0, 7)) : "Open" }]}
            actions={can("expenses.edit") ? [
              { label: "Edit", icon: Pencil, onPress: () => onEdit(d) },
              { label: d.is_active ? "Stop" : "Resume", icon: Power, onPress: () => { void act(() => toggleFixed(d.id, !d.is_active), d.is_active ? "Stopped" : "Resumed"); } },
              { label: "Delete", icon: Trash2, tone: "danger" as const, onPress: async () => { if (await confirm({ title: `Delete "${d.description || d.category?.name || "Untitled"}"?`, message: "Approved months lose their link back to this template; the expenses stay. Stopping it instead keeps history intact.", confirmLabel: "Delete", tone: "danger" })) await act(() => deleteFixed(d.id), "Deleted"); } },
            ] : undefined} />
        ))}
      </Section>
      <Sheet open={!!decide} onClose={() => setDecide(null)} title={decide?.action === "approve" ? "Approve — posts the expense" : "Deny this month"}
        footer={<Button label={decide?.action === "approve" ? "Approve" : "Deny"} variant={decide?.action === "deny" ? "danger" : "primary"} full onPress={async () => { if (decide && await act(() => decideInstance(decide.row, decide.action, note, cust, data), decide.action === "approve" ? "Approved and posted" : "Denied")) setDecide(null); }} />}>
        {decide?.action === "approve" && decide.row.payment_mode === "Cash" && <Select label="Paid by" required value={cust} onChange={setCust} options={data.custodians.map((c) => ({ value: c.locationId!, label: c.fullName }))} />}
        <Input label="Note" value={note} onChangeText={setNote} multiline />
      </Sheet>
      <Sheet open={!!inst} onClose={() => setInst(null)} title="Edit this month" footer={<Button label="Save" full onPress={async () => { if (inst && await act(() => saveInstance(inst, instF), "Saved")) setInst(null); }} />}>
        <Input label="Amount" amount value={instF.amount} onChangeText={(v) => setInstF({ ...instF, amount: v })} />
        <Input label="Description" value={instF.description} onChangeText={(v) => setInstF({ ...instF, description: v })} />
        {inst?.payment_mode === "Payable" && <Input label="Due date" value={instF.due_date} onChangeText={(v) => setInstF({ ...instF, due_date: v })} />}
        <Input label="Notes" value={instF.notes} onChangeText={(v) => setInstF({ ...instF, notes: v })} />
      </Sheet>
    </>
  );
}

function FixedSheet({ data, template, month, onClose }: { data: ExpensesData; template: any | null; month: string; onClose: () => void }) {
  const { db, act } = useDB();
  const [f, setF] = useState<FixedForm>(() => template ? {
    category_id: template.category_id ?? "", client_id: template.client_id ?? "", branch_id: template.branch_id ?? "", vendor_id: template.vendor_id ?? "", description: template.description ?? "",
    amount: String(template.amount), payment_mode: template.payment_mode, bank_account_id: template.bank_account_id ?? "", due_day: String(template.due_day ?? 1), notes: template.notes ?? "",
    start_month: String(template.start_month).slice(0, 7), end_month: template.end_month ? String(template.end_month).slice(0, 7) : "", is_active: !!template.is_active, custodian: template.custodian_location_id ?? "",
  } : { category_id: "", client_id: "", branch_id: "", vendor_id: "", description: "", amount: "", payment_mode: "Cash", bank_account_id: "", due_day: "1", notes: "", start_month: month, end_month: "", is_active: true, custodian: "" });
  const set = (p: Partial<FixedForm>) => setF({ ...f, ...p });
  return (
    <Sheet open onClose={onClose} title={template ? "Edit fixed expense" : "New fixed expense"} full
      footer={<Button label="Save" full onPress={async () => { if (await act(() => saveFixed(template?.id ?? null, f, data, db.clients.map((c) => ({ id: c.id, branch_id: c.branch_id }))), "Fixed expense saved")) onClose(); }} />}>
      <Select label="Category" required value={f.category_id} onChange={(v) => set({ category_id: v })} options={data.categories.map((c) => ({ value: c.id, label: c.name }))} />
      <Select label="Client" clearable value={f.client_id} onChange={(v) => set({ client_id: v })} placeholder="Office" options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />
      <Input label="Description" value={f.description} onChangeText={(v) => set({ description: v })} />
      <Input label="Amount" required amount value={f.amount} onChangeText={(v) => set({ amount: v })} />
      <Chips value={f.payment_mode} onChange={(m) => set({ payment_mode: m })} items={(["Cash", "Bank", "Payable"] as const).map((m) => ({ key: m, label: m }))} />
      <View style={{ height: 10 }} />
      {f.payment_mode === "Cash" && <Select label="Usually paid by" clearable value={f.custodian} onChange={(v) => set({ custodian: v })} options={data.custodians.map((c) => ({ value: c.locationId!, label: c.fullName }))} />}
      {f.payment_mode === "Bank" && <Select label="Bank account" required value={f.bank_account_id} onChange={(v) => set({ bank_account_id: v })} options={data.banks.map((b) => ({ value: b.id, label: b.bank_name, sub: b.account_number }))} />}
      {f.payment_mode === "Payable" && <Select label="Vendor" required value={f.vendor_id} onChange={(v) => set({ vendor_id: v })} options={data.vendors.map((x) => ({ value: x.id, label: x.name }))} />}
      {f.payment_mode === "Payable" && <Input label="Due day of month" keyboardType="numeric" value={f.due_day} onChangeText={(v) => set({ due_day: v })} />}
      <HStack gap={10}>
        <Input style={{ flex: 1 }} label="Start month" value={f.start_month} onChangeText={(v) => set({ start_month: v })} placeholder="YYYY-MM" />
        <Input style={{ flex: 1 }} label="End month" value={f.end_month} onChangeText={(v) => set({ end_month: v })} placeholder="Open" />
      </HStack>
      <Toggle label="Active" value={f.is_active} onChange={(v) => set({ is_active: v })} />
      <Input label="Notes" value={f.notes} onChangeText={(v) => set({ notes: v })} />
    </Sheet>
  );
}

function Advances({ data, onEdit }: { data: ExpensesData; onEdit: (x: any) => void }) {
  const { act } = useDB();
  const { can } = useAuth();
  const { confirm } = useOverlay();
  const [q, setQ] = useState("");
  const list = data.advances.filter((a) => !q || String(a.employee?.full_name ?? "").toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <StatGrid items={[{ label: "Advanced", value: pkr(data.advances.reduce((a, x) => a + Number(x.amount), 0), { compact: true }), tone: "danger" }, { label: "Records", value: String(data.advances.length) }]} />
      <View style={{ marginVertical: 12 }}><SearchBar value={q} onChange={setQ} placeholder="Employee" /></View>
      {list.map((a) => (
        <RecordCard key={a.id} title={a.employee?.full_name ?? "—"} subtitle={`${fmtShort(a.advance_date)}${a.notes ? ` · ${a.notes}` : ""}`} right={<T v="monoLg" style={{ fontSize: 15 }}>{pkr(Number(a.amount), { compact: true })}</T>}
          fields={[{ label: "Client", value: a.client?.name ?? "—" }, { label: "Mode", value: a.payment_mode }, { label: "Paid by", value: data.custodians.find((c) => c.locationId === a.custodian_location_id)?.fullName ?? "—" }]}
          actions={[
            ...(a.drive_view_url ? [{ label: "Screenshot", onPress: () => { Linking.openURL(a.drive_view_url).catch(() => {}); } }] : []),
            ...(can("expenses.edit") ? [
              { label: "Edit", icon: Pencil, onPress: () => onEdit(a) },
              { label: "Delete", icon: Trash2, tone: "danger" as const, onPress: async () => { if (await confirm({ title: `Delete advance of ${pkr(Number(a.amount))} to ${a.employee?.full_name ?? ""}?`, message: "The cash/bank movement is reversed.", confirmLabel: "Delete", tone: "danger" })) await act(() => deleteAdvance(a.id), "Advance deleted"); } },
            ] : []),
          ]} />
      ))}
      {list.length === 0 && <Empty title="No advances" />}
    </>
  );
}

function Deferred({ data }: { data: ExpensesData }) {
  return (
    <>
      <Banner tone="info" title="Prepaid and service-period expenses" sub="Each month's share is released by the monthly run." />
      {data.deferred.map((d) => (
        <Card key={d.expense_id} style={{ marginBottom: 10 }}>
          <T v="bodyStrong">{d.description || d.category_name || "Expense"}</T>
          <T v="small" muted>{d.shape === "prepaid" ? "Prepaid" : "Service period"} · {fmtShort(d.period_start)} – {fmtShort(d.period_end)}</T>
          <View style={{ marginVertical: 10 }}><Progress value={Number(d.months_released)} max={Math.max(1, Number(d.months_total))} tone="brand" /></View>
          <HStack><T v="small" soft style={{ flex: 1 }}>{d.months_released}/{d.months_total} months released</T><T v="mono">{pkr(Number(d.released), { compact: true })} / {pkr(Number(d.amount), { compact: true })}</T></HStack>
        </Card>
      ))}
      {data.deferred.length === 0 && <Empty title="Nothing deferred" />}
    </>
  );
}

function VendorsSheet({ data, onClose }: { data: ExpensesData; onClose: () => void }) {
  const { act } = useDB();
  const { confirm } = useOverlay();
  const [edit, setEdit] = useState<{ id: string | null; name: string; account: string }>({ id: null, name: "", account: "" });
  return (
    <Sheet open onClose={onClose} title="Manage vendors" full footer={<Button label={edit.id ? "Save vendor" : "Add vendor"} full onPress={async () => { if (await act(() => saveVendor(edit.id, edit.name, edit.account), "Vendor saved")) setEdit({ id: null, name: "", account: "" }); }} />}>
      <Input label={edit.id ? "Vendor name" : "New vendor name"} value={edit.name} onChangeText={(v) => setEdit({ ...edit, name: v })} />
      <Input label="Account number" value={edit.account} onChangeText={(v) => setEdit({ ...edit, account: v })} />
      <ListCard>
        {data.vendors.map((v, i) => (
          <Row key={v.id} last={i === data.vendors.length - 1} title={v.name} subtitle={v.account_number ?? undefined} onPress={() => setEdit({ id: v.id, name: v.name, account: v.account_number ?? "" })}
            right={<IconBtn icon={Trash2} label="Delete" onPress={async () => {
              const used = data.expenses.filter((x) => x.vendor_id === v.id).length;
              if (await confirm({ title: `Delete vendor "${v.name}"?`, message: used ? `${used} expense(s) using it will have the vendor cleared.` : undefined, confirmLabel: "Delete", tone: "danger" })) await act(() => deleteVendor(v.id), "Vendor deleted");
            }} />} />
        ))}
      </ListCard>
    </Sheet>
  );
}

function CategoriesSheet({ data, onClose }: { data: ExpensesData; onClose: () => void }) {
  const { act } = useDB();
  const { confirm } = useOverlay();
  const [edit, setEdit] = useState<{ id: string | null; name: string }>({ id: null, name: "" });
  return (
    <Sheet open onClose={onClose} title="Categories" full footer={<Button label={edit.id ? "Rename" : "Add category"} full onPress={async () => { if (await act(() => saveCategory(edit.id, edit.name), "Category saved")) setEdit({ id: null, name: "" }); }} />}>
      <Input label={edit.id ? "Category name" : "New category"} value={edit.name} onChangeText={(v) => setEdit({ ...edit, name: v })} />
      <ListCard>
        {data.categories.map((c, i) => (
          <Row key={c.id} last={i === data.categories.length - 1} title={c.name} onPress={() => setEdit({ id: c.id, name: c.name })}
            right={<IconBtn icon={Trash2} label="Delete" onPress={async () => {
              const used = data.expenses.filter((x) => x.category_id === c.id).length;
              if (await confirm({ title: `Delete category "${c.name}"?`, message: used ? `${used} expense(s) using it will have the category cleared.` : undefined, confirmLabel: "Delete", tone: "danger" })) await act(() => deleteCategory(c), "Category deleted");
            }} />} />
        ))}
      </ListCard>
    </Sheet>
  );
}
