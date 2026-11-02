import { supabase } from "./supabase";

/**
 * FOLLOW-UP UPDATES AND INVOICES (0634) — one reading shared by the Payment
 * Follow-up screen, its PDF and Excel export, and the Finance Report's
 * follow-up section, so none of them can tell a different story.
 * Amounts arrive NULL for a login without finance keys; nothing here fills them.
 */
export type FollowUpdates = {
  from: string; to: string;
  payments: { client_id: string; client: string; branch_id: string | null; on: string; mode: string | null; amount: number | null }[];
  contacts: { client_id: string; client: string; branch_id: string | null; on: string; channel: string; note: string; promised_by: string | null; promised_amount: number | null; next_step: string | null; by: string | null }[];
  steps_done: { client_id: string; client: string; branch_id: string | null; step: string; at: string; by: string | null }[];
  delivered: { client_id: string; client: string; branch_id: string | null; number: string; on: string; method: string; amount: number | null }[];
  promises_missed: { client_id: string; client: string; branch_id: string | null; promised_by: string; promised_amount: number | null }[];
  steps_due: { client_id: string; client: string; branch_id: string | null; step: string; due: string; who: string | null }[];
};
export type FollowInvoice = {
  client_id: string; client_name: string; branch_id: string | null; invoice_id: string | null; invoice_number: string | null; for_month: string; invoice_date: string | null;
  amount: number | null; delivered_on: string | null; delivered_method: string | null; missing: boolean;
};

export type Span = "today" | "yesterday" | "7d" | "month";
export const SPANS: [Span, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "Last 7 days"], ["month", "This month"]];
export function spanRange(s: Span): { from: string; to: string } {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date();
  if (s === "yesterday") { const y = new Date(start); y.setDate(y.getDate() - 1); return { from: y.toISOString(), to: start.toISOString() }; }
  if (s === "7d") start.setDate(start.getDate() - 7);
  if (s === "month") start.setDate(1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export async function loadFollowUpdates(from: string, to: string): Promise<FollowUpdates | null> {
  const { data, error } = await supabase.rpc("followup_updates", { p_from: from, p_to: to });
  return error ? null : (data as FollowUpdates);
}

/** Last month's invoices (or the month given), by client. */
export async function loadFollowInvoices(month?: string): Promise<Map<string, FollowInvoice[]>> {
  const { data } = await supabase.rpc("client_followup_invoices", month ? { p_month: month } : {});
  const m = new Map<string, FollowInvoice[]>();
  for (const r of (data ?? []) as FollowInvoice[]) m.set(r.client_id, [...(m.get(r.client_id) ?? []), { ...r, amount: r.amount == null ? null : Number(r.amount) }]);
  return m;
}

/** "bank_transfer" → "Bank transfer". */
export const modeLabel = (m: string | null) => (!m ? "" : m.charAt(0).toUpperCase() + m.slice(1).replace(/_/g, " "));
export const methodLabel = (m: string | null) =>
  !m ? "" : m === "hand" ? "by hand" : m === "whatsapp" ? "WhatsApp" : m === "portal" ? "client portal" : m;
const dshort = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
export const monthShort = (iso: string | null | undefined) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { month: "short" }) : "");

/** "Delivered 2 Nov, by hand" / "Not delivered" / "No invoice" / "" when the client has no running contract. */
export function invoiceStatus(list: FollowInvoice[] | undefined): { text: string; tone: "ok" | "warn" | "none" } {
  if (!list?.length) return { text: "", tone: "none" };
  if (list.every((x) => x.missing)) return { text: "No invoice", tone: "warn" };
  const inv = list.filter((x) => !x.missing);
  const open = inv.filter((x) => !x.delivered_on);
  if (open.length) return { text: inv.length > 1 ? `${open.length} of ${inv.length} not delivered` : "Not delivered", tone: "warn" };
  const last = inv.map((x) => x.delivered_on!).sort().pop()!;
  const how = [...new Set(inv.map((x) => methodLabel(x.delivered_method)))].join(", ");
  return { text: `Delivered ${dshort(last)}, ${how}`, tone: "ok" };
}

/** Clients whose invoice for the month is out but not delivered, and those with none. */
export function invoiceGaps(m: Map<string, FollowInvoice[]>, regionId: string | null = null) {
  const notDelivered: { client: string; number: string }[] = [];
  const missing: string[] = [];
  for (const list of m.values()) {
    for (const x of list) {
      if (regionId && x.branch_id !== regionId) continue;
      if (x.missing) missing.push(x.client_name);
      else if (!x.delivered_on) notDelivered.push({ client: x.client_name, number: x.invoice_number ?? "" });
    }
  }
  notDelivered.sort((a, b) => a.client.localeCompare(b.client));
  missing.sort();
  return { notDelivered, missing };
}
