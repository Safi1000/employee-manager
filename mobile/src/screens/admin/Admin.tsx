// Admin screens, ported from the web: Access & Governance (UserManagement +
// Governance), Audit Log, Settings, Plan & Billing, and the platform owner's
// Companies / Company detail.
import { useLocalSearchParams, useRouter } from "expo-router";
import { Check, ChevronDown, ChevronUp, Eye, KeyRound, Pencil, Plus, Power, Trash2, UserPlus, Wallet } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, View } from "react-native";
import { Progress } from "../../components/Charts";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Avatar, Badge, Banner, Button, Card, Checkbox, Chips, Empty, HStack, IconBtn, Input, Ledger, ListCard, RecordCard, Row, SearchBar, Section, Tabs, Toggle, tap } from "../../components/ui";
import { useDB } from "../../data/store";
import { todayIso } from "../../data/api/core";
import {
  addBranch, addCompany, addSubscriptionPayment, applyDeptDefaults, ASSIGNABLE_ROLES, AUDIT_PAGE_SIZE, BranchRow, createUser, decideApproval, deleteBranch, deleteUser,
  DEPARTMENTS, hoExclusionPreview, inviteCompanyAdmin, loadAudit, loadAuditProfiles, loadCompanies, loadCompanyDetail, loadGovernance, loadMyDisplay, loadSettings,
  loadSubscriptionPayments, loadUsers, ProfileRow, renameBranch, resetPassword, saveHiddenWidgets, saveHoExclusion, saveMyDisplay, saveNotificationSettings, saveUser,
  sendTestEmail, setCompanyActive, setCompanyTheme, setDepartment, setRmd, setViewAsCompany, UserForm, USER_ROLE_LABEL,
} from "../../data/api/admin";
import { AUDITED_TABLES, DASHBOARD_WIDGET_KEYS, DASHBOARD_WIDGET_LABELS, PERMISSION_GROUPS } from "../../lib/web/supabase";
import { buyAiTopup, changePlan, fetchBillingSummary, guardCapState, openBillingPortal, type BillingSummary } from "../../lib/web/billing";
import { AI_TOPUP_PACKS, computePricing, money, normaliseGuards, PRICING } from "../../lib/web/pricing";
import { useAuth } from "../../lib/auth";
import { pickImageDataUrl } from "../../lib/files";
import { fmtDate, fmtShort } from "../../lib/format";
import { useTheme, useThemeCtx } from "../../theme/ThemeProvider";
import { brandPalettes, radius } from "../../theme/tokens";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Load-and-reload for a screen section. */
function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => { try { setData(await fn()); setError(null); } catch (e) { setError(err(e)); } }, [fn]);
  useEffect(() => { const h = setTimeout(() => { void reload(); }, 0); return () => clearTimeout(h); }, [reload]);
  return { data, error, reload };
}

// ────────────────────────────────────────────────────── Access & Governance
export function AccessGovernance() {
  const { tab: initial } = useLocalSearchParams<{ tab?: "users" | "governance" }>();
  const [tab, setTab] = useState<"users" | "governance">(initial ?? "users");
  return (
    <Screen eyebrow="Admin" title="Access & Governance" sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "users", label: "Users & permissions" }, { key: "governance", label: "Governance" }]} />}>
      {tab === "users" ? <Users /> : <Governance />}
    </Screen>
  );
}

const blankForm = (): UserForm => ({ email: "", password: "", fullName: "", title: "", branchId: "", role: "hr", perms: new Set(), userType: "office_staff", employeeId: "", partnerScope: new Set() });

function Users() {
  const { profile } = useAuth();
  const { db } = useDB();
  const { toast, confirm } = useOverlay();
  const isSSA = profile?.role === "super_super_admin";
  const { data, error, reload } = useLoad(loadUsers);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<ProfileRow | "new" | null>(null);
  const [reset, setReset] = useState<ProfileRow | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const branchName = (id: string | null) => data?.branches.find((b) => b.id === id)?.name ?? "All regions";
  const list = (data?.users ?? []).filter((u) => u.role !== "super_super_admin").filter((u) => {
    const s = q.trim().toLowerCase();
    return !s || [u.full_name, u.email, u.title, USER_ROLE_LABEL[u.role]].some((x) => (x ?? "").toLowerCase().includes(s));
  });
  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      <HStack>
        <View style={{ flex: 1 }}><SearchBar value={q} onChange={setQ} placeholder="Name, email or role" /></View>
        <IconBtn icon={UserPlus} label="Create user" filled onPress={() => setEdit("new")} />
      </HStack>
      <View style={{ height: 12 }} />
      {list.map((u) => (
        <RecordCard key={u.id} title={u.full_name ?? u.email ?? "—"} subtitle={u.email ?? ""} leading={<Avatar name={u.full_name ?? u.email ?? "?"} />}
          badge={<Badge label={u.title?.trim() || USER_ROLE_LABEL[u.role]} tone={u.role === "super_admin" ? "brand" : "neutral"} small />}
          fields={[{ label: "Region", value: branchName(u.branch_id) }, { label: "Type", value: u.user_type === "partner" ? "Partner" : "Office staff" }, { label: "Permissions", value: u.role === "super_admin" ? "Everything" : `${(u.permissions ?? []).length} granted`, full: true }]}
          actions={[
            { label: "Edit", icon: Pencil, onPress: () => setEdit(u) },
            { label: "Reset", icon: KeyRound, onPress: () => { setPw(""); setReset(u); } },
            { label: "Delete", icon: Trash2, tone: "danger", onPress: async () => {
              if (!(await confirm({ title: `Delete user ${u.email}?`, message: "This removes their access and profile.", confirmLabel: "Delete", tone: "danger" }))) return;
              try { await deleteUser(u, profile?.id ?? null, isSSA); toast("User deleted", "warning"); await reload(); } catch (e) { toast(err(e), "danger"); }
            } },
          ]} />
      ))}
      {data && (
        <UserSheet key={edit === "new" ? "new" : edit?.id ?? "none"} user={edit} data={data} isSSA={isSSA} companyId={db.company.id}
          onClose={() => setEdit(null)} onSaved={async (m) => { setEdit(null); toast(m); await reload(); }} />
      )}
      <Sheet open={!!reset} onClose={() => setReset(null)} title="Reset password" subtitle={reset?.email ?? ""}
        footer={<Button label={busy ? "Resetting…" : "Reset password"} full disabled={busy || pw.length < 8} onPress={async () => {
          if (!reset) return;
          setBusy(true);
          try { await resetPassword(reset.id, pw); setReset(null); toast("Password reset"); } catch (e) { toast(err(e), "danger"); } finally { setBusy(false); }
        }} />}>
        <Input label="New password (at least 8 characters)" secureTextEntry value={pw} onChangeText={setPw} />
      </Sheet>
    </>
  );
}

