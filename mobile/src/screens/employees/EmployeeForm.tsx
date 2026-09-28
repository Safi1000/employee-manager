import { useLocalSearchParams, useRouter } from "expo-router";
import { Camera, ChevronDown, ChevronUp, FilePlus2 } from "lucide-react-native";
import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, HStack, Input, Toggle, tap } from "../../components/ui";
import { clientName, useDB } from "../../data/store";
import {
  addEmployee, EMPLOYEE_DOC_TYPES, EmployeeFields, setSalary, today, unverifyIdentity, updateEmployee, uploadEmployeeDoc, verifyIdentity,
} from "../../data/api/employees";
import { daysInCurrentMonth } from "../../data/api/core";
import { useAuth } from "../../lib/auth";
import { pickDocument, takePhoto } from "../../lib/files";
import { isPkWallet, PK_BANKS, pkBankCode, validateBankAccountLength, validateCnic, validateFreeText, validateIban, validatePhone, validateWalletAccount } from "../../lib/web/validation";
import { useTheme } from "../../theme/ThemeProvider";

const blank = (s: string | null | undefined) => !String(s ?? "").trim();

/**
 * Add / Edit / Hire, one collapsible form (web EmployeeManagement handleAdd /
 * handleEdit). What stops a save is a MALFORMED value, never a missing one — the
 * web lets a record be born incomplete and wear the Incomplete badge. Posting is
 * not set here (Assignments & Pay issues it), and salary on an existing record
 * changes only through the dated set_employee_salary.
 */
