// Edge function: send-compliance-alerts
// Sends a compliance / contract-end alert digest via Resend.
//
// Two modes:
//   ?test=1  — called from Settings UI with the user's JWT. Targets that user's
//              company, sends a test email even if there are zero real alerts
//              today (so the recipient can verify Resend is wired up).
//   (cron)   — called daily by pg_cron with the service-role key. Iterates
//              every company that has a recipient_email configured and only
//              sends when there is at least one alert to surface.
//
// Alert sources:
//   1. important_dates where (due_date - today) <= advance_notice_days
//      (mirrors what Compliance.tsx renders as active alerts). Identical rows
//      are collapsed — the same review is often stored several times with
//      different notice windows, which would otherwise repeat in the digest.
//   2. contracts.end_date at or under 14 / 7 / 3 / 1 days out, once per threshold
//      (recorded in compliance_alert_log so a missed run still catches up).
//      An already-overdue active contract lands on the tightest threshold and is
//      announced there — it used to be filtered out for being in the past, which
//      is exactly backwards: past its end and still active is the urgent case.
//
// Source 2 used to read clients.contract_end. That column is unset on every
// client here, while the real end dates live on the contracts table — so the
// entire contract-end alert was dead and had never fired for anyone.
//
// Email transport: Resend (https://resend.com). RESEND_API_KEY must be set.
// The `from` address must be on a domain verified in your Resend account —
// otherwise Resend will return a 403.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Days-out values that should trigger a contract-end alert: two weeks, one week,
// three days and one day before the contract ends. Must match CONTRACT_NOTICE_DAYS
// in Compliance.tsx, which renders the same windows in the calendar.
const CONTRACT_ALERT_DAYS = [14, 7, 3, 1];

// Fallback sender if the company has not set sender_email. Resend allows this
// address out of the box without domain verification — good for first run.
const DEFAULT_SENDER = "Employee Manager <onboarding@resend.dev>";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

type AlertItem = {
  title: string;
  category: string;
  daysRemaining: number;
  priority?: string | null;
  source: "important_date" | "contract_end";
};

/** A threshold notice that must be recorded — but only once the email is away. */
type AlertLogEntry = { alert_key: string; threshold: number };

type Collected = { alerts: AlertItem[]; toLog: AlertLogEntry[] };

async function getCallerProfile(jwt: string): Promise<{
  user_id: string;
  company_id: string | null;
  role: string | null;
} | null> {
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user) return null;
  const { data: profile } = await client
    .from("profiles")
    .select("company_id, role")
    .eq("id", data.user.id)
    .maybeSingle();
  return {
    user_id: data.user.id,
    company_id: (profile?.company_id as string | null) ?? null,
    role: (profile?.role as string | null) ?? null,
  };
}

/**
 * Does this Authorization header carry a service-role credential?
 *
 * Signature verification is the platform's job (verify_jwt is ON for this
 * function), so this only reads the role claim. It also accepts an exact match
 * against SUPABASE_SERVICE_ROLE_KEY, which covers key formats that are not JWTs
 * at all.
 */
function isServiceRole(authHeader: string | null): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7).trim();
  if (SUPABASE_SERVICE_ROLE_KEY && token === SUPABASE_SERVICE_ROLE_KEY) return true;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    // base64url → base64, padded.
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

function diffDaysUTC(target: string, today: string): number {
  // Treat both as UTC midnight to avoid DST off-by-one.
  const a = new Date(`${target}T00:00:00Z`).getTime();
  const b = new Date(`${today}T00:00:00Z`).getTime();
  return Math.round((a - b) / 86_400_000);
}

