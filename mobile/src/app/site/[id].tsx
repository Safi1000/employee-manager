// One site: what this login may do there and its guards — photo, name, code,
// shift, phone, expiry flags. Nothing else: field_site_roster returns no CNIC
// number and no pay, by design (0607).
//
// 0620 (DECIDED 30 Oct 2026): a site supervisor — "a guard with more
// responsibility" — gets attendance and the guard list only. Visits, incidents
// and SOS, the daily report, tasks and warnings are office staff's, each by its
// own key; field_me's `can` says which, and the server refuses the rest anyway.
// Tapping a guard opens his card: a photo can be taken if he has none (0614 —
// replacing one is the office's), and, for office staff with the warnings key,
// his warnings (0617 — the phone never sees or sets a fine).
import { useLocalSearchParams, useRouter } from "expo-router";
import { AlertTriangle, Camera, ClipboardCheck, ClipboardList, FileText, ListChecks, Phone, Siren, Users, X } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Image, Linking, Modal, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chips, NotesBox, ScreenHeader } from "../../components/field";
import { T } from "../../components/Text";
import { Avatar, Badge, Banner, Button, Card, Empty, SearchBar } from "../../components/ui";
import { Ability, Guard, useField, Warnings } from "../../lib/field";
import { useLang } from "../../lib/i18n";
import { position, takePhoto } from "../../lib/media";
import { useTheme } from "../../theme/ThemeProvider";

export default function SiteHub() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { roster, call, me } = useField();
  const [rows, setRows] = useState<Guard[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<Guard | null>(null);
  const [sos, setSos] = useState<"idle" | "sending" | "sent">("idle");

  const load = useCallback(async () => {
    try { const got = await roster(id); setErr(null); setRows(got); }
    catch (e) { setErr((e as Error).message); setRows((r) => r ?? []); }
  }, [id, roster]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? []).filter((g) => !s || `${g.full_name} ${g.employee_code ?? ""}`.toLowerCase().includes(s));
  }, [rows, q]);
  const flagged = (rows ?? []).filter((g) => (g.flags ?? []).length > 0).length;
  const go = (pathname: "/attendance/[id]" | "/visit/[id]" | "/incident/[id]" | "/daily/[id]" | "/tasks/[id]") =>
    router.push({ pathname, params: { id, name: name ?? "" } });

  const sendSos = () => {
    Alert.alert(tr("Send SOS?"), tr("The office is alerted at once with your position. Use it only when you need help now."), [
      { text: tr("Cancel"), style: "cancel" },
      { text: tr("Send SOS"), style: "destructive", onPress: async () => {
        setSos("sending");
        try { await call("field_sos", { p_site_id: id, p_note: null, p_geo: await position() }); setSos("sent"); }
        catch (e) { setSos("idle"); setErr((e as Error).message); }
      } },
    ]);
  };

  const can = (a: Ability) => (me?.can ?? []).includes(a);
  const actions: { label: string; icon: typeof ClipboardCheck; to: Parameters<typeof go>[0] }[] = [
    ...(can("attendance") || can("attendance_view") ? [{ label: tr("Today's attendance"), icon: ClipboardCheck, to: "/attendance/[id]" as const }] : []),
    ...(can("visit") ? [{ label: tr("Site visit"), icon: ListChecks, to: "/visit/[id]" as const }] : []),
    ...(can("incidents") ? [{ label: tr("Report incident"), icon: AlertTriangle, to: "/incident/[id]" as const }] : []),
    ...(can("daily_report") ? [{ label: tr("Daily report"), icon: FileText, to: "/daily/[id]" as const }] : []),
    ...(can("tasks") ? [{ label: tr("Tasks"), icon: ClipboardList, to: "/tasks/[id]" as const }] : []),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <FlatList
        data={shown}
        keyExtractor={(g) => g.employee_id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: insets.bottom + 24, gap: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListHeaderComponent={
          <View style={{ gap: 10, marginBottom: 4 }}>
            <ScreenHeader title={name || tr("Site")}
              sub={rows ? [tr(rows.length === 1 ? "{n} guard" : "{n} guards", { n: rows.length }), flagged ? tr("{n} with a document to renew", { n: flagged }) : null].filter(Boolean).join(" · ") : null} />
            {err ? <Banner tone="danger" title={tr(err)} /> : null}
            {sos === "sent" ? <Banner tone="danger" title={tr("SOS sent")} sub={tr("The office has been alerted. Call them if you can.")} /> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {actions.map((a) => (
                <Card key={a.to} onPress={() => go(a.to)} style={{ width: "48.5%", flexDirection: "row", alignItems: "center", gap: 10, padding: 14 }}>
                  <a.icon size={20} color={t.brand[600]} />
                  <T v="bodyStrong" style={{ flex: 1 }} numberOfLines={2}>{a.label}</T>
                </Card>
              ))}
              {can("incidents") ? <Pressable onPress={sendSos} disabled={sos === "sending"} accessibilityLabel={tr("Send SOS")}
                style={({ pressed }) => ({ width: "48.5%", flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 16,
                  backgroundColor: t.tone("danger").solid, opacity: pressed || sos === "sending" ? 0.8 : 1 })}>
                <Siren size={20} color="#fff" />
                <T v="bodyStrong" color="#fff">{sos === "sending" ? tr("Sending…") : "SOS"}</T>
              </Pressable> : null}
            </View>
            <T v="eyebrow" muted style={{ marginTop: 6 }}>{tr("Guards")}</T>
            <SearchBar value={q} onChange={setQ} placeholder={tr("Name or code")} />
          </View>
        }
        ListEmptyComponent={rows === null ? null : <Empty icon={Users} title={tr(q ? "No match" : "No guards posted here")} />}
        renderItem={({ item: g }) => (
          <Card onPress={() => setOpen(g)} style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <GuardAvatar siteId={id} guard={g} />
              <View style={{ flex: 1 }}>
                <T v="bodyStrong">{g.full_name}</T>
                <T v="mono" muted>{g.employee_code ?? "—"}{g.shift ? ` · ${tr(g.shift)}` : ""}</T>
              </View>
              {g.phone ? (
                <Pressable onPress={() => void Linking.openURL(`tel:${g.phone}`)} hitSlop={8} accessibilityLabel={tr("Call {name}", { name: g.full_name })}
                  style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: t.tone("success").tint, alignItems: "center", justifyContent: "center" }}>
                  <Phone size={18} color={t.tone("success").text} />
                </Pressable>
              ) : null}
            </View>
            {(g.flags ?? []).length ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {(g.flags ?? []).map((f) => <Badge key={f} label={tr(f)} tone="danger" />)}
              </View>
            ) : null}
          </Card>
        )}
      />
      {open ? <GuardCard siteId={id} guard={open} canWarn={can("warnings")} canPhoto={can("guard_photo")} onClose={() => setOpen(null)} onPhotoSet={() => { setOpen(null); void load(); }} /> : null}
    </View>
  );
}