function UserSheet({ user, data, isSSA, companyId, onClose, onSaved }: {
  user: ProfileRow | "new" | null; data: Awaited<ReturnType<typeof loadUsers>>; isSSA: boolean; companyId: string; onClose: () => void; onSaved: (m: string) => Promise<void>;
}) {
  const t = useTheme();
  const isNew = user === "new";
  const u = user && user !== "new" ? user : null;
  const headOfficeId = data.branches.find((b) => b.is_head_office)?.id ?? null;
  const [f, setF] = useState<UserForm>(() => u ? {
    ...blankForm(), email: u.email ?? "", fullName: u.full_name ?? "", title: u.title ?? "",
    branchId: u.branch_id && u.branch_id === headOfficeId ? "" : u.branch_id ?? "", role: u.role, perms: new Set(u.permissions ?? []),
    userType: u.user_type === "partner" ? "partner" : "office_staff", employeeId: u.employee_id ?? "", partnerScope: new Set(u.partner_scope ?? []),
  } : blankForm());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState<string | null>(null);
  const toggle = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
  const permsLocked = !isNew && f.role === "super_admin";

  return (
    <Sheet full open={!!user} onClose={onClose} title={isNew ? "Create user" : `Edit ${u?.email ?? ""}`} error={e}
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button full label={busy ? "Saving…" : isNew ? "Create user" : "Save"} disabled={busy || (isNew && (!f.email.trim() || f.password.length < 8))} onPress={async () => {
        setBusy(true); setE(null);
        try {
          if (isNew) { await createUser(f, companyId, data.users); await onSaved("User created"); }
          else { await saveUser(u!, f, isSSA); await onSaved("User saved"); }
        } catch (x) { setE(err(x)); } finally { setBusy(false); }
      }} /></>}>
      {isNew && (
        <>
          <Input label="Email" required autoCapitalize="none" keyboardType="email-address" value={f.email} onChangeText={(s) => setF({ ...f, email: s })} />
          <Input label="Password (at least 8 characters)" required secureTextEntry value={f.password} onChangeText={(s) => setF({ ...f, password: s })} />
        </>
      )}
      <Input label="Full name" value={f.fullName} onChangeText={(s) => setF({ ...f, fullName: s })} />
      <Input label="Title (shown instead of the role)" value={f.title} onChangeText={(s) => setF({ ...f, title: s })} />
      <Select label="Region" clearable value={f.branchId} onChange={(s) => setF({ ...f, branchId: s })} placeholder="All regions (Head Office)" options={data.branches.filter((b) => !b.is_head_office).map((b) => ({ value: b.id, label: b.name }))} />
      {!isNew && (
        <>
          <Select label="Role" value={f.role} onChange={(r) => { if (r === "super_admin" && !isSSA) return; setF({ ...f, role: r }); }}
            options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: USER_ROLE_LABEL[r], sub: r === "super_admin" && !isSSA ? "Super Super Admin only" : undefined }))} />
          {u?.role === "super_admin" && !isSSA && <T v="small" color={t.tone("warning").text}>Only a Super Super Admin can change or remove a Super Admin&apos;s role.</T>}
        </>
      )}
      <Select label="User type" value={f.userType} onChange={(v) => setF({ ...f, userType: v === "partner" ? "partner" : "office_staff" })} options={[{ value: "office_staff", label: "Office Staff" }, { value: "partner", label: "Partner" }]} />
      {f.userType !== "partner" ? (
        <>
          <Select label="Linked employee (optional)" searchable clearable value={f.employeeId} onChange={(s) => setF({ ...f, employeeId: s })} placeholder="Not linked — an ordinary admin account"
            options={data.employees.filter((x) => !data.linked.has(x.id) || x.id === u?.employee_id).map((x) => ({ value: x.id, label: `${x.employee_code ? `${x.employee_code} · ` : ""}${x.full_name}` }))} />
          <T v="small" muted>Gives this login a My Profile page showing that employee&apos;s own record, attendance, payslips, advances and cash. One employee, one login.</T>
        </>
      ) : (
        <>
          <T v="smallStrong" soft style={{ marginTop: 6 }}>Partners this user represents</T>
          {data.partners.map((p) => <Checkbox key={p.id} value={f.partnerScope.has(p.id)} onChange={() => setF({ ...f, partnerScope: toggle(f.partnerScope, p.id) })} label={p.name} />)}
          {data.partners.length === 0 && <T v="small" muted>No partners in this company yet.</T>}
          <T v="small" muted>The Partnership Report shows ONLY the selected partners&apos; data. None selected = no partner data.</T>
        </>
      )}
      <T v="eyebrow" muted style={{ marginTop: 14, marginBottom: 6 }}>Permissions{permsLocked ? " — Super Admin has everything" : ` · ${f.perms.size} granted`}</T>
      {!permsLocked && PERMISSION_GROUPS.map((g) => {
        const on = g.items.filter((i) => f.perms.has(i.key)).length;
        return (
          <Card key={g.label} pad={0} style={{ marginBottom: 8 }}>
            <Pressable onPress={() => { tap(); setOpen({ ...open, [g.label]: !open[g.label] }); }} style={{ padding: 12, flexDirection: "row", alignItems: "center" }}>
              <T v="bodyStrong" style={{ flex: 1 }}>{g.label}</T>
              <Badge small label={`${on}/${g.items.length}`} tone={on ? "brand" : "neutral"} />
              {open[g.label] ? <ChevronUp size={18} color={t.mutedFg} /> : <ChevronDown size={18} color={t.mutedFg} />}
            </Pressable>
            {open[g.label] && <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>{g.items.map((i) => <Checkbox key={i.key} value={f.perms.has(i.key)} onChange={() => setF({ ...f, perms: toggle(f.perms, i.key) })} label={i.label} />)}</View>}
          </Card>
        );
      })}
    </Sheet>
  );
}