async function collectAlerts(
  db: SupabaseClient,
  companyId: string,
  today: string,
  /** Test runs must not consume a threshold, so they never read or write the log. */
  useLog = true,
): Promise<Collected> {
  const alerts: AlertItem[] = [];
  const toLog: AlertLogEntry[] = [];

  // ── 1. Compliance calendar ────────────────────────────────────────────────
  const { data: dates } = await db
    .from("important_dates")
    .select("title, due_date, category, priority, advance_notice_days")
    .eq("company_id", companyId)
    .gte("due_date", today);

  // Collapse duplicates. The same item is routinely entered several times with
  // different notice windows (one review here is stored four times at 30/15/7/1
  // days), and since every row whose window is open matches, the digest listed
  // it once, then twice, then three times as the date closed in. Keep one entry
  // per title+date, taking the WIDEST window so it still starts alerting on the
  // earliest of them.
  const byItem = new Map<string, { title: string; category: string; priority: string | null; days: number; window: number }>();
  for (const d of dates ?? []) {
    const title = d.title as string;
    const dueDate = d.due_date as string;
    const key = `${title.trim().toLowerCase()}|${dueDate}`;
    const days = diffDaysUTC(dueDate, today);
    const window = (d.advance_notice_days as number | null) ?? 7;
    const prev = byItem.get(key);
    if (!prev || window > prev.window) {
      byItem.set(key, {
        title,
        category: (d.category as string) ?? "General",
        priority: (d.priority as string | null) ?? prev?.priority ?? null,
        days,
        window: Math.max(window, prev?.window ?? 0),
      });
    }
  }
  for (const item of byItem.values()) {
    if (item.days <= item.window) {
      alerts.push({
        title: item.title,
        category: item.category,
        daysRemaining: item.days,
        priority: item.priority,
        source: "important_date",
      });
    }
  }

  // ── 2. Contracts approaching their end date ───────────────────────────────
  // Read the CONTRACT's own end_date. This used to read clients.contract_end,
  // which nobody populates — the alert had never fired once.
  const { data: contracts } = await db
    .from("contracts")
    .select("id, contract_code, end_date, is_infinite, status, clients:client_id(name)")
    .eq("company_id", companyId)
    .eq("status", "active")
    .not("end_date", "is", null);

  // Which thresholds have already been announced for this company.
  const alreadySent = new Set<string>();
  if (useLog) {
    const { data: logRows } = await db
      .from("compliance_alert_log")
      .select("alert_key, threshold")
      .eq("company_id", companyId);
    for (const r of logRows ?? []) alreadySent.add(`${r.alert_key}|${r.threshold}`);
  }

  for (const c of contracts ?? []) {
    // An open-ended contract has no end to warn about.
    if (c.is_infinite) continue;
    const endDate = c.end_date as string | null;
    if (!endDate) continue;
    const days = diffDaysUTC(endDate, today);

    // The tightest threshold this contract has reached. "At or under" rather
    // than "exactly", so a day the job did not run does not lose the notice.
    // An overdue contract (days < 0) is under every threshold and so lands on
    // the tightest one — announced once, then quiet.
    const threshold = [...CONTRACT_ALERT_DAYS].sort((a, b) => a - b).find((t) => days <= t);
    if (threshold === undefined) continue;

    const alertKey = `contract:${c.id}`;
    if (useLog && alreadySent.has(`${alertKey}|${threshold}`)) continue;

    const clientName = (c.clients as { name?: string } | null)?.name ?? "Client";
    const code = c.contract_code ? ` (${c.contract_code})` : "";
    alerts.push({
      title: `${clientName}${code} — contract ${days < 0 ? "expired" : "ending"}`,
      category: "Contract",
      daysRemaining: days,
      source: "contract_end",
    });
    if (useLog) toLog.push({ alert_key: alertKey, threshold });
  }

  // Most urgent first.
  alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
  return { alerts, toLog };
}

// Colours the "Due" cell to the same bands the calendar uses: 3 days or less
// (and anything overdue) is critical, a week out is a warning, wider is info.
function urgencyColor(days: number): string {
  if (days <= 3) return "#dc2626"; // danger
  if (days <= 7) return "#d97706"; // warning
  return "#2563eb"; // info
}

function dueLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days} days`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml(alerts: AlertItem[], today: string, isTest: boolean): string {
  const dateLabel = new Date(`${today}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  const rows = alerts
    .map((a) => {
      const color = urgencyColor(a.daysRemaining);
      const badge = a.source === "contract_end" ? "Contract" : escapeHtml(a.category);
      return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9">${escapeHtml(a.title)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;color:#475569;font-size:13px">${badge}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;color:${color};font-weight:600;white-space:nowrap">${dueLabel(a.daysRemaining)}</td>
      </tr>`;
    })
    .join("");

  const heading = isTest && alerts.length === 0
    ? "Compliance alerts — test email"
    : `Compliance digest — ${alerts.length} item${alerts.length === 1 ? "" : "s"}`;

  const body = alerts.length === 0
    ? `<p style="color:#475569">No alerts are due right now. This is a test message confirming Resend is wired up correctly.</p>`
    : `<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px">
         <thead>
           <tr style="background:#f8fafc;text-align:left">
             <th style="padding:10px 12px;border-bottom:2px solid #e2e8f0;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#64748b">Item</th>
             <th style="padding:10px 12px;border-bottom:2px solid #e2e8f0;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#64748b">Category</th>
             <th style="padding:10px 12px;border-bottom:2px solid #e2e8f0;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#64748b">Due</th>
           </tr>
         </thead>
         <tbody>${rows}</tbody>
       </table>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #e2e8f0">
      <h2 style="margin:0;font-size:18px;color:#0f172a">${escapeHtml(heading)}</h2>
      <p style="margin:4px 0 0;color:#64748b;font-size:13px">${escapeHtml(dateLabel)}</p>
    </div>
    <div style="padding:20px 24px">
      ${body}
    </div>
    <div style="padding:14px 24px;background:#f8fafc;color:#94a3b8;font-size:12px">
      Sent by Employee Manager · Change recipient in Settings → Notifications
    </div>
  </div>
</body></html>`;
}

async function sendViaResend(args: {
  to: string;
  from: string;
  subject: string;
  html: string;
}): Promise<{ id: string }> {
  if (!RESEND_API_KEY) {
    throw new Error(
      "RESEND_API_KEY secret is not set. Add it under Edge Functions → Secrets.",
    );
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend send failed (status ${resp.status}): ${text}`);
  }
  return (await resp.json()) as { id: string };
}

