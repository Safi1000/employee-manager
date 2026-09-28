import { useLocalSearchParams, useRouter } from "expo-router";
import { Building2, FileText, Pencil, Plus, Trash2 } from "lucide-react-native";
import React, { useState } from "react";
import { Linking, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Button, Card, Chips, Empty, Fields, HStack, IconBtn, Input, ListCard, RecordCard, Row, SearchBar, Section, Tabs, toneOf } from "../../components/ui";
import { Client, contractValue } from "../../data/seed";
import { invoiceReceived, useDB } from "../../data/store";
import { clientErrors, clientFormFrom, ClientForm as ClientFormState, deleteClient, saveClient } from "../../data/api/clients";
import { PAKISTAN_INDUSTRIES, type RemitAccount, type TaxLine } from "../../lib/web/supabase";
import { useAuth } from "../../lib/auth";
import { fmtMonth, fmtShort, pkr } from "../../lib/format";
import { inRegion, useRegion } from "../../lib/region";

export default function Clients() {
  const router = useRouter();
  const { db } = useDB();
  const { can } = useAuth();
  const { regionId } = useRegion();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [industry, setIndustry] = useState("");
  const [branch, setBranch] = useState("");
  const [edit, setEdit] = useState<Client | "new" | null>(null);

  const list = db.clients.filter((c) =>
    inRegion(regionId, c.branch_id) && (status === "all" || c.status === status) && (!industry || c.industry === industry) && (!branch || c.branch_id === branch) &&
    (!q || (c.name + c.code).toLowerCase().includes(q.toLowerCase())));
  const industries = [...new Set(db.clients.map((c) => c.industry))];

  return (
    <Screen
      region
      eyebrow="Clients & Contracts"
      title="Clients"
      actions={can("clients.edit") ? <IconBtn icon={Plus} label="Add client" filled onPress={() => setEdit("new")} /> : undefined}
      sticky={<SearchBar value={q} onChange={setQ} placeholder="Name or code" />}
    >
      <Chips value={status} onChange={setStatus} items={[{ key: "all", label: "All" }, { key: "active", label: "Active" }, { key: "inactive", label: "Inactive" }]} />
      <HStack style={{ marginTop: 8, marginBottom: 14 }}>
        <View style={{ flex: 1 }}><Select compact clearable label="Industry" value={industry} onChange={setIndustry} placeholder="Any" options={industries.map((i) => ({ value: i, label: i }))} /></View>
        <View style={{ flex: 1 }}><Select compact clearable label="Branch" value={branch} onChange={setBranch} placeholder="Any" options={db.branches.map((b) => ({ value: b.id, label: b.name }))} /></View>
      </HStack>
      {list.map((c) => (
        <RecordCard
          key={c.id}
          title={c.name}
          subtitle={c.code}
          badge={<Badge label={c.status === "active" ? "Active" : "Inactive"} tone={c.status === "active" ? "success" : "neutral"} />}
          onPress={() => router.push(`/clients/${c.id}`)}
          fields={[
            { label: "Industry", value: c.industry },
            { label: "Branch", value: db.branches.find((b) => b.id === c.branch_id)?.name ?? "—" },
            { label: "Employees", value: String(db.employees.filter((e) => e.client_id === c.id && e.lifecycle === "active").length) },
            { label: "Contracts", value: String(db.contracts.filter((k) => k.client_id === c.id).length) },
          ]}
          actions={can("clients.edit") ? [{ label: "Edit", icon: Pencil, onPress: () => setEdit(c) }] : undefined}
        />
      ))}
      {list.length === 0 && <Empty icon={Building2} title="No clients match" />}
      <ClientForm key={edit === "new" ? "new" : edit?.id ?? "none"} client={edit} onClose={() => setEdit(null)} />
    </Screen>
  );
}

