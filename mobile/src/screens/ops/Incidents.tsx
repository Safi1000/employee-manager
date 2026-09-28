import { Camera, FilePlus2, Paperclip, Pencil, Plus, ShieldAlert, Trash2, X } from "lucide-react-native";
import React, { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Button, Card, Chips, Empty, HStack, IconBtn, Input, RecordCard, SearchBar, Section, Tabs, Toggle, toneOf } from "../../components/ui";
import { addComplaint, COMPLAINT_CHANNELS, COMPLAINT_STATUS, deleteIncident, saveIncident, setComplaintStatus } from "../../data/api/ops";
import type { PickedFile } from "../../data/api/core";
import { pickDocument, takePhoto } from "../../lib/files";
import { Incident, TODAY } from "../../data/seed";
import { clientName, useDB } from "../../data/store";
import { useAuth } from "../../lib/auth";
import { fmtShort, fmtTime } from "../../lib/format";
import { inRegion, useRegion } from "../../lib/region";
import { useTheme } from "../../theme/ThemeProvider";
import { radius } from "../../theme/tokens";

const SEV = ["low", "medium", "high", "critical"] as const;
const STATUS = ["open", "under_investigation", "resolved", "closed"] as const;
const label = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const sevTone = (s: string) => (s === "critical" || s === "high" ? "danger" : s === "medium" ? "warning" : "neutral");

export default function Incidents() {
  const [tab, setTab] = useState<"incidents" | "complaints">("incidents");
  const { can } = useAuth();
  const [edit, setEdit] = useState<Incident | "new" | null>(null);
  return (
    <Screen
      region
      eyebrow="Operations"
      title="Incidents"
      actions={can("incidents.edit") && tab === "incidents" ? <IconBtn icon={Plus} label="Log incident" filled onPress={() => setEdit("new")} /> : undefined}
      sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "incidents", label: "Incidents" }, { key: "complaints", label: "Client complaints" }]} />}
    >
      {tab === "incidents" ? <IncidentList onEdit={setEdit} /> : <Complaints />}
      <IncidentForm key={edit === "new" ? "new" : edit?.id ?? "none"} incident={edit} onClose={() => setEdit(null)} />
    </Screen>
  );
}