/**
 * Record what happened to a delivery attempt — on BOTH paths, success and
 * failure.
 *
 * This function's failures used to surface in the HTTP response and in
 * console.error, and this function is invoked by a cron job at 06:00 that
 * nobody reads. A run that threw every morning for a month looked exactly like
 * a run that had nothing to send. That is the project's core failure mode
 * wearing a new hat: a control reporting success while doing nothing.
 *
 * public.alert_delivery_gaps() reads this table and is wired into
 * ledger_checks() as `alert_delivery_is_healthy`, so a failed send is visible
 * to something that is itself checked (0300).
 *
 * The write must never throw. A bookkeeping failure must not turn a delivered
 * email into a reported error — the mail is already gone, and the caller's
 * result would then be a lie in the other direction.
 */
async function recordDelivery(
  db: SupabaseClient,
  row: {
    company_id: string;
    recipient: string | null;
    subject: string | null;
    status: "sent" | "failed" | "skipped";
    provider_id?: string | null;
    error?: string | null;
    item_count?: number;
  },
): Promise<void> {
  try {
    const { error } = await db.from("notification_deliveries").insert({
      channel: "email",
      item_count: 0,
      ...row,
    });
    if (error) {
      console.error(
        `notification_deliveries write failed company=${row.company_id}:`,
        error.message,
      );
    }
  } catch (e) {
    console.error("notification_deliveries write threw:", e);
  }
}