export function ClientDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { db } = useDB();
  const { can, canAny } = useAuth();
  const [tab, setTab] = useState<"overview" | "contracts" | "invoices" | "documents">("overview");
  const [edit, setEdit] = useState<Client | null>(null);
  const c = db.clients.find((x) => x.id === id);
  if (!c) return <Screen title="Client"><Empty title="Client not found" /></Screen>;
  const ks = db.contracts.filter((k) => k.client_id === c.id);
  const inv = db.invoices.filter((i) => i.client_id === c.id);

  return (
    <Screen
      eyebrow={c.code}
      title={c.name}
      actions={can("clients.edit") ? <IconBtn icon={Pencil} label="Edit" onPress={() => setEdit(c)} /> : undefined}
      sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "overview", label: "Overview" }, { key: "contracts", label: "Contracts", count: ks.length }, ...(canAny(["invoices.view", "invoices.edit"]) ? [{ key: "invoices" as const, label: "Invoices", count: inv.length }] : []), { key: "documents", label: "Documents" }]} />}
    >
      {tab === "overview" && (
        <>
          <Card><Fields items={[
            { label: "Status", value: <Badge label={c.status} small /> }, { label: "Industry", value: c.industry },
            { label: "Branch", value: db.branches.find((b) => b.id === c.branch_id)?.name ?? "—" }, { label: "Invoice group", value: c.invoice_group === "FIXED" ? "Fixed" : "Variable" },
            { label: "Billing email", value: c.billing_email, full: true }, { label: "Phone", value: c.phone, mono: true }, { label: "Signatory", value: c.signatory },
          ]} /></Card>
          <Section title="Tax profile">
            <Card>
              <Fields items={[{ label: "NTN", value: c.ntn, mono: true }, { label: "STRN", value: c.strn, mono: true }, { label: "Filer status", value: c.filer === "filer" ? "Filer" : "Non-filer" }]} />
              <View style={{ marginTop: 12, gap: 6 }}>
                {c.tax_lines.map((tl) => <HStack key={tl.name}><T v="small" soft style={{ flex: 1 }}>{tl.name}</T><Badge label={tl.direction === "ADDED" ? "Added" : "Withheld"} small tone={tl.direction === "ADDED" ? "info" : "warning"} /><T v="mono">{tl.rate}%</T></HStack>)}
              </View>
            </Card>
          </Section>
          <Section title="Billing address"><Card><T v="body">{c.address}</T></Card></Section>
          <Section title="Bank details"><Card><Fields items={[{ label: "Account title", value: c.bank.title, full: true }, { label: "Account / IBAN", value: c.bank.account, mono: true, full: true }, { label: "Bank", value: c.bank.bank }]} /></Card></Section>
          {c.notes ? <Section title="Notes"><Card><T v="body" soft>{c.notes}</T></Card></Section> : null}
        </>
      )}
      {tab === "contracts" && ks.map((k) => (
        <RecordCard key={k.id} title={k.code} subtitle={k.type === "services" ? "Services" : "Guard deployment"} badge={<Badge label={k.status} tone={toneOf(k.status)} />} onPress={() => router.push(`/contracts/${k.id}`)}
          fields={[{ label: "Period", value: `${fmtShort(k.start)} – ${fmtShort(k.end)}`, full: true }, { label: "Guards", value: String(k.lines.reduce((a, l) => a + l.committed, 0)) }, { label: "Rate / month", value: pkr(contractValue(k), { compact: true }), mono: true }]} />
      ))}
      {tab === "invoices" && (
        <ListCard>
          {inv.map((i, n) => <Row key={i.id} last={n === inv.length - 1} title={i.number} subtitle={fmtMonth(i.month)} right={<View style={{ alignItems: "flex-end", gap: 3 }}><T v="mono">{pkr(i.amount, { compact: true })}</T><T v="mono" muted style={{ fontSize: 11 }}>recv {pkr(invoiceReceived(i), { compact: true })}</T></View>} onPress={() => router.push(`/invoices/${i.id}`)} />)}
        </ListCard>
      )}
      {tab === "documents" && (
        <ListCard>
          {ks.map((k, i) => <Row key={k.id} last={i === ks.length - 1} left={<FileText size={16} />} title={k.raw?.contract_file_name ?? k.code} subtitle={k.document ? "Signed contract — tap to open" : "Not uploaded — upload from the contract"}
            onPress={() => k.raw?.drive_view_url ? Linking.openURL(k.raw.drive_view_url).catch(() => {}) : router.push(`/contracts/${k.id}`)} />)}
        </ListCard>
      )}
      <ClientForm key={edit?.id ?? "none"} client={edit} onClose={() => setEdit(null)} />
    </Screen>
  );
}