function Governance() {
  const { db } = useDB();
  const { toast } = useOverlay();
  const loader = useCallback(() => loadGovernance(db.company.id), [db.company.id]);
  const { data, error, reload } = useLoad(loader);
  const [sub, setSub] = useState<"approvals" | "departments">("approvals");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); await reload(); } catch (e) { toast(err(e), "danger"); } finally { setBusy(false); }
  };
  const pending = (data?.requests ?? []).filter((r) => r.status === "pending" || r.status === "recommended");
  const label = (k: string) => String(k).replace(/_/g, " ");
  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      <Chips value={sub} onChange={setSub} items={[{ key: "approvals", label: `Approvals${pending.length ? ` (${pending.length})` : ""}` }, { key: "departments", label: "Departments" }]} />
      {sub === "approvals" && data && (
        <>
          <Section title="Pending requests" count={pending.length}>
            {pending.map((r) => (
              <RecordCard key={r.id} title={label(r.action_key)} subtitle={r.amount != null ? Number(r.amount).toLocaleString() : undefined} accent="warning"
                actions={[{ label: "Approve", tone: "success", onPress: () => run(() => decideApproval(r.id, true), "Approved") }, { label: "Reject", tone: "danger", onPress: () => run(() => decideApproval(r.id, false), "Rejected") }]} />
            ))}
            {pending.length === 0 && <T v="small" muted>Nothing waiting.</T>}
          </Section>
          <Section title="Decision log">
            <ListCard>{data.requests.filter((r) => r.status !== "pending").map((r, i, a) => <Row key={r.id} last={i === a.length - 1} title={label(r.action_key)} meta={r.amount != null ? Number(r.amount).toLocaleString() : undefined} right={<Badge label={r.status} small />} />)}</ListCard>
          </Section>
          <Section title="Action thresholds">
            <Card>{data.configs.map((c) => <Ledger key={c.id ?? c.action_key} label={c.name ?? label(c.action_key)} value={`approver: ${c.approver_permission}${c.threshold_amount != null ? ` · > ${Number(c.threshold_amount).toLocaleString()}` : ""}`} />)}</Card>
          </Section>
        </>
      )}
      {sub === "departments" && data && data.staff.map((s) => (
        <Card key={s.id} style={{ marginTop: 8 }}>
          <T v="bodyStrong">{s.full_name ?? s.email}</T>
          <Select label="Department" clearable value={s.department ?? ""} onChange={(d) => run(() => setDepartment(s.id, d || null))} placeholder="— department —" options={DEPARTMENTS.map((d) => ({ value: d, label: d.replace(/_/g, " ") }))} />
          <Toggle label="RMD" value={!!s.is_rmd} onChange={() => run(() => setRmd(s.id, !s.is_rmd))} />
          <Button size="sm" variant="secondary" label="Apply dept permissions" disabled={busy || !s.department} onPress={() => run(() => applyDeptDefaults(s.id, s.department), "Department permissions applied")} />
        </Card>
      ))}
    </>
  );
}

// ────────────────────────────────────────────────────────────── Audit log
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const SKIP_FIELDS = new Set(["id", "company_id", "created_at", "updated_at", "drive_file_id", "drive_view_url", "attachment_path", "receipt_path", "storage_path"]);
const fieldLabel = (f: string) => f.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const fmtVal = (v: unknown) => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") { const s = JSON.stringify(v); return s.length > 400 ? s.slice(0, 400) + "…" : s; }
  return String(v);
};