async function sendForCompany(
  db: SupabaseClient,
  companyId: string,
  today: string,
  isTest: boolean,
): Promise<{ sent: boolean; reason?: string; recipient?: string }> {
  const { data: ns } = await db
    .from("notification_settings")
    .select("recipient_email, sender_email")
    .eq("company_id", companyId)
    .maybeSingle();

  const recipient = ns?.recipient_email?.trim();
  if (!recipient) {
    // Not recorded: a company with no recipient has not asked for delivery, and
    // alert_delivery_gaps() deliberately does not report it. Writing a row here
    // would make every un-opted-in company look like a delivery problem.
    return { sent: false, reason: "No recipient email configured in Settings → Notifications." };
  }
  const sender = ns?.sender_email?.trim() || DEFAULT_SENDER;

  const { alerts, toLog } = await collectAlerts(db, companyId, today, !isTest);
  if (alerts.length === 0 && !isTest) {
    // 'skipped', NOT 'sent'. Nothing was due, so nothing failed — but nothing
    // was delivered either, and recording this as a success would let a
    // permanently broken sender look healthy on any quiet day. skipped does not
    // satisfy the recency check in alert_delivery_gaps().
    await recordDelivery(db, {
      company_id: companyId,
      recipient,
      subject: null,
      status: "skipped",
      item_count: 0,
    });
    return { sent: false, reason: "No alerts due today." };
  }

  const subject = alerts.length === 0
    ? "[Test] Employee Manager compliance alerts"
    : `Compliance digest — ${alerts.length} item${alerts.length === 1 ? "" : "s"} due`;

  // PROVE THE SEND. sendViaResend throws on any non-2xx, so reaching the line
  // after it means the provider accepted the message and returned an id. The
  // failure path records the reason and rethrows, so the caller's behaviour is
  // unchanged and the evidence survives.
  let providerId: string | null = null;
  try {
    const res = await sendViaResend({
      to: recipient,
      from: sender,
      subject,
      html: buildEmailHtml(alerts, today, isTest),
    });
    providerId = res?.id ?? null;
  } catch (e) {
    await recordDelivery(db, {
      company_id: companyId,
      recipient,
      subject,
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      item_count: alerts.length,
    });
    throw e;
  }

  await recordDelivery(db, {
    company_id: companyId,
    recipient,
    subject,
    status: "sent",
    provider_id: providerId,
    item_count: alerts.length,
  });

  // Record the thresholds only now. Writing before the send would burn the
  // notice on an email that never left — and it is announced exactly once, so
  // there would be no second chance.
  if (toLog.length > 0) {
    const { error: logErr } = await db.from("compliance_alert_log").upsert(
      toLog.map((l) => ({ company_id: companyId, alert_key: l.alert_key, threshold: l.threshold, sent_on: today })),
      { onConflict: "company_id,alert_key,threshold" },
    );
    // The mail is already out; a failed bookkeeping write must not read as a
    // failed send. Worst case the notice repeats tomorrow.
    if (logErr) console.error(`compliance_alert_log write failed company=${companyId}:`, logErr.message);
  }

  return { sent: true, recipient };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const isTest = url.searchParams.get("test") === "1";

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const today = new Date().toISOString().slice(0, 10);

  // Test mode: send directly to the recipient passed in the body. Does NOT
  // read notification_settings — that way the test works the moment the user
  // types an email and clicks "Send test email", even before saving.
  // Restricted to super_admin / super_super_admin to prevent regular users
  // from using this as an open relay.
  if (isTest) {
    const authHeader = req.headers.get("Authorization");
    const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) return json({ error: "unauthorized" }, 401);

    const caller = await getCallerProfile(jwt);
    if (!caller) return json({ error: "invalid_token" }, 401);
    if (caller.role !== "super_admin" && caller.role !== "super_super_admin") {
      return json({ error: "forbidden_role" }, 403);
    }

    let body: { recipient?: string; from?: string } = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }

    const recipient = body.recipient?.trim();
    if (!recipient) {
      return json({ error: "recipient_required" }, 400);
    }
    const sender = body.from?.trim() || DEFAULT_SENDER;

    try {
      // Synthesize a small preview using the caller's company alerts (if any)
      // so the test email reflects what a real daily digest would look like.
      // useLog = false: a test must never consume a one-shot threshold, or
      // pressing "Send test" would silently cancel the real notice.
      const alerts = caller.company_id
        ? (await collectAlerts(db, caller.company_id, today, false)).alerts
        : [];
      const subject = alerts.length === 0
        ? "[Test] Employee Manager compliance alerts"
        : `[Test] Compliance digest — ${alerts.length} item${alerts.length === 1 ? "" : "s"}`;
      const res = await sendViaResend({
        to: recipient,
        from: sender,
        subject,
        html: buildEmailHtml(alerts, today, true),
      });
      // A test send is a real send: it proves the transport works, so it counts
      // as evidence of delivery health for that company.
      if (caller.company_id) {
        await recordDelivery(db, {
          company_id: caller.company_id,
          recipient,
          subject,
          status: "sent",
          provider_id: res?.id ?? null,
          item_count: alerts.length,
        });
      }
      return json({ sent: true, recipient, provider_id: res?.id ?? null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("send-compliance-alerts (test):", msg);
      if (caller.company_id) {
        await recordDelivery(db, {
          company_id: caller.company_id,
          recipient,
          subject: null,
          status: "failed",
          error: msg,
        });
      }
      return json({ error: msg }, 500);
    }
  }

  // Cron mode is service-role only. This path used to be open to any anonymous
  // POST — a nuisance at worst, since it can only mail the configured
  // recipient. It stopped being harmless once each threshold became a ONE-SHOT
  // notice: a stranger hitting this endpoint would mark contract warnings as
  // sent and the real digest would never arrive.
  //
  // The check is on the token's CLAIMS, not on a string match against
  // SUPABASE_SERVICE_ROLE_KEY. Both are legitimate service-role credentials but
  // they are different strings — the env var carries the project's current key
  // format while the cron job signs with the legacy JWT held in Vault, so
  // comparing them rejected the real cron call. The function is deployed with
  // verify_jwt ON, so the platform has already checked the signature before we
  // get here; reading the payload is therefore safe, and all that is left is to
  // confirm the role.
  if (!isServiceRole(req.headers.get("Authorization"))) {
    return json({ error: "unauthorized" }, 401);
  }

  // Iterate every company that has a recipient configured.
  const { data: configured, error: cfgErr } = await db
    .from("notification_settings")
    .select("company_id")
    .not("recipient_email", "is", null);
  if (cfgErr) {
    return json({ error: cfgErr.message }, 500);
  }

  const results: Array<{
    company_id: string;
    sent: boolean;
    reason?: string;
    recipient?: string;
    error?: string;
  }> = [];

  for (const row of configured ?? []) {
    const companyId = row.company_id as string;
    try {
      const r = await sendForCompany(db, companyId, today, false);
      results.push({ company_id: companyId, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`send-compliance-alerts company=${companyId}:`, msg);
      results.push({ company_id: companyId, sent: false, error: msg });
    }
  }

  return json({ ok: true, count: results.length, results });
});