function ClientForm({ client, onClose }: { client: Client | "new" | null; onClose: () => void }) {
  const { db, act } = useDB();
  const { toast, confirm } = useOverlay();
  const isNew = client === "new";
  const existing = client && client !== "new" ? client : null;
  const [f, setF] = useState<ClientFormState>(() => clientFormFrom(existing?.raw ?? null));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ClientFormState>(k: K, v: ClientFormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const setTax = (i: number, patch: Partial<TaxLine>) => set("tax_profile", f.tax_profile.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const setRemit = (i: number, patch: Partial<RemitAccount>) => set("remit_accounts", f.remit_accounts.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const assigned = existing ? db.employees.filter((e) => e.client_id === existing.id && e.lifecycle === "active").length : 0;

  const save = async () => {
    const e = clientErrors(f, db.clients, existing?.id ?? null);
    setErrs(e);
    if (Object.keys(e).length) return toast("Please fix the highlighted fields before saving.", "danger");
    setBusy(true);
    const ok = await act(() => saveClient(existing?.id ?? null, f), isNew ? "Client added" : "Client saved");
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet open={!!client} onClose={onClose} title={isNew ? "Add client" : "Edit client"} full
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label="Save" full loading={busy} disabled={!f.name.trim()} onPress={save} /></>}>
      <T v="eyebrow" muted style={{ marginBottom: 10 }}>Identity</T>
      <Input label="Name" required value={f.name} onChangeText={(v) => set("name", v)} error={errs.name} />
      <HStack gap={10}>
        <Input style={{ flex: 1 }} label="Employee ID prefix" required value={f.employee_id_prefix} autoCapitalize="characters" onChangeText={(v) => set("employee_id_prefix", v)} error={errs.employee_id_prefix} />
        <View style={{ flex: 1 }}><Select label="Industry" required searchable value={f.industry} onChange={(v) => set("industry", v)} options={PAKISTAN_INDUSTRIES.map((x) => ({ value: x, label: x }))} /></View>
      </HStack>
      {errs.industry ? <T v="small" color="#bb5238" style={{ marginTop: -8, marginBottom: 10 }}>{errs.industry}</T> : null}
      <Select label="Region" value={f.branch_id} onChange={(v) => set("branch_id", v)} options={db.branches.map((b) => ({ value: b.id, label: b.name }))} />
      <HStack gap={10}>
        <View style={{ flex: 1 }}><Select label="Billing type" value={f.billing_type} onChange={(v) => set("billing_type", v)} options={[{ value: "STANDARD", label: "Standard" }, { value: "SLA", label: "SLA" }]} /></View>
        <View style={{ flex: 1 }}><Select label="Invoice group" value={f.invoice_group} onChange={(v) => set("invoice_group", v)} options={[{ value: "FIXED", label: "Fixed" }, { value: "VARIABLE", label: "Variable" }, { value: "SLA", label: "SLA" }]} /></View>
      </HStack>

      <T v="eyebrow" muted style={{ marginVertical: 10 }}>Contacts</T>
      <Input label="Billing email" value={f.email} keyboardType="email-address" autoCapitalize="none" onChangeText={(v) => set("email", v)} error={errs.email} />
      <Input label="Phone" value={f.phone} keyboardType="phone-pad" onChangeText={(v) => set("phone", v)} error={errs.phone} />
      <Input label="Authorised signatory" value={f.authorised_signatory} onChangeText={(v) => set("authorised_signatory", v)} error={errs.authorised_signatory} />
      <Input label="Signatory CNIC" value={f.signatory_cnic} onChangeText={(v) => set("signatory_cnic", v)} error={errs.signatory_cnic} placeholder="35202-1234567-1" />
      <Input label="Billing address" multiline value={f.billing_address} onChangeText={(v) => set("billing_address", v)} error={errs.billing_address} />

      <T v="eyebrow" muted style={{ marginVertical: 10 }}>Tax</T>
      <HStack gap={10}>
        <Input style={{ flex: 1 }} label="NTN" value={f.ntn} onChangeText={(v) => set("ntn", v)} error={errs.ntn} />
        <Input style={{ flex: 1 }} label="STRN" value={f.strn} onChangeText={(v) => set("strn", v)} error={errs.strn} />
      </HStack>
      <Select label="Filer status" clearable value={f.filer_status} onChange={(v) => set("filer_status", v)} options={[{ value: "filer", label: "Filer" }, { value: "non_filer", label: "Non-filer" }]} />
      {f.tax_profile.map((t, i) => (
        <Card key={i} style={{ marginBottom: 8 }}>
          <Input label="Tax name" value={t.name} onChangeText={(v) => setTax(i, { name: v })} />
          <HStack gap={10}>
            <Input style={{ flex: 1 }} label="Rate %" keyboardType="decimal-pad" value={String(t.rate)} onChangeText={(v) => setTax(i, { rate: v as unknown as number })} />
            <View style={{ flex: 1.3 }}><Select label="Direction" value={t.direction} onChange={(v) => setTax(i, { direction: v as TaxLine["direction"] })} options={[{ value: "ADDED", label: "Added" }, { value: "WITHHELD", label: "Withheld" }]} /></View>
          </HStack>
          <Select label="Applies to" value={t.base} onChange={(v) => setTax(i, { base: v as TaxLine["base"] })} options={[{ value: "WHOLE_INVOICE", label: "Whole invoice" }, { value: "SPECIFIC_COMPONENT", label: "Specific component" }, { value: "COMPOUND", label: "Compound" }]} />
          <Button size="sm" variant="ghost" label="Remove tax line" onPress={() => set("tax_profile", f.tax_profile.filter((_, j) => j !== i))} />
        </Card>
      ))}
      <Button label="Add tax line" icon={Plus} variant="secondary" size="sm" onPress={() => set("tax_profile", [...f.tax_profile, { name: "", rate: 0, base: "WHOLE_INVOICE", direction: "ADDED" }])} />

      <T v="eyebrow" muted style={{ marginVertical: 10 }}>Remit to (printed on invoices)</T>
      {f.remit_accounts.map((r, i) => (
        <Card key={i} style={{ marginBottom: 8 }}>
          <Input label="Account title" value={r.account_title} onChangeText={(v) => setRemit(i, { account_title: v })} />
          <Input label="Account / IBAN" value={r.account_number} autoCapitalize="characters" onChangeText={(v) => setRemit(i, { account_number: v })} error={errs[`remit-${i}`]} />
          <Input label="Bank" value={r.bank_name} onChangeText={(v) => setRemit(i, { bank_name: v })} />
          <HStack>
            <Button size="sm" variant={r.is_default ? "success" : "secondary"} label={r.is_default ? "Default" : "Make default"} onPress={() => set("remit_accounts", f.remit_accounts.map((x, j) => ({ ...x, is_default: j === i })))} />
            <Button size="sm" variant="ghost" label="Remove" onPress={() => set("remit_accounts", f.remit_accounts.filter((_, j) => j !== i))} />
          </HStack>
        </Card>
      ))}
      <Button label="Add account" icon={Plus} variant="secondary" size="sm" onPress={() => set("remit_accounts", [...f.remit_accounts, { account_title: "", account_number: "", bank_name: "", is_default: f.remit_accounts.length === 0 }])} />

      <T v="eyebrow" muted style={{ marginVertical: 10 }}>Relationship</T>
      <Select label="Rating" clearable value={f.relationship_rating} onChange={(v) => set("relationship_rating", v)} options={["1", "2", "3", "4", "5"].map((x) => ({ value: x, label: `${x} / 5` }))} />
      <Input label="Notes" multiline value={f.relationship_notes} onChangeText={(v) => set("relationship_notes", v)} />

      {existing && (
        <Button label="Delete client" icon={Trash2} variant="ghost" style={{ marginTop: 12 }} onPress={async () => {
          if (assigned > 0) return toast(`Cannot delete ${existing.name}: ${assigned} active employee(s) are assigned. Reassign them first.`, "danger");
          if (await confirm({ title: `Delete client "${existing.name}"?`, message: "This cannot be undone.", confirmLabel: "Delete", tone: "danger" })) {
            if (await act(() => deleteClient(existing.id, existing.name, assigned), "Client deleted")) onClose();
          }
        }} />
      )}
    </Sheet>
  );
}