export function AuditLog() {
  const t = useTheme();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "super_admin" || profile?.role === "super_super_admin";
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(todayIso());
  const [table, setTable] = useState("all");
  const [action, setAction] = useState("all");
  const [user, setUser] = useState("all");
  const [recordId, setRecordId] = useState("");
  const [field, setField] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Map<string, { full_name: string | null; email: string | null }>>(new Map());
  const [rows, setRows] = useState<any[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { loadAuditProfiles().then((ps) => setProfiles(new Map(ps.map((p) => [p.id, p])))).catch(() => undefined); }, []);
  useEffect(() => {
    let c = false;
    loadAudit({ from, to, table, action, user, recordId, page }).then((r) => { if (!c) { setRows(r.rows); setHasMore(r.hasMore); setError(null); } }).catch((e) => { if (!c) setError(err(e)); });
    return () => { c = true; };
  }, [from, to, table, action, user, recordId, page]);
  const shown = useMemo(() => {
    const qs = field.trim().toLowerCase();
    if (!qs || !rows) return rows ?? [];
    return rows.filter((e) => Object.entries(e.changes ?? {}).some(([k, v]: [string, any]) => k.toLowerCase().includes(qs) || (v?.before != null && String(v.before).toLowerCase().includes(qs)) || (v?.after != null && String(v.after).toLowerCase().includes(qs))));
  }, [rows, field]);
  const userName = (uid: string | null) => { if (!uid) return "(system)"; const p = profiles.get(uid); return p?.full_name ?? p?.email ?? uid.slice(0, 8); };
  const resetPage = <X,>(fn: (x: X) => void) => (x: X) => { fn(x); setPage(0); };

  if (!isAdmin) return <Screen eyebrow="Admin" title="Audit Log"><Empty title="Audit Log is restricted to Super Admin and above." /></Screen>;
  return (
    <Screen eyebrow="Admin" title="Audit Log" subtitle="Who, when, what, before, after" sticky={<SearchBar value={field} onChange={setField} placeholder="Field name or value" />}>
      <View style={{ gap: 8, marginBottom: 12 }}>
        <HStack>
          <Input style={{ flex: 1 }} label="From" value={from} onChangeText={resetPage(setFrom)} />
          <Input style={{ flex: 1 }} label="To" value={to} onChangeText={resetPage(setTo)} />
        </HStack>
        <HStack>
          <View style={{ flex: 1 }}><Select compact label="Table" value={table} onChange={resetPage(setTable)} options={[{ value: "all", label: "All tables" }, ...AUDITED_TABLES.map((x) => ({ value: x, label: x }))]} /></View>
          <View style={{ flex: 1 }}><Select compact label="Action" value={action} onChange={resetPage(setAction)} options={[{ value: "all", label: "All actions" }, ...["insert", "update", "delete"].map((x) => ({ value: x, label: x }))]} /></View>
        </HStack>
        <Select compact searchable label="User" value={user} onChange={resetPage(setUser)} options={[{ value: "all", label: "Anyone" }, ...[...profiles.entries()].filter(([, p]) => p.full_name || p.email).map(([id, p]) => ({ value: id, label: p.full_name ?? p.email ?? id }))]} />
        <Input label="Record ID" autoCapitalize="none" value={recordId} onChangeText={resetPage(setRecordId)} />
      </View>
      {error && <Banner tone="danger" title={error} />}
      {!rows && !error && <ActivityIndicator />}
      {shown.map((a) => {
        const keys = Object.keys(a.changes ?? {});
        const disp = keys.filter((f) => !SKIP_FIELDS.has(f)).map(fieldLabel);
        return (
          <Card key={a.id} style={{ marginBottom: 8 }} onPress={() => setOpen(open === a.id ? null : a.id)}>
            <HStack>
              <Badge label={String(a.action).toLowerCase()} tone={/delete/i.test(a.action) ? "danger" : /insert/i.test(a.action) ? "success" : "info"} small />
              <T v="mono" style={{ flex: 1 }} numberOfLines={1}>{a.table_name} · {String(a.record_id ?? "").slice(0, 8)}</T>
            </HStack>
            <T v="small" muted style={{ marginTop: 6 }}>{userName(a.changed_by)} · {new Date(a.changed_at).toLocaleString("en-GB")} · {disp.length <= 3 ? disp.join(", ") : `${disp.slice(0, 3).join(", ")} +${disp.length - 3} more`}</T>
            {open === a.id && (
              <View style={{ marginTop: 10, gap: 6 }}>
                {keys.map((k) => {
                  const v = (a.changes ?? {})[k] ?? {};
                  return (
                    <View key={k} style={{ backgroundColor: t.muted, borderRadius: radius.md, padding: 10 }}>
                      <T v="eyebrow" muted>{fieldLabel(k)}</T>
                      <T v="mono" color={t.tone("danger").text} style={{ marginTop: 4 }}>− {fmtVal(v.before)}</T>
                      <T v="mono" color={t.tone("success").text}>+ {fmtVal(v.after)}</T>
                    </View>
                  );
                })}
              </View>
            )}
          </Card>
        );
      })}
      {rows && shown.length === 0 && <Empty title="No entries match" />}
      <HStack style={{ marginTop: 10, justifyContent: "space-between" }}>
        <Button size="sm" variant="secondary" label="Newer" disabled={page === 0} onPress={() => setPage((p) => Math.max(0, p - 1))} />
        <T v="small" muted>Page {page + 1} · {AUDIT_PAGE_SIZE} per page</T>
        <Button size="sm" variant="secondary" label="Older" disabled={!hasMore} onPress={() => setPage((p) => p + 1)} />
      </HStack>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────── Settings
export function Settings() {
  const t = useTheme();
  const { brandKey, setBrandKey } = useThemeCtx();
  const { db, reload: reloadDB } = useDB();
  const { can, profile } = useAuth();
  const { toast, confirm } = useOverlay();
  const canEdit = can("settings.edit");
  const admin = profile?.role === "super_admin" || profile?.role === "super_super_admin";
  const companyId = db.company.id;
  const loader = useCallback(() => loadSettings(companyId), [companyId]);
  const { data, error, reload } = useLoad(loader);
  const [hidden, setHidden] = useState<Set<string> | null>(null);
  const hiddenNow = hidden ?? new Set<string>((db.company.raw?.dashboard_hidden_widgets ?? []) as string[]);
  const [notif, setNotif] = useState<{ recipient: string; sender: string } | null>(null);
  const n = notif ?? data?.notif ?? { recipient: "", sender: "info@techxserve.com" };
  const [busy, setBusy] = useState<string | null>(null);
  const [newRegion, setNewRegion] = useState(false);
  const [rname, setRname] = useState("");
  const [renaming, setRenaming] = useState<BranchRow | null>(null);
  const [ho, setHo] = useState<{ b: BranchRow; reason: string; preview: { region_name: string; absorbs_now: number; absorbs_after: number; delta: number }[]; err: string | null } | null>(null);
  const [me, setMe] = useState<{ username: string; email: string; companyName: string; logoUrl: string | null } | null>(null);
  useEffect(() => {
    if (!profile) return;
    loadMyDisplay(profile.id).then((p) => setMe({ username: p?.full_name ?? "", email: p?.email ?? "", companyName: p?.display_company_name ?? "", logoUrl: p?.avatar_url ?? null })).catch(() => undefined);
  }, [profile]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try { await fn(); if (ok) toast(ok); return true; } catch (e) { toast(err(e), "danger"); return false; } finally { setBusy(null); }
  };

  return (
    <Screen eyebrow="Admin" title="Settings">
      {error && <Banner tone="danger" title={error} />}
      <Section title="Company profile" hint="Personal display only — these change what you see in the app and don't affect the company record or other users." style={{ marginTop: 0 }}>
        {me && (
          <Card>
            <HStack style={{ marginBottom: 14 }}>
              <View style={{ width: 56, height: 56, borderRadius: 14, backgroundColor: t.muted, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                {me.logoUrl ? <Image source={{ uri: me.logoUrl }} style={{ width: 56, height: 56 }} resizeMode="contain" /> : <T v="h3">{db.company.short}</T>}
              </View>
              <Button size="sm" variant="secondary" label="Upload logo" onPress={async () => {
                try {
                  const img = await pickImageDataUrl();
                  if (!img) return;
                  if (img.size > 512 * 1024) { toast("Please choose an image under 512 KB.", "danger"); return; }
                  setMe({ ...me, logoUrl: img.dataUrl });
                } catch (e) { toast(err(e), "danger"); }
              }} />
              {me.logoUrl && <Button size="sm" variant="ghost" label="Remove" onPress={() => setMe({ ...me, logoUrl: null })} />}
            </HStack>
            <Input label="Company name" placeholder="How the company name appears to you" value={me.companyName} onChangeText={(s) => setMe({ ...me, companyName: s })} />
            <Input label="Username" value={me.username} onChangeText={(s) => setMe({ ...me, username: s })} />
            <Input label="Email" autoCapitalize="none" value={me.email} onChangeText={(s) => setMe({ ...me, email: s })} />
            <Button label={busy === "me" ? "Saving…" : "Save"} disabled={busy === "me"} onPress={() => profile && run("me", () => saveMyDisplay(profile.id, me), "Profile saved")} />
          </Card>
        )}
      </Section>

      <Section title="Regional management" count={data?.branches.length} action={canEdit ? <T v="smallStrong" color={t.tone("brand").text} onPress={() => setNewRegion(true)}>Add region</T> : undefined}>
        {data?.branches.map((b) => (
          <Card key={b.id} style={{ marginBottom: 8 }}>
            <HStack>
              <T v="bodyStrong" style={{ flex: 1 }}>{b.name}</T>
              <Badge label={b.is_head_office ? "Head office" : `${b.employees} employees`} small tone="neutral" />
            </HStack>
            {!b.is_head_office && (
              <>
                <Toggle label="Exclude from HO allocation" sub={b.ho_excluded ? `Excluded — ${b.ho_excluded_reason ?? ""}` : "Its revenue carries a share of head-office cost."} value={b.ho_excluded} onChange={async () => {
                  if (!canEdit) return;
                  setHo({ b, reason: b.ho_excluded_reason ?? "", preview: [], err: null });
                  try { const preview = await hoExclusionPreview(companyId, data.branches, b); setHo((h) => h && ({ ...h, preview })); } catch (e) { setHo((h) => h && ({ ...h, err: err(e) })); }
                }} />
                {canEdit && (
                  <HStack>
                    <Button size="sm" variant="ghost" icon={Pencil} label="Rename" onPress={() => { setRname(b.name); setRenaming(b); }} />
                    <Button size="sm" variant="ghost" icon={Trash2} label="Delete" onPress={async () => {
                      const msg = b.employees > 0 ? `${b.employees} employee(s) are assigned to this branch and will be moved to Head Office.` : "This cannot be undone.";
                      if (!(await confirm({ title: `Delete "${b.name}"?`, message: msg, confirmLabel: "Delete", tone: "danger" }))) return;
                      if (await run("del", () => deleteBranch(b, data.branches), "Region deleted")) { await reload(); await reloadDB(); }
                    }} />
                  </HStack>
                )}
              </>
            )}
          </Card>
        ))}
      </Section>

      {admin && (
        <Section title="Appearance" hint="The company's brand colour, applied for everyone.">
          <View style={{ flexDirection: "row", gap: 10 }}>
            {(["amber", "green", "steel"] as const).map((k) => (
              <Pressable key={k} disabled={busy === "theme"} onPress={async () => {
                tap();
                const prev = brandKey;
                setBrandKey(k);
                if (!(await run("theme", () => setCompanyTheme(companyId, k), "Palette applied"))) setBrandKey(prev);
                else await reloadDB();
              }} style={{ flex: 1, padding: 12, borderRadius: radius.lg, backgroundColor: t.card, borderWidth: 2, borderColor: brandKey === k ? brandPalettes[k]![500] : t.border, alignItems: "center", gap: 8 }}>
                <View style={{ flexDirection: "row", gap: 3 }}>{([500, 600, 700] as const).map((s) => <View key={s} style={{ width: 16, height: 28, borderRadius: 4, backgroundColor: brandPalettes[k]![s] }} />)}</View>
                <HStack gap={4}>{brandKey === k && <Check size={14} color={t.fg} />}<T v="smallStrong">{k === "amber" ? "Amber" : k === "green" ? "Emerald" : "Steel blue"}</T></HStack>
              </Pressable>
            ))}
          </View>
        </Section>
      )}

      <Section title="Dashboard widgets" hint="Hidden widgets are hidden for everyone in the company.">
        <Card>
          {DASHBOARD_WIDGET_KEYS.map((k) => <Checkbox key={k} value={!hiddenNow.has(k)} onChange={() => { const nx = new Set(hiddenNow); if (nx.has(k)) nx.delete(k); else nx.add(k); setHidden(nx); }} label={DASHBOARD_WIDGET_LABELS[k]} />)}
          {canEdit && <Button label={busy === "widgets" ? "Saving…" : "Save widgets"} style={{ marginTop: 8 }} disabled={busy === "widgets"} onPress={async () => { if (await run("widgets", () => saveHiddenWidgets(companyId, [...hiddenNow]), "Dashboard widgets saved")) await reloadDB(); }} />}
        </Card>
      </Section>

      {admin && (
        <Section title="Notifications" hint="Where compliance alerts are emailed.">
          <Card>
            <Input label="Recipient email" autoCapitalize="none" keyboardType="email-address" value={n.recipient} onChangeText={(v) => setNotif({ ...n, recipient: v })} />
            <Input label="Sender email" autoCapitalize="none" keyboardType="email-address" value={n.sender} onChangeText={(v) => setNotif({ ...n, sender: v })} />
            <HStack>
              <Button style={{ flex: 1 }} label={busy === "notif" ? "Saving…" : "Save"} disabled={busy === "notif"} onPress={() => run("notif", () => saveNotificationSettings(companyId, n.recipient, n.sender), "Notification settings saved")} />
              <Button style={{ flex: 1 }} variant="secondary" label={busy === "test" ? "Sending…" : "Send test"} disabled={busy === "test"} onPress={async () => {
                setBusy("test");
                try { toast(await sendTestEmail(n.recipient, n.sender)); } catch (e) { toast(err(e), "danger"); } finally { setBusy(null); }
              }} />
            </HStack>
          </Card>
        </Section>
      )}

      <Sheet open={newRegion} onClose={() => setNewRegion(false)} title="Add region" footer={<Button label="Add" full disabled={!rname.trim() || busy === "add"} onPress={async () => {
        if (await run("add", () => addBranch(rname), "Region added")) { setNewRegion(false); setRname(""); await reload(); await reloadDB(); }
      }} />}>
        <Input label="Region name" required value={rname} onChangeText={setRname} />
      </Sheet>
      <Sheet open={!!renaming} onClose={() => setRenaming(null)} title="Rename region" footer={<Button label="Save" full disabled={!rname.trim()} onPress={async () => {
        if (renaming && (await run("ren", () => renameBranch(renaming.id, rname), "Region renamed"))) { setRenaming(null); setRname(""); await reload(); await reloadDB(); }
      }} />}>
        <Input label="Region name" required value={rname} onChangeText={setRname} />
      </Sheet>
      <Sheet open={!!ho} onClose={() => setHo(null)} title={ho ? (ho.b.ho_excluded ? `Re-include ${ho.b.name} in HO allocation` : `Exclude ${ho.b.name} from HO allocation`) : ""} error={ho?.err}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setHo(null)} /><Button full label="Confirm" disabled={!ho || busy === "ho" || (!ho.b.ho_excluded && !ho.reason.trim())} onPress={async () => {
          if (!ho) return;
          setBusy("ho");
          try { await saveHoExclusion(ho.b, ho.reason, profile?.id ?? null); setHo(null); toast("Region updated"); await reload(); await reloadDB(); }
          catch (e) { setHo((h) => h && ({ ...h, err: err(e) })); } finally { setBusy(null); }
        }} /></>}>
        <T v="small" muted>What each region absorbs of head-office cost this month, now and after the change:</T>
        {ho?.preview.map((p) => <Ledger key={p.region_name} label={p.region_name} value={`${money(p.absorbs_now)} → ${money(p.absorbs_after)} (${p.delta >= 0 ? "+" : ""}${money(p.delta)})`} />)}
        {ho && !ho.b.ho_excluded && <Input label="Reason" required value={ho.reason} onChangeText={(s) => setHo({ ...ho, reason: s })} />}
      </Sheet>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────── Billing
const STATUS_COPY: Record<string, { label: string; tone: "success" | "warning" | "danger" }> = {
  active: { label: "Active", tone: "success" }, trialing: { label: "Trial", tone: "success" }, past_due: { label: "Payment failed", tone: "warning" },
  unpaid: { label: "Unpaid", tone: "danger" }, canceled: { label: "Cancelled", tone: "danger" }, incomplete: { label: "Incomplete", tone: "warning" },
};

export function Billing() {
  const { profile } = useAuth();
  const { toast } = useOverlay();
  const canManage = profile?.role === "super_admin" || profile?.role === "super_super_admin";
  const [summary, setSummary] = useState<BillingSummary | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [guards, setGuards] = useState<number | null>(null);
  const [care, setCare] = useState<boolean | null>(null);
  const reload = useCallback(async () => { setSummary(await fetchBillingSummary()); }, []);
  useEffect(() => { const h = setTimeout(() => { void reload(); }, 0); return () => clearTimeout(h); }, [reload]);
  const cap = useMemo(() => guardCapState(summary ?? null), [summary]);
  const g = guards ?? summary?.guard_limit ?? PRICING.slider.default;
  const c = care ?? summary?.plan_care ?? false;
  const quote = useMemo(() => computePricing(g, c), [g, c]);
  const run = async (key: string, fn: () => Promise<{ url?: string; ok?: boolean } | { error: string }>) => {
    setBusy(key);
    const res = await fn();
    if ("error" in res) { toast(res.error, "danger"); setBusy(null); return; }
    // Stripe's checkout / portal page opens in the browser, as the web redirects.
    if (res.url) { await Linking.openURL(res.url); setBusy(null); return; }
    await reload();
    toast("Your plan has been updated. Stripe will settle the difference on your next invoice.");
    setBusy(null);
  };

  if (summary === undefined) return <Screen eyebrow="Admin" title="Plan & Billing"><ActivityIndicator style={{ marginTop: 24 }} /></Screen>;
  if (!summary) return <Screen eyebrow="Admin" title="Plan & Billing"><Empty title="No billing information for this company." /></Screen>;
  const status = summary.billing_status ? STATUS_COPY[summary.billing_status] : null;
  const planChanged = g !== summary.guard_limit || c !== summary.plan_care;

  return (
    <Screen eyebrow="Admin" title="Plan & Billing" subtitle="What you pay for, what you're using, and how to change it">
      {cap.uncapped && <Banner tone="warning" title="This company was set up manually" sub="It has no guard limit and no self-serve subscription. Billing is handled outside the app." />}
      <Card>
        <HStack><T v="h3" style={{ flex: 1 }}>Your plan</T>{status && <Badge label={status.label} tone={status.tone} dot />}</HStack>
        <View style={{ marginTop: 12 }}>
          <Ledger label="Monthly" value={summary.plan_price_pkr != null ? money(summary.plan_price_pkr) : "—"} />
          <Ledger label="Guards covered" value={summary.guard_limit != null ? String(summary.guard_limit) : "Unlimited"} />
          <Ledger label="Renews" value={summary.current_period_end ? fmtDate(summary.current_period_end) : summary.subscription_expires_at ?? "—"} />
        </View>
        {summary.plan_care && <T v="small" muted style={{ marginTop: 8 }}>Includes {PRICING.care.label} — priority support and onboarding.</T>}
        {summary.has_subscription && canManage && <Button variant="secondary" label="Card, invoices & cancellation" style={{ marginTop: 10 }} loading={busy === "portal"} onPress={() => run("portal", openBillingPortal)} />}
      </Card>
      {!cap.uncapped && (
        <Section title="Guards">
          <Card>
            <Ledger label="Covered" value={`${cap.used} of ${cap.limit}`} strong />
            <T v="small" muted>{cap.remaining === 0 ? "No room left" : `${cap.remaining} more can be added`}</T>
            <View style={{ marginTop: 10 }}><Progress value={cap.used} max={cap.limit + cap.buffer} tone={cap.atHardLimit ? "danger" : cap.inBuffer ? "warning" : "brand"} /></View>
            <T v="small" muted style={{ marginTop: 8 }}>Your plan covers {cap.limit} guards. We allow {cap.buffer} over that as breathing room, so you are only stopped at {cap.limit + cap.buffer}. Office staff don&apos;t count.</T>
            {cap.atHardLimit && <Banner tone="danger" title="You've used your buffer as well." sub="Adding another guard will be refused until you raise your plan below." />}
            {cap.inBuffer && !cap.atHardLimit && <Banner tone="warning" title={`You're ${cap.used - cap.limit} over your paid plan`} sub={`You are into the ${cap.buffer}-guard buffer. Raise your plan before it runs out.`} />}
          </Card>
        </Section>
      )}
      {!cap.uncapped && summary.has_subscription && canManage && (
        <Section title="Change your plan">
          <Card>
            <Input label={`Guards covered (${PRICING.slider.min}–${PRICING.inputMax})`} keyboardType="numeric" value={String(g)} onChangeText={(s) => setGuards(normaliseGuards(Number(s) || PRICING.slider.min))} />
            <Toggle label={PRICING.care.label} value={c} onChange={setCare} />
            {quote.lines.map((l) => <Ledger key={l.label} label={l.label} sub={l.detail} value={money(l.amount)} />)}
            <Ledger label="New monthly total" value={money(quote.total)} strong top />
            <Ledger label="Included AI credit" value={`${money(quote.aiCredit)}/month`} />
            {g < cap.used && <T v="small" color="#b91c1c">You already have {cap.used} guards on the books. Pick {cap.used} or more.</T>}
            <Button style={{ marginTop: 10 }} label={planChanged ? "Update my plan" : "No changes to apply"} disabled={!planChanged || g < cap.used} loading={busy === "plan"} onPress={() => run("plan", () => changePlan(g, c))} />
            <T v="small" muted style={{ marginTop: 6 }}>The new limit applies straight away. Stripe works out the part-month difference and puts it on your next invoice — nothing is charged right now.</T>
          </Card>
        </Section>
      )}
      <Section title="AI credit">
        <Card>
          {cap.uncapped ? <T v="small" muted>AI usage isn&apos;t metered on this company — it has no self-serve plan.</T> : (
            <>
              <Ledger label="Available now" value={money(summary.ai_credit_available)} strong />
              <Ledger label="Monthly allowance" value={money(summary.ai_credit_monthly)} />
              <Ledger label="Top-up balance" value={money(summary.ai_credit_topup)} />
              <T v="small" muted style={{ marginTop: 6 }}>Your allowance resets every renewal and does not roll over. Top-ups never expire and are only used once the monthly allowance is gone.</T>
              {summary.ai_credit_available <= 0 && <Banner tone="warning" title="Your AI credit is used up." sub="The assistant is paused until you top up or your plan renews." />}
              {canManage && summary.has_subscription && (
                <HStack wrap style={{ marginTop: 10 }}>
                  {AI_TOPUP_PACKS.map((p) => <Button key={p.id} size="sm" variant="secondary" icon={Wallet} label={money(p.credit)} loading={busy === p.id} onPress={() => run(p.id, () => buyAiTopup(p.id))} />)}
                </HStack>
              )}
            </>
          )}
        </Card>
      </Section>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────── Platform owner
export function Companies() {
  const router = useRouter();
  const { profile } = useAuth();
  const { reload: reloadDB } = useDB();
  const { toast, confirm } = useOverlay();
  const { data, error, reload } = useLoad(loadCompanies);
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ name: "", prefix: "", email: "", phone: "" });
  const [sub, setSub] = useState<any | null>(null);
  const [payments, setPayments] = useState<any[]>([]);
  const [pf, setPf] = useState({ amount: "", days: "", date: todayIso(), notes: "" });
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const openSub = async (c: any) => { setSub(c); setPf({ amount: "", days: "", date: todayIso(), notes: "" }); setSheetErr(null); try { setPayments(await loadSubscriptionPayments(c.id)); } catch (e) { setSheetErr(err(e)); } };

  return (
    <Screen eyebrow="Platform" title="Companies" subtitle="All tenant companies, their admins and access" actions={<IconBtn icon={Plus} label="New company" filled onPress={() => { setSheetErr(null); setAdd(true); }} />}>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {data?.map((c) => (
        <RecordCard key={c.id} title={c.name} subtitle={c.contact_email ?? c.contact_phone ?? ""} badge={<Badge label={c.active ? "Active" : "Inactive"} tone={c.active ? "success" : "danger"} />}
          onPress={() => router.push(`/companies/${c.id}`)}
          fields={[{ label: "Users", value: String(c.user_count), mono: true }, { label: "Employees", value: String(c.employee_count), mono: true }, { label: "Paid until", value: c.subscription_expires_at ? fmtShort(c.subscription_expires_at) : "—" }]}
          actions={[
            { label: "View as", icon: Eye, onPress: async () => {
              if (!profile) return;
              try { await setViewAsCompany(profile.id, c.id); await reloadDB(); toast(`Viewing as ${c.name}`); router.replace("/"); } catch (e) { toast(err(e), "danger"); }
            } },
            { label: "Subscription", icon: Wallet, onPress: () => openSub(c) },
            { label: c.active ? "Deactivate" : "Activate", icon: Power, tone: c.active ? "danger" : "success", onPress: async () => {
              const next = !c.active;
              if (!(await confirm({ title: next ? `Activate "${c.name}"?` : `Deactivate "${c.name}"?`, message: next ? "Its users will be able to sign in again." : "Its users will be blocked from signing in. Data is preserved and restored on reactivation.", confirmLabel: next ? "Activate" : "Deactivate", tone: next ? undefined : "danger" }))) return;
              try { await setCompanyActive(c.id, next); await reload(); } catch (e) { toast(err(e), "danger"); }
            } },
          ]} />
      ))}
      {profile?.role === "super_super_admin" && (
        <Button variant="ghost" label="Stop viewing as another company" onPress={async () => { try { await setViewAsCompany(profile.id, null); await reloadDB(); toast("Back to your own company"); } catch (e) { toast(err(e), "danger"); } }} />
      )}
      <Sheet open={add} onClose={() => setAdd(false)} title="New company" error={sheetErr} footer={<Button label={busy ? "Creating…" : "Create"} full disabled={busy || !f.name.trim()} onPress={async () => {
        setBusy(true); setSheetErr(null);
        try { await addCompany(f); setAdd(false); setF({ name: "", prefix: "", email: "", phone: "" }); toast("Company created"); await reload(); } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
      }} />}>
        <Input label="Company name" required value={f.name} onChangeText={(v) => setF({ ...f, name: v })} />
        <Input label="Invoice prefix" autoCapitalize="characters" value={f.prefix} onChangeText={(v) => setF({ ...f, prefix: v.toUpperCase() })} />
        <Input label="Contact email" autoCapitalize="none" value={f.email} onChangeText={(v) => setF({ ...f, email: v })} />
        <Input label="Contact phone" keyboardType="phone-pad" value={f.phone} onChangeText={(v) => setF({ ...f, phone: v })} />
      </Sheet>
      <Sheet full open={!!sub} onClose={() => setSub(null)} title={sub ? `Subscription — ${sub.name}` : ""} subtitle={sub?.subscription_expires_at ? `Paid until ${fmtShort(sub.subscription_expires_at)}` : undefined} error={sheetErr}
        footer={<Button label={busy ? "Recording…" : "Record payment"} full disabled={busy} onPress={async () => {
          if (!sub) return;
          setBusy(true); setSheetErr(null);
          try { await addSubscriptionPayment(sub.id, pf); toast("Payment recorded"); await openSub(sub); await reload(); } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
        }} />}>
        <HStack>
          <Input style={{ flex: 1 }} label="Amount" keyboardType="numeric" value={pf.amount} onChangeText={(v) => setPf({ ...pf, amount: v })} />
          <Input style={{ flex: 1 }} label="Days added" keyboardType="numeric" value={pf.days} onChangeText={(v) => setPf({ ...pf, days: v })} />
        </HStack>
        <Input label="Payment date" value={pf.date} onChangeText={(v) => setPf({ ...pf, date: v })} />
        <Input label="Notes" value={pf.notes} onChangeText={(v) => setPf({ ...pf, notes: v })} />
        <T v="eyebrow" muted style={{ marginVertical: 8 }}>History</T>
        <ListCard>{payments.map((p, i) => <Row key={p.id} last={i === payments.length - 1} title={fmtShort(p.payment_date)} meta={`${p.days_added} days${p.notes ? ` · ${p.notes}` : ""}`} right={<T v="mono">{Number(p.amount).toLocaleString()}</T>} />)}</ListCard>
        {payments.length === 0 && <T v="small" muted>No payments recorded.</T>}
      </Sheet>
    </Screen>
  );
}

export function CompanyDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { toast } = useOverlay();
  const loader = useCallback(() => loadCompanyDetail(id), [id]);
  const { data, error, reload } = useLoad(loader);
  const [invite, setInvite] = useState(false);
  const [f, setF] = useState({ email: "", password: "", name: "", title: "" });
  const [reset, setReset] = useState<ProfileRow | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  if (error) return <Screen title="Company"><Banner tone="danger" title={error} /></Screen>;
  if (!data) return <Screen title="Company"><ActivityIndicator style={{ marginTop: 24 }} /></Screen>;
  if (!data.company) return <Screen title="Company"><Empty title="Company not found" /></Screen>;
  return (
    <Screen eyebrow="Platform" title={data.company.name} actions={<IconBtn icon={UserPlus} label="Invite admin" filled onPress={() => { setSheetErr(null); setInvite(true); }} />}>
      <Section title="Users" count={data.users.length} style={{ marginTop: 0 }}>
        <ListCard>
          {data.users.map((u, i) => (
            <Row key={u.id} last={i === data.users.length - 1} title={u.full_name ?? u.email ?? "—"} subtitle={u.email ?? ""} meta={u.title?.trim() || USER_ROLE_LABEL[u.role]}
              right={<IconBtn icon={KeyRound} size={34} label="Reset password" onPress={() => { setPw(""); setSheetErr(null); setReset(u); }} />} />
          ))}
        </ListCard>
        {data.users.length === 0 && <T v="small" muted>No users yet. Invite the company&apos;s first admin.</T>}
      </Section>
      <Sheet open={invite} onClose={() => setInvite(false)} title="Invite a Super Admin" error={sheetErr} footer={<Button label={busy ? "Creating…" : "Create admin"} full disabled={busy || !f.email.trim() || f.password.length < 8} onPress={async () => {
        setBusy(true); setSheetErr(null);
        try { await inviteCompanyAdmin(id, f); setInvite(false); setF({ email: "", password: "", name: "", title: "" }); toast("Admin created"); await reload(); } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
      }} />}>
        <Input label="Email" required autoCapitalize="none" keyboardType="email-address" value={f.email} onChangeText={(v) => setF({ ...f, email: v })} />
        <Input label="Password (at least 8 characters)" required secureTextEntry value={f.password} onChangeText={(v) => setF({ ...f, password: v })} />
        <Input label="Full name" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} />
        <Input label="Title" value={f.title} onChangeText={(v) => setF({ ...f, title: v })} />
      </Sheet>
      <Sheet open={!!reset} onClose={() => setReset(null)} title="Reset password" subtitle={reset?.email ?? ""} error={sheetErr} footer={<Button label={busy ? "Resetting…" : "Reset"} full disabled={busy || pw.length < 8} onPress={async () => {
        if (!reset) return;
        setBusy(true); setSheetErr(null);
        try { await resetPassword(reset.id, pw); setReset(null); toast("Password reset"); } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
      }} />}>
        <Input label="New password" secureTextEntry value={pw} onChangeText={setPw} />
      </Sheet>
    </Screen>
  );
}
