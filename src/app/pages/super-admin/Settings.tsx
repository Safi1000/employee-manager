import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Loader2, AlertCircle, X, Trash2, Mail, Send, LayoutDashboard, Building2, Palette, Check } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import {
  supabase,
  DASHBOARD_WIDGET_KEYS,
  DASHBOARD_WIDGET_LABELS,
  type ClientType,
  type DashboardWidgetKey,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { THEME_OPTIONS, DEFAULT_THEME, applyTheme, type ThemeKey } from "../../lib/theme";

type LocationRow = { id: string; name: string; employees: number };
type BranchRow = { id: string; name: string; is_head_office: boolean; employees: number };
type ClientRow = {
  id: string;
  client_code: string;
  name: string;
  email: string | null;
  phone: string | null;
  allowed_leaves_per_month: number;
  client_type: ClientType;
  leave_carry_forward: boolean;
  eobi_enabled: boolean;
  eobi_amount: number;
  branch_id: string | null;
  auto_invoice_enabled: boolean;
  auto_invoice_amount: number;
  auto_invoice_withholding: number;
  contract_start: string | null;
  contract_end: string | null;
  advance_payment: boolean;
  contract_drive_file_id: string | null;
  contract_drive_view_url: string | null;
  contract_file_name: string | null;
  employees: number;
};

const clientTypeLabel = (t: ClientType) =>
  t === "security_services" ? "Security Services" : "Guard Deployment";

export default function Settings() {
  const { company, profile, refreshProfile } = useAuth();
  const canManageNotifications =
    profile?.role === "super_admin" || profile?.role === "super_super_admin";
  const initialHidden = useMemo(
    () => new Set<string>((company?.dashboard_hidden_widgets ?? []) as string[]),
    [company?.dashboard_hidden_widgets],
  );
  const [hiddenWidgets, setHiddenWidgets] = useState<Set<string>>(initialHidden);

  // Appearance (brand palette). SA/SSA only — see canManageNotifications gate.
  const [themeKey, setThemeKey] = useState<string>(company?.theme ?? DEFAULT_THEME);
  const [themeSaving, setThemeSaving] = useState<string | null>(null);
  const [themeSavedAt, setThemeSavedAt] = useState<string | null>(null);
  useEffect(() => {
    setThemeKey(company?.theme ?? DEFAULT_THEME);
  }, [company?.theme]);

  const selectTheme = async (key: ThemeKey) => {
    if (!company?.id || themeKey === key || themeSaving) return;
    const prev = themeKey;
    setThemeKey(key);
    applyTheme(key); // instant, optimistic preview
    setThemeSaving(key);
    setThemeSavedAt(null);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("companies")
        .update({ theme: key })
        .eq("id", company.id);
      if (upErr) throw upErr;
      setThemeSavedAt(new Date().toLocaleTimeString());
      await refreshProfile();
    } catch (e: any) {
      // Roll back the preview if the write failed.
      setThemeKey(prev);
      applyTheme(prev);
      setError(e?.message ?? String(e));
    } finally {
      setThemeSaving(null);
    }
  };

  const [dashboardSaving, setDashboardSaving] = useState(false);
  const [dashboardSavedAt, setDashboardSavedAt] = useState<string | null>(null);
  useEffect(() => {
    setHiddenWidgets(new Set(initialHidden));
  }, [initialHidden]);

  const toggleWidget = (key: DashboardWidgetKey) => {
    setHiddenWidgets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setDashboardSavedAt(null);
  };

  // The invoice template is no longer editable here. `companies.invoice_template` is
  // NOT NULL with a full 12-field default, so every company (existing and future) keeps
  // a working template and invoice PDFs render unchanged — see generateInvoicePdf.

  const saveDashboardWidgets = async () => {
    if (!company?.id) return;
    setDashboardSaving(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("companies")
        .update({ dashboard_hidden_widgets: Array.from(hiddenWidgets) })
        .eq("id", company.id);
      if (upErr) throw upErr;
      setDashboardSavedAt(new Date().toLocaleTimeString());
      await refreshProfile();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setDashboardSaving(false);
    }
  };

  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchAddOpen, setBranchAddOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchSubmitting, setBranchSubmitting] = useState(false);
  const [branchEditingId, setBranchEditingId] = useState<string | null>(null);
  const [branchEditingName, setBranchEditingName] = useState("");
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [locAddOpen, setLocAddOpen] = useState(false);
  const [newLocName, setNewLocName] = useState("");
  const [locEditingId, setLocEditingId] = useState<string | null>(null);
  const [locEditingName, setLocEditingName] = useState("");

  const [clientAddOpen, setClientAddOpen] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientAllowedLeaves, setNewClientAllowedLeaves] = useState<number>(0);
  const [newClientType, setNewClientType] = useState<ClientType>("security_services");

  const [clientEditingId, setClientEditingId] = useState<string | null>(null);
  const [editClientName, setEditClientName] = useState("");
  const [editClientEmail, setEditClientEmail] = useState("");
  const [editClientPhone, setEditClientPhone] = useState("");
  const [editClientAllowedLeaves, setEditClientAllowedLeaves] = useState<number>(0);
  const [editClientType, setEditClientType] = useState<ClientType>("security_services");
  const [editClientCarry, setEditClientCarry] = useState<boolean>(false);
  const [newClientCarry, setNewClientCarry] = useState<boolean>(false);

  const [newClientEobiOn, setNewClientEobiOn] = useState<boolean>(false);
  const [newClientEobiAmt, setNewClientEobiAmt] = useState<number>(0);
  const [editClientEobiOn, setEditClientEobiOn] = useState<boolean>(false);
  const [editClientEobiAmt, setEditClientEobiAmt] = useState<number>(0);

  const [newClientBranchId, setNewClientBranchId] = useState<string>("");
  const [editClientBranchId, setEditClientBranchId] = useState<string>("");

  const [newClientAutoInv, setNewClientAutoInv] = useState<boolean>(false);
  const [newClientAutoAmt, setNewClientAutoAmt] = useState<number>(0);
  const [newClientAutoWht, setNewClientAutoWht] = useState<number>(0);
  const [newClientContractStart, setNewClientContractStart] = useState<string>("");
  const [newClientContractEnd, setNewClientContractEnd] = useState<string>("");
  const [newClientAdvancePayment, setNewClientAdvancePayment] = useState<boolean>(false);

  const [editClientAutoInv, setEditClientAutoInv] = useState<boolean>(false);
  const [editClientAutoAmt, setEditClientAutoAmt] = useState<number>(0);
  const [editClientAutoWht, setEditClientAutoWht] = useState<number>(0);
  const [editClientContractStart, setEditClientContractStart] = useState<string>("");
  const [editClientContractEnd, setEditClientContractEnd] = useState<string>("");
  const [editClientAdvancePayment, setEditClientAdvancePayment] = useState<boolean>(false);

  // Contract file upload state — keyed by client id so multiple rows can be
  // expanded simultaneously without sharing a loading spinner.
  const [contractUploadingId, setContractUploadingId] = useState<string | null>(null);
  const [contractError, setContractError] = useState<string | null>(null);

  // Contract renewal modal.
  const [renewClient, setRenewClient] = useState<ClientRow | null>(null);
  const [renewStart, setRenewStart] = useState<string>("");
  const [renewEnd, setRenewEnd] = useState<string>("");
  const [renewNotes, setRenewNotes] = useState<string>("");
  const [renewSubmitting, setRenewSubmitting] = useState(false);
  const [renewHistory, setRenewHistory] = useState<
    { id: string; contract_start: string | null; contract_end: string | null; notes: string | null; renewed_at: string }[]
  >([]);

  const [submitting, setSubmitting] = useState(false);

  const [notificationEmail, setNotificationEmail] = useState("");
  const [notificationSenderEmail, setNotificationSenderEmail] = useState("info@techxserve.com");
  const [notificationLoading, setNotificationLoading] = useState(true);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [notificationSavedAt, setNotificationSavedAt] = useState<string | null>(null);
  const [notificationTesting, setNotificationTesting] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);

  const loadNotificationSettings = async () => {
    setNotificationLoading(true);
    if (!company?.id) {
      setNotificationLoading(false);
      return;
    }
    const { data, error: nErr } = await supabase
      .from("notification_settings")
      .select("recipient_email, sender_email")
      .eq("company_id", company.id)
      .maybeSingle();
    if (!nErr && data) {
      setNotificationEmail(data.recipient_email ?? "");
      setNotificationSenderEmail(data.sender_email ?? "info@techxserve.com");
    }
    setNotificationLoading(false);
  };

  const saveNotificationSettings = async () => {
    setNotificationSaving(true);
    setNotificationError(null);
    setNotificationMessage(null);
    try {
      const companyId = company?.id;
      if (!companyId) throw new Error("No company selected — cannot save notification settings.");
      const trimmed = notificationEmail.trim();
      // Upsert keyed by company_id so we don't depend on selecting the row first
      // (which silently no-ops under some RLS edge cases).
      const { error: upErr } = await supabase
        .from("notification_settings")
        .upsert(
          {
            company_id: companyId,
            recipient_email: trimmed || null,
            sender_email: notificationSenderEmail.trim() || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "company_id" },
        );
      if (upErr) throw upErr;
      setNotificationSavedAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setNotificationError(e?.message ?? String(e));
    } finally {
      setNotificationSaving(false);
    }
  };

  const sendTestEmail = async () => {
    setNotificationTesting(true);
    setNotificationError(null);
    setNotificationMessage(null);
    try {
      const recipient = notificationEmail.trim();
      if (!recipient) throw new Error("Enter a recipient email first.");
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error("Not signed in — refresh the page and try again.");
      const url = `${(import.meta as any).env.VITE_SUPABASE_URL}/functions/v1/send-compliance-alerts?test=1`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          apikey: (import.meta as any).env.VITE_SUPABASE_ANON_KEY,
        },
        // Sending the recipient and from in the body lets the test work even if
        // the user hasn't clicked Save yet — they just type and hit "Send test email".
        body: JSON.stringify({
          recipient,
          from: notificationSenderEmail.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body?.error?.message ?? body?.error ?? `HTTP ${res.status}`;
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      setNotificationMessage(
        `Test email sent to ${body?.recipient ?? recipient}. Check inbox / spam.`
      );
    } catch (e: any) {
      setNotificationError(e?.message ?? String(e));
    } finally {
      setNotificationTesting(false);
    }
  };

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [empRes, locRes, cliRes, brRes] = await Promise.all([
      supabase.from("employees").select("location_id, client_id, branch_id"),
      supabase.from("locations").select("id, name").order("name"),
      supabase
        .from("clients")
        .select("id, client_code, name, email, phone, allowed_leaves_per_month, client_type, leave_carry_forward, eobi_enabled, eobi_amount, branch_id, auto_invoice_enabled, auto_invoice_amount, auto_invoice_withholding, contract_start, contract_end, advance_payment, contract_drive_file_id, contract_drive_view_url, contract_file_name")
        .order("client_code"),
      supabase
        .from("branches")
        .select("id, name, is_head_office")
        .order("is_head_office", { ascending: false })
        .order("name"),
    ]);

    const locCounts: Record<string, number> = {};
    const cliCounts: Record<string, number> = {};
    const brCounts: Record<string, number> = {};
    (empRes.data ?? []).forEach((e: any) => {
      if (e.location_id) locCounts[e.location_id] = (locCounts[e.location_id] ?? 0) + 1;
      if (e.client_id) cliCounts[e.client_id] = (cliCounts[e.client_id] ?? 0) + 1;
      if (e.branch_id) brCounts[e.branch_id] = (brCounts[e.branch_id] ?? 0) + 1;
    });
    setBranches(
      (brRes.data ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        is_head_office: !!r.is_head_office,
        employees: brCounts[r.id] ?? 0,
      })),
    );

    if (locRes.error) setError(locRes.error.message);
    if (cliRes.error) setError(cliRes.error.message);

    setLocations(
      (locRes.data ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        employees: locCounts[r.id] ?? 0,
      }))
    );
    setClients(
      (cliRes.data ?? []).map((r: any) => ({
        id: r.id,
        client_code: r.client_code,
        name: r.name,
        email: r.email,
        phone: r.phone,
        allowed_leaves_per_month: Number(r.allowed_leaves_per_month ?? 0),
        client_type: (r.client_type ?? "security_services") as ClientType,
        leave_carry_forward: !!r.leave_carry_forward,
        eobi_enabled: !!r.eobi_enabled,
        eobi_amount: Number(r.eobi_amount ?? 0),
        branch_id: r.branch_id ?? null,
        auto_invoice_enabled: !!r.auto_invoice_enabled,
        auto_invoice_amount: Number(r.auto_invoice_amount ?? 0),
        auto_invoice_withholding: Number(r.auto_invoice_withholding ?? 0),
        contract_start: r.contract_start ?? null,
        contract_end: r.contract_end ?? null,
        advance_payment: !!r.advance_payment,
        contract_drive_file_id: r.contract_drive_file_id ?? null,
        contract_drive_view_url: r.contract_drive_view_url ?? null,
        contract_file_name: r.contract_file_name ?? null,
        employees: cliCounts[r.id] ?? 0,
      }))
    );

    setLoading(false);
  };

  useEffect(() => {
    loadAll();
    loadNotificationSettings();
  }, []);

  const handleAddLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLocName.trim()) return;
    setSubmitting(true);
    setError(null);
    const { error: insErr } = await supabase.from("locations").insert({ name: newLocName.trim() });
    setSubmitting(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setNewLocName("");
    setLocAddOpen(false);
    await loadAll();
  };

  const handleSaveLocationEdit = async (id: string) => {
    if (!locEditingName.trim()) return;
    const { error: upErr } = await supabase
      .from("locations")
      .update({ name: locEditingName.trim() })
      .eq("id", id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setLocEditingId(null);
    setLocEditingName("");
    await loadAll();
  };

  const handleDeleteLocation = async (row: LocationRow) => {
    const msg =
      row.employees > 0
        ? `Delete "${row.name}"? ${row.employees} employee${row.employees === 1 ? "" : "s"} assigned to this location will have their location cleared.`
        : `Delete "${row.name}"?`;
    if (!window.confirm(msg)) return;
    const { error: delErr } = await supabase.from("locations").delete().eq("id", row.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const handleAddClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClientName.trim()) return;
    setSubmitting(true);
    setError(null);
    const { error: insErr } = await supabase.from("clients").insert({
      name: newClientName.trim(),
      email: newClientEmail.trim() || null,
      phone: newClientPhone.trim() || null,
      allowed_leaves_per_month: Math.max(0, Math.floor(Number(newClientAllowedLeaves) || 0)),
      client_type: newClientType,
      leave_carry_forward: newClientCarry,
      eobi_enabled: newClientEobiOn,
      eobi_amount: newClientEobiOn ? Math.max(0, Number(newClientEobiAmt) || 0) : 0,
      branch_id: newClientBranchId || null,
      auto_invoice_enabled: newClientAutoInv,
      auto_invoice_amount: newClientAutoInv ? Math.max(0, Number(newClientAutoAmt) || 0) : 0,
      auto_invoice_withholding: newClientAutoInv ? Math.max(0, Number(newClientAutoWht) || 0) : 0,
      contract_start: newClientContractStart || null,
      contract_end: newClientContractEnd || null,
      advance_payment: newClientAdvancePayment,
    });
    setSubmitting(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setNewClientName("");
    setNewClientEmail("");
    setNewClientPhone("");
    setNewClientAllowedLeaves(0);
    setNewClientType("security_services");
    setNewClientCarry(false);
    setNewClientEobiOn(false);
    setNewClientEobiAmt(0);
    setNewClientBranchId("");
    setNewClientAutoInv(false);
    setNewClientAutoAmt(0);
    setNewClientAutoWht(0);
    setNewClientContractStart("");
    setNewClientContractEnd("");
    setNewClientAdvancePayment(false);
    setClientAddOpen(false);
    await loadAll();
  };

  const openClientEdit = (row: ClientRow) => {
    setClientEditingId(row.id);
    setEditClientName(row.name);
    setEditClientEmail(row.email ?? "");
    setEditClientPhone(row.phone ?? "");
    setEditClientAllowedLeaves(row.allowed_leaves_per_month ?? 0);
    setEditClientType(row.client_type ?? "security_services");
    setEditClientCarry(!!row.leave_carry_forward);
    setEditClientEobiOn(!!row.eobi_enabled);
    setEditClientEobiAmt(Number(row.eobi_amount ?? 0));
    setEditClientBranchId(row.branch_id ?? "");
    setEditClientAutoInv(!!row.auto_invoice_enabled);
    setEditClientAutoAmt(Number(row.auto_invoice_amount ?? 0));
    setEditClientAutoWht(Number(row.auto_invoice_withholding ?? 0));
    setEditClientContractStart(row.contract_start ?? "");
    setEditClientContractEnd(row.contract_end ?? "");
    setEditClientAdvancePayment(!!row.advance_payment);
  };

  const handleSaveClientEdit = async (id: string) => {
    if (!editClientName.trim()) return;
    const { error: upErr } = await supabase
      .from("clients")
      .update({
        name: editClientName.trim(),
        email: editClientEmail.trim() || null,
        phone: editClientPhone.trim() || null,
        allowed_leaves_per_month: Math.max(0, Math.floor(Number(editClientAllowedLeaves) || 0)),
        client_type: editClientType,
        leave_carry_forward: editClientCarry,
        eobi_enabled: editClientEobiOn,
        eobi_amount: editClientEobiOn ? Math.max(0, Number(editClientEobiAmt) || 0) : 0,
        branch_id: editClientBranchId || null,
        auto_invoice_enabled: editClientAutoInv,
        auto_invoice_amount: editClientAutoInv ? Math.max(0, Number(editClientAutoAmt) || 0) : 0,
        auto_invoice_withholding: editClientAutoInv ? Math.max(0, Number(editClientAutoWht) || 0) : 0,
        contract_start: editClientContractStart || null,
        contract_end: editClientContractEnd || null,
        advance_payment: editClientAdvancePayment,
      })
      .eq("id", id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setClientEditingId(null);
    await loadAll();
  };

  // Upload (or replace) the contract document for a client. The file is stored
  // on Google Drive under <Company>/Contracts/<code> - <name>/, and the file
  // ID + view URL are persisted on the clients row. Replacing an existing
  // contract deletes the previous Drive file so we don't accumulate orphans.
  const uploadContract = async (row: ClientRow, file: File) => {
    // SSA users have profile.company_id = null but get the active company via
    // view_as_company. Use whichever ID actually backs the loaded `company`.
    const effectiveCompanyId =
      profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!effectiveCompanyId || !company?.name) {
      setContractError("Company not loaded — refresh and try again.");
      return;
    }
    setContractUploadingId(row.id);
    setContractError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("category", "contracts");
      form.append("company_id", effectiveCompanyId);
      form.append("company_name", company.name);
      form.append("entity_id", row.id);
      form.append("entity_code", row.client_code);
      form.append("entity_name", row.name);

      const { data, error: fnErr } = await supabase.functions.invoke("gdrive-upload", {
        body: form,
      });
      if (fnErr) {
        // Surface the actual error body from the function rather than the
        // generic "non-2xx" wrapper that supabase-js returns.
        let detail = fnErr.message;
        const ctx = (fnErr as { context?: Response }).context;
        if (ctx) {
          try { detail = (await ctx.clone().json())?.error ?? detail; } catch { /* ignore */ }
        }
        throw new Error(detail);
      }
      const result = data as { drive_file_id: string; drive_view_url: string; file_name: string };

      // Delete the old file (if any) only after the new upload succeeds, so a
      // failed re-upload doesn't leave the client with no contract.
      const previousFileId = row.contract_drive_file_id;

      const { error: upErr } = await supabase
        .from("clients")
        .update({
          contract_drive_file_id: result.drive_file_id,
          contract_drive_view_url: result.drive_view_url,
          contract_file_name: result.file_name,
        })
        .eq("id", row.id);
      if (upErr) throw upErr;

      if (previousFileId) {
        await supabase.functions
          .invoke("gdrive-delete", { body: { drive_file_id: previousFileId } })
          .catch(() => { /* best effort — file may already be gone */ });
      }
      await loadAll();
    } catch (e: any) {
      setContractError(e?.message ?? String(e));
    } finally {
      setContractUploadingId(null);
    }
  };

  const removeContract = async (row: ClientRow) => {
    if (!row.contract_drive_file_id) return;
    setContractUploadingId(row.id);
    setContractError(null);
    try {
      await supabase.functions
        .invoke("gdrive-delete", { body: { drive_file_id: row.contract_drive_file_id } })
        .catch(() => { /* idempotent */ });
      const { error: upErr } = await supabase
        .from("clients")
        .update({
          contract_drive_file_id: null,
          contract_drive_view_url: null,
          contract_file_name: null,
        })
        .eq("id", row.id);
      if (upErr) throw upErr;
      await loadAll();
    } catch (e: any) {
      setContractError(e?.message ?? String(e));
    } finally {
      setContractUploadingId(null);
    }
  };

  const openRenewModal = async (row: ClientRow) => {
    setRenewClient(row);
    setRenewStart("");
    setRenewEnd("");
    setRenewNotes("");
    setRenewHistory([]);
    // Fetch history for this client (most recent first).
    const { data: hist } = await supabase
      .from("client_contract_history")
      .select("id, contract_start, contract_end, notes, renewed_at")
      .eq("client_id", row.id)
      .order("renewed_at", { ascending: false })
      .limit(10);
    setRenewHistory((hist ?? []) as typeof renewHistory);
  };

  const handleSubmitRenew = async () => {
    if (!renewClient) return;
    if (!renewStart || !renewEnd) {
      setError("Pick both a new start and end date for the renewal.");
      return;
    }
    if (renewEnd < renewStart) {
      setError("Contract end must be on or after the contract start.");
      return;
    }
    setRenewSubmitting(true);
    try {
      // Snapshot the current contract period to history (if there is one).
      if (renewClient.contract_start || renewClient.contract_end) {
        const { error: histErr } = await supabase.from("client_contract_history").insert({
          client_id: renewClient.id,
          contract_start: renewClient.contract_start,
          contract_end: renewClient.contract_end,
          notes: renewNotes.trim() || null,
        });
        if (histErr) throw histErr;
      }
      // Update client with new dates.
      const { error: upErr } = await supabase
        .from("clients")
        .update({ contract_start: renewStart, contract_end: renewEnd })
        .eq("id", renewClient.id);
      if (upErr) throw upErr;
      setRenewClient(null);
      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRenewSubmitting(false);
    }
  };

  const handleDeleteClient = async (row: ClientRow) => {
    const msg =
      row.employees > 0
        ? `Delete "${row.name}"? ${row.employees} employee${row.employees === 1 ? "" : "s"} assigned to this client will have their client cleared.`
        : `Delete "${row.name}"?`;
    if (!window.confirm(msg)) return;
    const { error: delErr } = await supabase.from("clients").delete().eq("id", row.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const renderLocations = () => (
    <div className="bg-white rounded-lg border border-slate-200 p-4 md:p-6">
      <div className="flex items-center justify-between gap-3 mb-6">
        <h3 className="text-base text-slate-900">Location Management</h3>
        <Button variant="primary" size="sm" onClick={() => setLocAddOpen(true)} className="whitespace-nowrap flex-shrink-0">
          <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
          Add Location
        </Button>
      </div>
      {/* Same scroll behaviour as Regional Management, so a long list can't push the
          rest of the page down. */}
      <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-1">
        {loading && (
          <div className="text-sm text-slate-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {!loading && locations.length === 0 && (
          <p className="text-sm text-slate-500">No locations yet. Add one to get started.</p>
        )}
        {!loading &&
          locations.map((row) => (
            <div
              key={row.id}
              className="p-4 border border-slate-200 rounded-lg flex items-center justify-between"
            >
              {locEditingId === row.id ? (
                <>
                  <input
                    autoFocus
                    value={locEditingName}
                    onChange={(e) => setLocEditingName(e.target.value)}
                    className="flex-1 mr-3 px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" onClick={() => handleSaveLocationEdit(row.id)}>
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setLocEditingId(null);
                        setLocEditingName("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <p className="text-sm text-slate-900">{row.name}</p>
                    <p className="text-xs text-slate-500 mt-1">{row.employees} employees</p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setLocEditingId(row.id);
                        setLocEditingName(row.name);
                      }}
                    >
                      Edit
                    </Button>
                    <button
                      type="button"
                      onClick={() => handleDeleteLocation(row)}
                      className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-danger-700 hover:bg-danger-50"
                      title="Delete location"
                    >
                      <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
      </div>
    </div>
  );

  const handleAddBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBranchName.trim()) return;
    setBranchSubmitting(true);
    setError(null);
    const { error: insErr } = await supabase.from("branches").insert({ name: newBranchName.trim() });
    setBranchSubmitting(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setNewBranchName("");
    setBranchAddOpen(false);
    await loadAll();
  };

  // Rename a region. Head Office is renameable too — only its deletion is blocked.
  const handleSaveBranchEdit = async (id: string) => {
    if (!branchEditingName.trim()) return;
    const { error: upErr } = await supabase
      .from("branches")
      .update({ name: branchEditingName.trim() })
      .eq("id", id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setBranchEditingId(null);
    setBranchEditingName("");
    await loadAll();
  };

  const handleDeleteBranch = async (b: BranchRow) => {
    if (b.is_head_office) {
      setError("Head Office cannot be deleted.");
      return;
    }
    if (b.employees > 0) {
      if (!window.confirm(`Delete "${b.name}"? ${b.employees} employee(s) are assigned to this branch and will be moved to Head Office.`)) return;
    } else if (!window.confirm(`Delete "${b.name}"?`)) {
      return;
    }
    // Move dependents to Head Office before delete (FK is on delete set null,
    // so they'd otherwise become unassigned).
    const head = branches.find((x) => x.is_head_office);
    if (head) {
      await supabase.from("employees").update({ branch_id: head.id }).eq("branch_id", b.id);
      await supabase.from("clients").update({ branch_id: head.id }).eq("branch_id", b.id);
    }
    const { error: delErr } = await supabase.from("branches").delete().eq("id", b.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const renderBranches = () => (
    <div className="bg-white rounded-lg border border-slate-200 p-4 md:p-6">
      <div className="flex items-center justify-between gap-3 mb-6">
        <h3 className="text-base text-slate-900">Regional Management</h3>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setBranchAddOpen(true)}
          className="whitespace-nowrap flex-shrink-0"
        >
          <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
          Add Region
        </Button>
      </div>
      <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-1">
        {loading && (
          <div className="text-sm text-slate-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {!loading && branches.map((b) => (
          <div
            key={b.id}
            className="p-4 border border-slate-200 rounded-lg flex items-center justify-between gap-3"
          >
            {branchEditingId === b.id ? (
              <>
                <input
                  autoFocus
                  value={branchEditingName}
                  onChange={(e) => setBranchEditingName(e.target.value)}
                  className="flex-1 mr-3 px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => handleSaveBranchEdit(b.id)}>
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setBranchEditingId(null);
                      setBranchEditingName("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-900">{b.name}</span>
                    {b.is_head_office && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 text-[11px]">
                        Default
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{b.employees} employees</p>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setBranchEditingId(b.id);
                      setBranchEditingName(b.name);
                    }}
                  >
                    Edit
                  </Button>
                  {!b.is_head_office && (
                    <button
                      type="button"
                      onClick={() => handleDeleteBranch(b)}
                      className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-danger-700 hover:bg-danger-50"
                      title="Delete region"
                    >
                      <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <Header
        title="Settings"
        subtitle="Locations, regions and dashboard widgets"
      />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="mb-6">
          <CompanyProfileSection />
        </div>

        {canManageNotifications && (
          <div className="bg-white rounded-lg border border-slate-200 mb-6">
            <div className="p-6 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4 text-slate-600" strokeWidth={1.5} />
                <h2 className="text-base text-slate-900">Appearance</h2>
              </div>
              {themeSavedAt && (
                <span className="text-xs text-success-600">Saved at {themeSavedAt}</span>
              )}
            </div>
            <div className="p-6">
              <p className="text-xs text-slate-500 mb-4">
                Choose the accent color for {company?.name ?? "your company"}. This applies to
                every user in the company — sidebar highlights, primary buttons and badges.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {THEME_OPTIONS.map((opt) => {
                  const selected = themeKey === opt.key;
                  const busy = themeSaving === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => selectTheme(opt.key)}
                      disabled={!!themeSaving}
                      aria-pressed={selected}
                      className={`text-left rounded-lg border p-4 transition-colors disabled:cursor-not-allowed ${
                        selected
                          ? "border-brand-600 ring-2 ring-brand-200 bg-brand-50"
                          : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                      } ${themeSaving && !busy ? "opacity-60" : ""}`}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm text-slate-900">{opt.label}</span>
                        {busy ? (
                          <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                        ) : selected ? (
                          <Check className="w-4 h-4 text-brand-600" strokeWidth={2} />
                        ) : null}
                      </div>
                      <div className="flex gap-1.5 mb-2">
                        {[
                          opt.scale[700],
                          opt.scale[600],
                          opt.scale[500],
                          `color-mix(in srgb, ${opt.scale[500]} 42%, var(--surface-1))`,
                          `color-mix(in srgb, ${opt.scale[500]} 14%, var(--surface-1))`,
                        ].map((c, i) => (
                          <span
                            key={i}
                            className="h-6 flex-1 rounded"
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                      <p className="text-xs text-slate-500">{opt.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {renderLocations()}
          {renderBranches()}
        </div>

        <div className="bg-white rounded-lg border border-slate-200 mt-6">
          <div className="p-6 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <LayoutDashboard className="w-4 h-4 text-slate-600" strokeWidth={1.5} />
              <h2 className="text-base text-slate-900">Dashboard Widgets</h2>
            </div>
            <div className="flex items-center gap-3">
              {dashboardSavedAt && (
                <span className="text-xs text-success-600">Saved at {dashboardSavedAt}</span>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={saveDashboardWidgets}
                disabled={dashboardSaving}
              >
                {dashboardSaving && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
                Save
              </Button>
            </div>
          </div>
          <div className="p-6">
            <p className="text-xs text-slate-500 mb-4">
              Hide widgets you don't want on the dashboard. This applies to every user in your company.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {DASHBOARD_WIDGET_KEYS.map((key) => {
                const visible = !hiddenWidgets.has(key);
                return (
                  <label
                    key={key}
                    className="flex items-center gap-3 px-3 py-2 border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={() => toggleWidget(key)}
                      className="rounded border-slate-300"
                    />
                    <span className="text-sm text-slate-800">{DASHBOARD_WIDGET_LABELS[key]}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {canManageNotifications && (
          <div className="bg-white rounded-lg border border-slate-200 mt-6">
            <div className="p-6 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-slate-600" strokeWidth={1.5} />
                <h2 className="text-base text-slate-900">Notifications</h2>
              </div>
              <div className="flex items-center gap-3">
                {notificationSavedAt && (
                  <span className="text-xs text-success-600">Saved at {notificationSavedAt}</span>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={saveNotificationSettings}
                  disabled={notificationSaving || notificationLoading}
                >
                  {notificationSaving && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
                  Save
                </Button>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-xs text-slate-500">
                Compliance & contract-end alerts are emailed daily via Resend to the recipient below.
                The sender domain must be verified in your Resend account.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Recipient email</label>
                  <input
                    type="email"
                    value={notificationEmail}
                    onChange={(e) => setNotificationEmail(e.target.value)}
                    disabled={notificationLoading}
                    className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent disabled:bg-slate-50"
                    placeholder="alerts@example.com"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Sender email</label>
                  {/* Locked: the sending address is tied to the verified mail domain, so it
                      is shown for reference but never edited from the UI. Saving still
                      round-trips the stored value, leaving it unchanged. */}
                  <input
                    type="email"
                    value={notificationSenderEmail}
                    readOnly
                    aria-readonly="true"
                    tabIndex={-1}
                    className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm bg-slate-50 text-slate-600 cursor-not-allowed focus:outline-none"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Managed by your administrator — contact support to change the sending address.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={sendTestEmail}
                  disabled={notificationTesting || !notificationEmail.trim()}
                >
                  {notificationTesting ? (
                    <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5 mr-2" strokeWidth={1.5} />
                  )}
                  Send test email
                </Button>
                {notificationMessage && (
                  <span className="text-xs text-success-700">{notificationMessage}</span>
                )}
                {notificationError && (
                  <span className="text-xs text-danger-700">{notificationError}</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <Modal
        isOpen={locAddOpen}
        onClose={() => {
          setLocAddOpen(false);
          setNewLocName("");
        }}
        title="Add Location"
        size="sm"
      >
        <form className="space-y-4" onSubmit={handleAddLocation}>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Location Name</label>
            <input
              required
              autoFocus
              type="text"
              value={newLocName}
              onChange={(e) => setNewLocName(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="e.g., F-10 Islamabad"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting ? "Saving…" : "Add Location"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setLocAddOpen(false);
                setNewLocName("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={branchAddOpen}
        onClose={() => {
          setBranchAddOpen(false);
          setNewBranchName("");
        }}
        title="Add Region"
        size="sm"
      >
        <form className="space-y-4" onSubmit={handleAddBranch}>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Region Name *</label>
            <input
              required
              autoFocus
              type="text"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder="e.g. Lahore HQ"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
            <p className="text-xs text-slate-500 mt-1">
              Clients and employees can be assigned to this branch. Users created with this branch
              will only see their branch's data.
            </p>
          </div>
          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" variant="primary" size="md" className="flex-1" disabled={branchSubmitting}>
              {branchSubmitting ? "Saving…" : "Add Branch"}
            </Button>
            <Button type="button" variant="secondary" size="md" onClick={() => setBranchAddOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

    </>
  );
}

// Item 6: Company Profile — name, legal address, tax/NTN, currency, fiscal year
// start and logo. Saved via the update_company_profile RPC (super_admin / SSA).
// Per-user "Company Profile" — logo, company name, email and username live on
// the signed-in user's own profile row (self_update RLS). They only change what
// THIS user sees in the app shell; the company record and other users are
// unaffected. The logo is the same per-user image as the sidebar avatar.
function CompanyProfileSection() {
  const { profile, refreshProfile } = useAuth();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!profile) return;
    setUsername(profile.full_name ?? "");
    setEmail(profile.email ?? "");
    setCompanyName(profile.display_company_name ?? "");
    setLogoUrl(profile.avatar_url ?? null);
  }, [profile]);

  const onPickLogo = (file: File) => {
    if (file.size > 512 * 1024) {
      setErr("Please choose an image under 512 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoUrl(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    setErr(null);
    const { error: upErr } = await supabase
      .from("profiles")
      .update({
        full_name: username.trim() || null,
        email: email.trim() || null,
        display_company_name: companyName.trim() || null,
        avatar_url: logoUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", profile.id);
    setSaving(false);
    if (upErr) {
      setErr(upErr.message);
      return;
    }
    setSavedAt(new Date().toLocaleTimeString());
    await refreshProfile();
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200">
      <div className="p-6 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="w-4 h-4 text-slate-600" strokeWidth={1.5} />
          <h2 className="text-base text-slate-900">Company Profile</h2>
        </div>
        <div className="flex items-center gap-3">
          {savedAt && <span className="text-xs text-success-600">Saved at {savedAt}</span>}
          <Button variant="primary" size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
      <div className="p-6 space-y-4">
        <p className="text-xs text-slate-500">
          Personal display only — these change what you see in the app and don't affect the
          company record or other users.
        </p>
        {err && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{err}</div>
            <button onClick={() => setErr(null)}><X className="w-4 h-4" /></button>
          </div>
        )}
        <div className="flex items-center gap-4 pb-4 border-b border-slate-200">
          <div className="h-16 w-16 rounded-lg overflow-hidden bg-slate-50 border border-slate-200 flex items-center justify-center">
            {logoUrl ? (
              <img src={logoUrl} alt="Logo" className="h-full w-full object-contain" />
            ) : (
              <Building2 className="w-6 h-6 text-slate-300" />
            )}
          </div>
          <div>
            <p className="text-sm text-slate-900">Logo</p>
            <p className="text-xs text-slate-500 mb-2">Shown in your sidebar.</p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPickLogo(f);
                e.target.value = "";
              }}
            />
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                Upload Logo
              </Button>
              {logoUrl && (
                <button onClick={() => setLogoUrl(null)} className="text-xs text-danger-600 hover:underline">
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className="block text-xs text-slate-500 mb-1">Company Name</label>
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="How the company name appears to you"
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Your name"
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">User Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
            <p className="text-[10px] text-slate-500 mt-1">Display only — does not change your sign-in email.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