export default function EmployeeForm() {
  const router = useRouter();
  const { id, hire } = useLocalSearchParams<{ id?: string; hire?: string }>();
  const { db, act } = useDB();
  const { can, canAny } = useAuth();
  const { toast } = useOverlay();
  const existing = db.employees.find((e) => e.id === id);
  const r = existing?.raw ?? {};
  const [f, setF] = useState<EmployeeFields>(() => ({
    full_name: r.full_name ?? "", father_or_husband_name: r.father_or_husband_name ?? "", cnic_number: r.cnic_number ?? "",
    cnic_expiry: r.cnic_expiry ?? "", date_of_birth: r.date_of_birth ?? "", phone: r.phone ?? "", current_address: r.current_address ?? "",
    blood_group: r.blood_group ?? "", education: r.education ?? "", category: (r.category === "office_staff" || r.category === "reliever") ? r.category : "client",
    department: r.department ?? "", shift: r.shift ?? "day", branch_id: r.branch_id ?? db.branches[0]?.id ?? "", join_date: r.join_date ?? "",
    physical_copy_present: !!r.physical_copy_present, bank_name: r.bank_name ?? "", account_title: r.account_title ?? "", bank_account: r.bank_account ?? "",
    bank_branch_code: r.bank_branch_code ?? "", iban: r.iban ?? "", emergency_contact_name: r.emergency_contact_name ?? "",
    emergency_contact_phone: r.emergency_contact_phone ?? "", is_ex_serviceman: !!r.is_ex_serviceman,
    police_verification_status: r.police_verification_status ?? "pending", nadra_verisys_status: r.nadra_verisys_status ?? "pending",
  }));
  const [base, setBase] = useState("");
  const [allowance, setAllowance] = useState("");
  const [salEff, setSalEff] = useState(today());
  const [salReason, setSalReason] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ basic: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [unverify, setUnverify] = useState(false);
  const [unverifyReason, setUnverifyReason] = useState("");
  const [docType, setDocType] = useState<string>("CNIC");
  const set = <K extends keyof EmployeeFields>(k: K, v: EmployeeFields[K]) => setF((x) => ({ ...x, [k]: v }));
  const canPay = canAny(["assignments.accounts", "employees.edit"]);
  const wallet = isPkWallet(f.bank_name);

  // computeEmployeeErrors(form, intakeOnly, requireFilled = false): format only.
  const validate = () => {
    const err: Record<string, string | null> = {
      full_name: blank(f.full_name) ? "Full Name is required." : validateFreeText(f.full_name),
      phone: validatePhone(f.phone),
      cnic_number: validateCnic(f.cnic_number),
      father_or_husband_name: validateFreeText(f.father_or_husband_name),
      iban: wallet ? null : validateIban(f.iban, pkBankCode(f.bank_name)),
      bank_account: blank(f.bank_account) ? null : wallet ? validateWalletAccount(f.bank_account, f.bank_name) : validateBankAccountLength(f.bank_name, f.bank_account, false),
      emergency_contact_phone: validatePhone(f.emergency_contact_phone),
      current_address: validateFreeText(f.current_address),
    };
    // CNIC is unique across employees (digits compared), enforced on ADD only.
    const digits = f.cnic_number.replace(/\D/g, "");
    if (!existing && digits) {
      const dup = db.employees.find((e) => (e.raw?.cnic_number ?? e.cnic).replace(/\D/g, "") === digits);
      if (dup) err.cnic_number = dup.lifecycle !== "active"
        ? `This CNIC already belongs to ${dup.name} (${dup.permanent_code}), who was separated. Use Rehire instead of adding a duplicate.`
        : `This CNIC is already registered to ${dup.name} (${dup.permanent_code}). Duplicate CNICs are not allowed.`;
    }
    const out = Object.fromEntries(Object.entries(err).filter(([, v]) => v)) as Record<string, string>;
    setErrors(out);
    return out;
  };

  const save = async () => {
    const err = validate();
    if (Object.keys(err).length) {
      const first = Object.keys(err)[0]!;
      setOpen((o) => ({ ...o, [["iban", "bank_account"].includes(first) ? "bank" : first === "emergency_contact_phone" ? "emergency" : "basic"]: true }));
      toast(`${Object.keys(err).length} field${Object.keys(err).length > 1 ? "s" : ""} need attention`, "danger");
      return;
    }
    setBusy(true);
    const ok = await act(async () => {
      if (existing) await updateEmployee(existing, f, !!hire);
      // handleAdd writes the opening salary on the insert itself.
      else await addEmployee(f, base, allowance);
    }, existing ? (hire ? `${f.full_name} hired` : "Employee saved") : "Employee added");
    setBusy(false);
    if (ok) router.back();
  };

  const applySalary = async () => {
    if (!existing) return;
    setBusy(true);
    const ok = await act(() => setSalary(existing, Number(base), Number(allowance) || 0, salEff, salReason), "Salary change recorded");
    setBusy(false);
    if (ok) { setBase(""); setAllowance(""); setSalReason(""); }
  };

  const upload = async (source: "camera" | "file") => {
    if (!existing) return;
    try {
      const file = source === "camera" ? await takePhoto() : await pickDocument();
      if (!file) return;
      setBusy(true);
      await act(() => uploadEmployeeDoc(existing, { id: db.company.id, name: db.company.name }, docType, file), `${docType} uploaded`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      eyebrow={existing ? existing.code : "New record"}
      title={hire ? "Hire — complete record" : existing ? "Edit employee" : "Add employee"}
      footer={<><Button label="Cancel" variant="secondary" full onPress={() => router.back()} /><Button label={hire ? "Hire" : "Save"} full loading={busy} onPress={save} /></>}
    >
      <FormSection id="basic" title="Basic information" open={open} setOpen={setOpen} error={!!(errors.full_name || errors.cnic_number || errors.phone || errors.father_or_husband_name || errors.current_address)}>
        <Input label="Full name" required value={f.full_name} onChangeText={(v) => set("full_name", v)} error={errors.full_name} />
        <Input label="Father / husband name" value={f.father_or_husband_name} onChangeText={(v) => set("father_or_husband_name", v)} error={errors.father_or_husband_name} />
        <Input label="CNIC" value={f.cnic_number} onChangeText={(v) => set("cnic_number", v)} placeholder="35202-1234567-1" keyboardType="numbers-and-punctuation" error={errors.cnic_number} editable={!existing?.verified} />
        {existing?.verified ? <T v="small" muted style={{ marginTop: -8, marginBottom: 12 }}>Identity is verified — name, father’s name and CNIC are locked. Amend on the web with a reason.</T> : null}
        <HStack gap={10}>
          <Input style={{ flex: 1 }} label="CNIC expiry" value={f.cnic_expiry} onChangeText={(v) => set("cnic_expiry", v)} placeholder="YYYY-MM-DD" />
          <Input style={{ flex: 1 }} label="Date of birth" value={f.date_of_birth} onChangeText={(v) => set("date_of_birth", v)} placeholder="YYYY-MM-DD" />
        </HStack>
        <Input label="Mobile" value={f.phone} onChangeText={(v) => set("phone", v)} keyboardType="phone-pad" error={errors.phone} />
        <Input label="Current address" value={f.current_address} onChangeText={(v) => set("current_address", v)} multiline error={errors.current_address} />
        <HStack gap={10}>
          <View style={{ flex: 1 }}><Select label="Blood group" value={f.blood_group} onChange={(v) => set("blood_group", v)} options={["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"].map((x) => ({ value: x, label: x }))} /></View>
          <View style={{ flex: 1 }}><Select label="Education" value={f.education} onChange={(v) => set("education", v)} options={["Primary", "Middle", "Matric", "Intermediate", "Graduate"].map((x) => ({ value: x, label: x }))} /></View>
        </HStack>
      </FormSection>

      <FormSection id="posting" title="Role & region" open={open} setOpen={setOpen}>
        {existing ? (
          <T v="small" muted style={{ marginBottom: 12 }}>Posted at {clientName(db, existing.client_id)}. Moves go through Change client / Transfer so the posting stays dated.</T>
        ) : (
          <Select label="Category" value={f.category} onChange={(v) => set("category", v as EmployeeFields["category"])} options={[{ value: "client", label: "Client post" }, { value: "office_staff", label: "Office staff" }, { value: "reliever", label: "Reliever" }]} />
        )}
        <Input label="Department / designation" value={f.department} onChangeText={(v) => set("department", v)} />
        <HStack gap={10}>
          {!existing && <View style={{ flex: 1 }}><Select label="Shift" value={f.shift} onChange={(v) => set("shift", v)} options={[{ value: "day", label: "Day" }, { value: "night", label: "Night" }, { value: "evening", label: "Evening" }]} /></View>}
          <View style={{ flex: 1 }}><Select label="Region" value={f.branch_id} onChange={(v) => set("branch_id", v)} options={db.branches.map((b) => ({ value: b.id, label: b.name }))} /></View>
        </HStack>
        <Input label="Joining date" value={f.join_date} onChangeText={(v) => set("join_date", v)} placeholder="YYYY-MM-DD" />
        <Toggle label="Physical copy on file" value={f.physical_copy_present} onChange={(v) => set("physical_copy_present", v)} />
      </FormSection>

      {canPay && (
        <FormSection id="pay" title={existing ? "Salary change" : "Opening salary"} open={open} setOpen={setOpen}>
          {existing && <T v="small" muted style={{ marginBottom: 12 }}>Current: base PKR {Math.round(existing.base).toLocaleString("en-US")}, allowance PKR {Math.round(existing.allowance).toLocaleString("en-US")}. A change is dated and kept in salary history.</T>}
          <Input label={existing ? "New base salary" : "Base salary"} amount value={base} onChangeText={setBase} />
          <Input label="Allowance" amount value={allowance} onChangeText={setAllowance} />
          {base ? <T v="small" muted style={{ marginTop: -8, marginBottom: 12 }}>Per day: PKR {(Number(base) / daysInCurrentMonth()).toFixed(2)}</T> : null}
          {existing && (
            <>
              <Input label="Effective date" value={salEff} onChangeText={setSalEff} placeholder="YYYY-MM-DD" />
              <Input label="Reason" value={salReason} onChangeText={setSalReason} placeholder="Increment" />
              <Button label="Record salary change" variant="secondary" loading={busy} disabled={!base} onPress={applySalary} />
            </>
          )}
        </FormSection>
      )}

      <FormSection id="bank" title="Bank details" open={open} setOpen={setOpen} error={!!(errors.iban || errors.bank_account)}>
        <Select label="Bank / wallet" searchable value={f.bank_name} onChange={(v) => set("bank_name", v)} options={PK_BANKS.map((b) => ({ value: b.name, label: b.name }))} />
        <Input label="Account title" value={f.account_title} onChangeText={(v) => set("account_title", v)} />
        <Input label={wallet ? "Wallet number (03XXXXXXXXX)" : "Account number"} value={f.bank_account} onChangeText={(v) => set("bank_account", v)} error={errors.bank_account} keyboardType={wallet ? "phone-pad" : "default"} />
        {!wallet && <Input label="Branch code" value={f.bank_branch_code} onChangeText={(v) => set("bank_branch_code", v)} />}
        {!wallet && <Input label="IBAN" value={f.iban} onChangeText={(v) => set("iban", v)} autoCapitalize="characters" error={errors.iban} />}
      </FormSection>

      <FormSection id="emergency" title="Emergency contact" open={open} setOpen={setOpen} error={!!errors.emergency_contact_phone}>
        <Input label="Name" value={f.emergency_contact_name} onChangeText={(v) => set("emergency_contact_name", v)} />
        <Input label="Phone" value={f.emergency_contact_phone} onChangeText={(v) => set("emergency_contact_phone", v)} keyboardType="phone-pad" error={errors.emergency_contact_phone} />
      </FormSection>

      <FormSection id="service" title="Ex-service & vetting" open={open} setOpen={setOpen}>
        <Toggle label="Ex-serviceman" sub="Armed forces background" value={f.is_ex_serviceman} onChange={(v) => set("is_ex_serviceman", v)} />
        <Select label="Police verification" value={f.police_verification_status} onChange={(v) => set("police_verification_status", v)} options={["pending", "cleared", "adverse"].map((x) => ({ value: x, label: x[0]!.toUpperCase() + x.slice(1) }))} />
        <Select label="NADRA Verisys" value={f.nadra_verisys_status} onChange={(v) => set("nadra_verisys_status", v)} options={["pending", "cleared", "adverse"].map((x) => ({ value: x, label: x[0]!.toUpperCase() + x.slice(1) }))} />
      </FormSection>

      {existing && can("employees.edit") && (
        <FormSection id="identity" title="Identity verification" open={open} setOpen={setOpen}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Badge label={existing.verified ? "Verified" : "Not verified"} tone={existing.verified ? "success" : "warning"} dot />
            {existing.verified
              ? <Button size="sm" variant="secondary" label="Unverify" onPress={() => setUnverify(true)} />
              : <Button size="sm" variant="success" label="Verify identity" loading={busy} onPress={async () => { setBusy(true); await act(() => verifyIdentity(existing.id), "Identity verified"); setBusy(false); }} />}
          </View>
          <T v="small" muted style={{ marginTop: 10 }}>Verifying locks name, father’s name and CNIC. Amendments afterwards need a reason and are logged.</T>
        </FormSection>
      )}

      {existing ? (
        <FormSection id="docs" title="Documents" open={open} setOpen={setOpen}>
          <Select label="Document type" value={docType} onChange={setDocType} options={EMPLOYEE_DOC_TYPES.map((d) => ({ value: d, label: d }))} />
          <T v="small" muted style={{ marginTop: -8, marginBottom: 12 }}>{docType === "Other" ? "Added alongside existing files." : `Replaces the current ${docType} file.`}</T>
          <HStack>
            <Button label="Take photo" icon={Camera} variant="secondary" full loading={busy} onPress={() => upload("camera")} />
            <Button label="Add file" icon={FilePlus2} variant="secondary" full loading={busy} onPress={() => upload("file")} />
          </HStack>
        </FormSection>
      ) : (
        <Banner tone="info" title="Documents" sub="Save the record first, then add CNIC and police verification from Edit." />
      )}

      <Sheet open={unverify} onClose={() => setUnverify(false)} title="Unverify identity"
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setUnverify(false)} /><Button label="Unverify" variant="danger" full disabled={!unverifyReason.trim()} onPress={async () => {
          if (existing && await act(() => unverifyIdentity(existing.id, unverifyReason), "Identity unverified")) { setUnverify(false); setUnverifyReason(""); }
        }} /></>}>
        <Input label="Reason" required value={unverifyReason} onChangeText={setUnverifyReason} multiline />
      </Sheet>
    </Screen>
  );
}

function FormSection({ id, title, open, setOpen, children, error }: { id: string; title: string; open: Record<string, boolean>; setOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; children: React.ReactNode; error?: boolean }) {
  const t = useTheme();
  const isOpen = !!open[id];
  return (
    <Card pad={0} style={{ marginBottom: 10, borderColor: error ? t.tone("danger").line : t.border }}>
      <Pressable onPress={() => { tap(); setOpen((o) => ({ ...o, [id]: !isOpen })); }} style={{ flexDirection: "row", alignItems: "center", padding: 16, gap: 8 }}>
        <T v="h3" style={{ flex: 1 }}>{title}</T>
        {error && <Badge label="Check" tone="danger" small />}
        {isOpen ? <ChevronUp size={18} color={t.mutedFg} /> : <ChevronDown size={18} color={t.mutedFg} />}
      </Pressable>
      {isOpen && <View style={{ paddingHorizontal: 16, paddingBottom: 6, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 14 }}>{children}</View>}
    </Card>
  );
}