function IncidentList({ onEdit }: { onEdit: (i: Incident) => void }) {
  const { db, act } = useDB();
  const { can } = useAuth();
  const { regionId } = useRegion();
  const { toast, confirm } = useOverlay();
  const [q, setQ] = useState("");
  const [sev, setSev] = useState("all");
  const [status, setStatus] = useState("all");
  const [client, setClient] = useState("");
  const [cat, setCat] = useState("");
  const [sort, setSort] = useState<"when" | "status" | "category">("when");

  const list = db.incidents
    .filter((i) => inRegion(regionId, db.clients.find((c) => c.id === i.client_id)?.branch_id) && (sev === "all" || i.severity === sev) && (status === "all" || i.status === status) && (!client || i.client_id === client) && (!cat || i.category === cat) &&
      (!q || (i.code + i.description).toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => sort === "when" ? b.occurred_at.localeCompare(a.occurred_at) : sort === "status" ? a.status.localeCompare(b.status) : a.category.localeCompare(b.category));

  return (
    <>
      <SearchBar value={q} onChange={setQ} placeholder="Code or description" />
      <View style={{ gap: 8, marginTop: 10, marginBottom: 12 }}>
        <Chips value={sev} onChange={setSev} items={[{ key: "all", label: "Any severity" }, ...SEV.map((s) => ({ key: s, label: label(s), count: db.incidents.filter((i) => i.severity === s).length }))]} />
        <Chips value={status} onChange={setStatus} items={[{ key: "all", label: "Any status" }, ...STATUS.map((s) => ({ key: s, label: label(s) }))]} />
        <HStack>
          <View style={{ flex: 1 }}><Select compact clearable label="Client" value={client} onChange={setClient} placeholder="All" options={db.clients.map((c) => ({ value: c.id, label: c.name }))} /></View>
          <View style={{ flex: 1 }}><Select compact clearable label="Category" value={cat} onChange={setCat} placeholder="All" options={db.incidentCategories.map((c) => ({ value: c, label: label(c) }))} /></View>
        </HStack>
        <Chips value={sort} onChange={setSort} items={[{ key: "when", label: "Newest" }, { key: "status", label: "By status" }, { key: "category", label: "By category" }]} />
      </View>
      {list.map((i) => (
        <RecordCard
          key={i.id}
          accent={i.severity === "critical" ? "danger" : undefined}
          title={i.description}
          subtitle={`${i.code} · ${fmtShort(i.occurred_at.slice(0, 10))} ${fmtTime(i.occurred_at)}`}
          badge={<Badge label={label(i.severity)} tone={sevTone(i.severity)} solid={i.severity === "critical"} />}
          fields={[
            { label: "Client / post", value: `${clientName(db, i.client_id)}${i.site_id ? ` · ${db.posts.find((p) => p.id === i.site_id)?.name ?? "—"}` : ""}`, full: true },
            { label: "Category", value: label(i.category) },
            { label: "Status", value: <Badge label={label(i.status)} tone={toneOf(i.status)} small /> },
          ]}
          tags={i.guards.length ? <HStack wrap gap={6}>{i.guards.map((g) => <Badge key={g} small label={db.employees.find((e) => e.id === g)?.name ?? g} tone="neutral" />)}</HStack> : undefined}
          actions={[
            ...(i.raw?.drive_view_url ? [{ label: "Attachment", icon: Paperclip, onPress: () => { Linking.openURL(i.raw.drive_view_url).catch(() => toast("Could not open the file", "danger")); } }] : []),
            ...(can("incidents.edit") ? [
              { label: "Edit", icon: Pencil, onPress: () => onEdit(i) },
              { label: "Delete", icon: Trash2, tone: "danger" as const, onPress: async () => { if (await confirm({ title: `Delete ${i.code}?`, message: "This also removes its guard links.", confirmLabel: "Delete", tone: "danger" })) await act(() => deleteIncident(i), "Incident deleted"); } },
            ] : []),
          ]}
        />
      ))}
      {list.length === 0 && <Empty icon={ShieldAlert} title="No incidents match" />}
    </>
  );
}

function IncidentForm({ incident, onClose }: { incident: Incident | "new" | null; onClose: () => void }) {
  const t = useTheme();
  const { db, act } = useDB();
  const { toast } = useOverlay();
  const isNew = incident === "new";
  const blank: Incident = { id: "", code: "", occurred_at: `${TODAY}T${new Date().toTimeString().slice(0, 5)}:00`, client_id: "", site_id: "", severity: "medium", category: "other", description: "", response: "", guards: [], status: "open" };
  const [f, setF] = useState<Incident>(() => (incident && incident !== "new" ? { ...incident, occurred_at: localStamp(incident.occurred_at), guards: [...incident.guards] } : blank));
  const [notified, setNotified] = useState<boolean>(incident && incident !== "new" ? !!incident.raw?.client_notified : false);
  const [notifiedAt, setNotifiedAt] = useState<string>(incident && incident !== "new" ? incident.raw?.client_notified_at ?? "" : "");
  const [file, setFile] = useState<PickedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [gq, setGq] = useState("");
  // Only guards who belong to the selected client (web item 11).
  const candidates = db.employees.filter((e) => e.lifecycle === "active" && !!f.client_id && e.client_id === f.client_id && !f.guards.includes(e.id) && (!gq || e.name.toLowerCase().includes(gq.toLowerCase()))).slice(0, 6);
  return (
    <Sheet open={!!incident} onClose={onClose} title={isNew ? "Log incident" : `Edit ${f.code}`} full
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label={isNew ? "Log" : "Save"} full loading={busy} disabled={!f.client_id} onPress={async () => {
        setBusy(true);
        const ok = await act(() => saveIncident(isNew ? null : (incident as Incident), {
          occurred_at: f.occurred_at, client_id: f.client_id, post_id: f.site_id, severity: f.severity, category: f.category, description: f.description,
          client_notified: notified, client_notified_at: notifiedAt, action_taken: f.response, status: f.status, guard_ids: f.guards,
        }, file, { id: db.company.id, name: db.company.name }), isNew ? "Incident logged" : "Incident saved");
        setBusy(false);
        if (ok) onClose();
      }} /></>}>
      <Input label="Occurred at" value={f.occurred_at.slice(0, 16).replace("T", " ")} onChangeText={(v) => setF({ ...f, occurred_at: v.replace(" ", "T") + ":00" })} placeholder="YYYY-MM-DD HH:MM" />
      <Select label="Client" required value={f.client_id} onChange={(v) => setF({ ...f, client_id: v, site_id: "" })} options={db.clients.filter((c) => c.status === "active").map((c) => ({ value: c.id, label: c.name }))} />
      {f.client_id ? <Select label="Post" clearable value={f.site_id} onChange={(v) => setF({ ...f, site_id: v })} options={db.posts.filter((p) => p.client_id === f.client_id).map((p) => ({ value: p.id, label: p.name }))} /> : null}
      <T v="smallStrong" soft style={{ marginBottom: 6 }}>Severity</T>
      <View style={{ flexDirection: "row", gap: 6, marginBottom: 14 }}>
        {SEV.map((s) => {
          const on = f.severity === s;
          const tn = t.tone(sevTone(s));
          return (
            <Pressable key={s} onPress={() => setF({ ...f, severity: s })} style={{ flex: 1, height: 42, borderRadius: radius.md, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: on ? tn.strong : t.border, backgroundColor: on ? tn.tint : "transparent" }}>
              <T v="smallStrong" color={on ? tn.text : t.fgSoft}>{label(s)}</T>
            </Pressable>
          );
        })}
      </View>
      <Select label="Category" value={f.category} onChange={(v) => setF({ ...f, category: v })} options={db.incidentCategories.map((c) => ({ value: c, label: label(c) }))} />
      <Input label="What happened" required multiline value={f.description} onChangeText={(v) => setF({ ...f, description: v })} />
      <Input label="Action taken" multiline value={f.response} onChangeText={(v) => setF({ ...f, response: v })} />
      <Toggle label="Client notified" value={notified} onChange={setNotified} />
      {notified && <Input label="Notified on" value={notifiedAt} onChangeText={setNotifiedAt} placeholder="YYYY-MM-DD" />}
      <T v="smallStrong" soft style={{ marginBottom: 6 }}>Guards involved</T>
      <HStack wrap gap={6} style={{ marginBottom: 8 }}>
        {f.guards.map((g) => (
          <Pressable key={g} onPress={() => setF({ ...f, guards: f.guards.filter((x) => x !== g) })} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, height: 30, borderRadius: radius.pill, backgroundColor: t.tone("brand").tint }}>
            <T v="smallStrong" color={t.tone("brand").text}>{db.employees.find((e) => e.id === g)?.name}</T>
            <X size={13} color={t.tone("brand").text} />
          </Pressable>
        ))}
      </HStack>
      <SearchBar value={gq} onChange={setGq} placeholder="Search guards…" />
      <Card pad={0} style={{ marginTop: 6, marginBottom: 14 }}>
        {candidates.map((e) => (
          <Pressable key={e.id} onPress={() => setF({ ...f, guards: [...f.guards, e.id] })} style={{ padding: 12, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Plus size={14} color={t.mutedFg} />
            <T v="small" style={{ fontSize: 14, flex: 1 }}>{e.name}</T>
            <T v="mono" muted style={{ fontSize: 11 }}>{e.code}</T>
          </Pressable>
        ))}
      </Card>
      <Select label="Status" value={f.status} onChange={(v) => setF({ ...f, status: v as Incident["status"] })} options={STATUS.map((s) => ({ value: s, label: label(s) }))} />
      <T v="smallStrong" soft style={{ marginBottom: 6 }}>Attachment{!isNew && (incident as Incident)?.raw?.attachment_file_name ? ` (current: ${(incident as Incident).raw.attachment_file_name})` : ""}</T>
      {file ? <T v="small" style={{ marginBottom: 8 }}>{file.name} — replaces any current file on save</T> : null}
      <HStack>
        <Button label="Photo" icon={Camera} variant="secondary" full onPress={() => takePhoto().then((x) => x && setFile(x)).catch((e) => toast(String(e?.message ?? e), "danger"))} />
        <Button label="File" icon={FilePlus2} variant="secondary" full onPress={() => pickDocument().then((x) => x && setFile(x)).catch((e) => toast(String(e?.message ?? e), "danger"))} />
      </HStack>
    </Sheet>
  );
}

