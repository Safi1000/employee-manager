// One employee's file (0624): what Bastion has, what is missing, and what is
// already waiting for HR. Changing a detail here PROPOSES it — HR applies it on
// the web. A scanned document is filed as received for HR to check. Never the
// CNIC number, pay or bank.
import { useLocalSearchParams } from "expo-router";
import { Camera, Check, FileText, Send } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chips, ScreenHeader } from "../../components/field";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card } from "../../components/ui";
import { useField } from "../../lib/field";
import { useLang } from "../../lib/i18n";
import { takePhoto } from "../../lib/media";
import { useTheme } from "../../theme/ThemeProvider";
import { fonts, radius } from "../../theme/tokens";

type CardData = {
  id: string; full_name: string; employee_code: string | null; designation: string | null; site: string | null; join_date: string | null;
  police_verification: string | null; fields: Record<string, string | null>;
  documents: { doc_type: string; received: boolean; verified: boolean }[];
  waiting: { changes: number; documents: string[] };
};
const FIELDS: { key: string; label: string; date?: boolean }[] = [
  { key: "phone", label: "Phone" }, { key: "secondary_phone", label: "Second phone" }, { key: "home_contact_number", label: "Home phone" },
  { key: "current_address", label: "Current address" }, { key: "permanent_address", label: "Permanent address" },
  { key: "father_or_husband_name", label: "Father / husband" }, { key: "date_of_birth", label: "Date of birth", date: true }, { key: "blood_group", label: "Blood group" },
  { key: "emergency_contact_name", label: "Emergency contact" }, { key: "emergency_contact_relation", label: "Relation" }, { key: "emergency_contact_phone", label: "Emergency phone" },
  { key: "cnic_expiry", label: "CNIC expiry", date: true },
  { key: "guard_service_licence_number", label: "Guard licence no." }, { key: "guard_service_licence_expiry", label: "Guard licence expiry", date: true },
  { key: "weapon_licence_number", label: "Weapon licence no." }, { key: "weapon_licence_expiry", label: "Weapon licence expiry", date: true },
  { key: "medical_fitness_expiry", label: "Medical expiry", date: true },
];
const DOCS: { value: string; label: string }[] = [
  { value: "id_copies", label: "CNIC copy" }, { value: "police_verification", label: "Police certificate" }, { value: "medical_certificate", label: "Medical" },
  { value: "photographs", label: "Photographs" }, { value: "education_certificate", label: "Education" }, { value: "discharge_certificate", label: "Discharge certificate" },
  { value: "utility_bill", label: "Utility bill" }, { value: "halaf_nama", label: "Halaf nama" }, { value: "pension_book", label: "Pension book" },
  { value: "biometrics", label: "Biometrics" },
];

export default function EmployeeFile() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { tr, lang } = useLang();
  const { call } = useField();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const [c, setC] = useState<CardData | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [docType, setDocType] = useState<string | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setC(await call<CardData>("field_employee_card", { p_employee_id: id })); setErr(null); } catch (e) { setErr((e as Error).message); }
  }, [call, id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  const changed = useMemo(() => Object.fromEntries(Object.entries(edits).filter(([k, v]) => v.trim() && v.trim() !== (c?.fields[k] ?? ""))), [edits, c]);
  const propose = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try { await call("field_propose_employee_change", { p_employee_id: id, p_changes: changed, p_note: null }); setEdits({}); setMsg(tr("Sent to HR. The file changes once HR applies it.")); await load(); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const addPage = async () => {
    setErr(null);
    try { const p = await takePhoto(1400, true); if (p) setPages((x) => [...x, p]); } catch (e) { setErr((e as Error).message); }
  };
  const upload = async () => {
    if (!docType) return;
    setBusy(true); setErr(null); setMsg(null);
    try { await call("field_upload_document", { p_employee_id: id, p_doc_type: docType, p_photos: pages }); setPages([]); setDocType(null); setMsg(tr("Document filed. HR checks it on the web.")); await load(); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const docLabel = (v: string) => tr(DOCS.find((d) => d.value === v)?.label ?? v.replace(/_/g, " "));
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 12 }}>
      <ScreenHeader title={c?.full_name ?? name ?? tr("Employee")} sub={c ? [c.employee_code, c.designation, c.site].filter(Boolean).join(" · ") : null} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      {msg ? <Banner tone="success" title={msg} /> : null}
      {c && (c.waiting.changes > 0 || c.waiting.documents.length > 0) ? (
        <Banner tone="info" title={tr("Waiting for HR")} sub={[c.waiting.changes ? tr("{n} set of details", { n: c.waiting.changes }) : null,
          ...c.waiting.documents.map(docLabel)].filter(Boolean).join(" · ")} />
      ) : null}

      {c ? (
        <Card style={{ gap: 10 }}>
          <T v="eyebrow" muted>{tr("Details — change or fill, then send to HR")}</T>
          {FIELDS.map((f) => {
            const cur = c.fields[f.key];
            return (
              <View key={f.key} style={{ gap: 4 }}>
                <T v="small" soft>{tr(f.label)}{cur ? "" : ` · ${tr("missing")}`}</T>
                <TextInput value={edits[f.key] ?? cur ?? ""} onChangeText={(v) => setEdits((e) => ({ ...e, [f.key]: v }))}
                  placeholder={f.date ? "YYYY-MM-DD" : ""} placeholderTextColor={t.mutedFg}
                  keyboardType={f.key.includes("phone") || f.key.includes("number") ? "phone-pad" : "default"}
                  style={{ minHeight: 44, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: t.input, borderWidth: 1,
                    borderColor: changed[f.key] ? t.brand[500] : cur ? t.border : t.tone("warning").line, color: t.fg, fontFamily: fonts.body, fontSize: 15,
                    writingDirection: lang === "ur" ? "rtl" : "ltr" }} />
              </View>
            );
          })}
          <Button label={tr("Send {n} change(s) to HR", { n: Object.keys(changed).length })} icon={Send} onPress={() => void propose()} loading={busy} disabled={Object.keys(changed).length === 0} />
        </Card>
      ) : null}

      {c ? (
        <Card style={{ gap: 10 }}>
          <T v="eyebrow" muted>{tr("Documents")}</T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {c.documents.map((d) => (
              <Badge key={d.doc_type} label={`${d.received ? "✓" : "✗"} ${docLabel(d.doc_type)}`} tone={d.verified ? "success" : d.received ? "warning" : "danger"} />
            ))}
          </View>
          <T v="smallStrong" soft>{tr("Scan a document")}</T>
          <Chips value={docType} onChange={setDocType} options={DOCS} />
          {docType ? (
            <>
              <Button label={pages.length ? tr("{n} page(s) — add another", { n: pages.length }) : tr("Scan first page")} icon={Camera} variant="secondary" onPress={() => void addPage()} />
              <T v="small" muted>{tr("Lay the document flat in good light; crop to its edges when the camera asks.")}</T>
              <Button label={tr("File document for HR")} icon={FileText} onPress={() => void upload()} loading={busy} disabled={pages.length === 0} />
            </>
          ) : null}
        </Card>
      ) : null}
      {c?.police_verification ? <T v="small" muted><Check size={12} color={t.mutedFg} /> {tr("Police verification: {s}", { s: c.police_verification.replace(/_/g, " ") })}</T> : null}
    </ScrollView>
  );
}