/** Initials, or the guard's photo once fetched. */
function GuardAvatar({ siteId, guard }: { siteId: string; guard: Guard }) {
  const { photo } = useField();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    if (!guard.has_photo) return;
    let live = true;
    void photo(siteId, guard.employee_id).then((v) => { if (live) setUri(v); });
    return () => { live = false; };
  }, [siteId, guard.employee_id, guard.has_photo, photo]);
  return <Avatar name={guard.full_name} uri={uri} />;
}

/** One guard: big photo (or take one), his warnings, raise a warning. */
function GuardCard({ siteId, guard, onClose, onPhotoSet, canWarn, canPhoto }: {
  siteId: string; guard: Guard; onClose: () => void; onPhotoSet: () => void; canWarn: boolean; canPhoto: boolean;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { photo, call, forgetPhoto } = useField();
  const [uri, setUri] = useState<string | null>(null);
  const [w, setW] = useState<Warnings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"soft" | "formal" | null>(null);
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const loadWarnings = useCallback(async () => {
    try { setW(await call<Warnings>("field_guard_warnings", { p_site_id: siteId, p_employee_id: guard.employee_id })); }
    catch (e) { setErr((e as Error).message); }
  }, [call, siteId, guard.employee_id]);
  useEffect(() => {
    let live = true;
    if (guard.has_photo) void photo(siteId, guard.employee_id).then((v) => { if (live) setUri(v); });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on open; state is set only after the request returns
    if (canWarn) void loadWarnings();
    return () => { live = false; };
  }, [siteId, guard.employee_id, guard.has_photo, photo, loadWarnings, canWarn]);

  const snap = async () => {
    setErr(null);
    try {
      const p = await takePhoto(600);
      if (!p) return;
      setBusy(true);
      await call("field_set_guard_photo", { p_site_id: siteId, p_employee_id: guard.employee_id, p_data: p });
      forgetPhoto(guard.employee_id);
      onPhotoSet();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const raise = async () => {
    if (!kind) return;
    setBusy(true); setErr(null); setSaved(null);
    try {
      await call("field_raise_warning", { p_site_id: siteId, p_employee_id: guard.employee_id, p_kind: kind, p_reason: reason });
      setSaved(kind === "soft" ? tr("Soft warning recorded.") : tr("Formal warning sent to the office for approval."));
      setKind(null); setReason("");
      await loadWarnings();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const statusTone = (s: string) => (s === "approved" ? "danger" : s === "pending" ? "warning" : "neutral") as "danger" | "warning" | "neutral";
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <T v="title">{guard.full_name}</T>
            <T v="mono" muted>{guard.employee_code ?? "—"}{guard.shift ? ` · ${tr(guard.shift)}` : ""}</T>
          </View>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel={tr("Close")}><X size={22} color={t.fg} /></Pressable>
        </View>
        {err ? <Banner tone="danger" title={tr(err)} /> : null}
        {uri ? (
          <Image source={{ uri }} resizeMode="cover" style={{ width: "100%", aspectRatio: 1, borderRadius: 16 }} />
        ) : guard.has_photo || !canPhoto ? null : (
          <Card style={{ alignItems: "center", gap: 10 }}>
            <T v="small" muted center>{tr("No photo in Bastion yet. Take one facing the guard, in good light.")}</T>
            <Button label={tr("Take his photo")} icon={Camera} variant="secondary" onPress={() => void snap()} loading={busy} />
          </Card>
        )}
        {(guard.flags ?? []).length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{(guard.flags ?? []).map((f) => <Badge key={f} label={tr(f)} tone="danger" />)}</View>
        ) : null}

        {canWarn ? <T v="eyebrow" muted style={{ marginTop: 6 }}>{tr("Warnings")}</T> : null}
        {w ? (
          <T v="small" soft>{tr("{n} of 3 formal warnings in the last 12 months", { n: w.formal_in_12_months })}</T>
        ) : null}
        {w?.warnings.length ? w.warnings.map((x) => (
          <Card key={x.id} style={{ gap: 4, opacity: x.rescinded || x.status === "refused" ? 0.6 : 1 }}>
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <Badge label={x.kind === "soft" ? tr("Soft") : x.warning_number ? tr("Formal #{n}", { n: x.warning_number }) : tr("Formal")} tone={x.kind === "soft" ? "neutral" : "danger"} />
              {x.kind === "formal" ? <Badge label={tr(x.status === "pending" ? "Waiting for the office" : x.status === "refused" ? "Refused" : "Approved")} tone={statusTone(x.status)} /> : null}
              {x.rescinded ? <Badge label={tr("Rescinded")} /> : null}
              <T v="small" muted>{new Date(`${x.issued_on}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}</T>
            </View>
            <T v="body">{x.reason}</T>
            {x.raised_by_name ? <T v="small" muted>{tr("By {name}", { name: x.raised_by_name })}</T> : null}
          </Card>
        )) : w ? <T v="small" muted>{tr("No warnings.")}</T> : null}

        {canWarn ? (
          <Card style={{ gap: 10 }}>
            <T v="bodyStrong">{tr("Raise a warning")}</T>
            {saved ? <Banner tone="success" title={saved} /> : null}
            <Chips value={kind} onChange={(v) => { setKind(v); setSaved(null); }} options={[
              { value: "soft", label: tr("Soft"), tone: "warning" }, { value: "formal", label: tr("Formal"), tone: "danger" }]} />
            {kind ? (
              <>
                <T v="small" muted>{kind === "soft"
                  ? tr("Kept in his history. No fine, and it does not count towards the three.")
                  : tr("Goes to the office to approve. The office decides any fine. Three formal warnings in 12 months lead to termination.")}</T>
                <NotesBox label={tr("Why")} value={reason} onChange={setReason} placeholder={tr("What happened, when")} />
                <Button label={tr(kind === "soft" ? "Record soft warning" : "Send formal warning")} onPress={() => void raise()} loading={busy} disabled={!reason.trim()} />
              </>
            ) : null}
          </Card>
        ) : null}
      </ScrollView>
    </Modal>
  );
}