function Complaints() {
  const { db, act } = useDB();
  const { can } = useAuth();
  const [client, setClient] = useState("");
  const [channel, setChannel] = useState<string>("phone");
  const [desc, setDesc] = useState("");
  return (
    <>
      {can("incidents.edit") && (
        <Card style={{ marginBottom: 6 }}>
          <T v="h3" style={{ marginBottom: 10 }}>New complaint</T>
          <Select label="Client" value={client} onChange={setClient} options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />
          <Select label="Channel" value={channel} onChange={setChannel} options={COMPLAINT_CHANNELS.map((c) => ({ value: c, label: label(c) }))} />
          <Input label="Description" multiline value={desc} onChangeText={setDesc} />
          <Button label="Add complaint" disabled={!client || !desc.trim()} onPress={async () => { if (await act(() => addComplaint(db.company.id, client, channel, desc), "Complaint recorded")) { setDesc(""); setClient(""); } }} />
        </Card>
      )}
      <Section title="Complaints" count={db.complaints.length}>
        {db.complaints.map((c) => (
          <RecordCard key={c.id} title={c.description} subtitle={clientName(db, c.client_id)} badge={<Badge label={label(c.status)} tone={toneOf(c.status)} small />}
            fields={[{ label: "Raised", value: fmtShort(c.raised) }, { label: "Channel", value: label(c.channel ?? "—") }]}
            actions={can("incidents.edit") ? COMPLAINT_STATUS.filter((s) => s !== c.status).map((s) => ({ label: label(s), onPress: () => { void act(() => setComplaintStatus(c.id, s), `Marked ${label(s)}`); } })) : undefined} />
        ))}
      </Section>
    </>
  );
}

/** An ISO timestamp as the local "YYYY-MM-DDTHH:MM:00" the form edits (the web's datetime-local). */
function localStamp(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
