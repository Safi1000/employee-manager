// Edge function: comment-mail (0606)
//
// Sends the mail a comment owes. Every comment_messages insert queues one
// comment_mail_log row per person in the thread other than the author, then
// wakes this function (invoke_comment_mail); pg_cron wakes it again every 10
// minutes while anything is pending or failed. The row is the record — this
// function only reads what is owed, sends it, and marks each row sent, failed
// (with the reason, retried up to 5 times) or no_address.
//
// The mail says what the comment is about — the record's label, written by the
// database from the record itself — who wrote, what they wrote, and links to
// the thread. Recipients are the tagged people and the starter; nobody else.
//
// Service role only: called by pg_net and pg_cron, never by a browser.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isServiceRole, serviceClient } from "../_shared/caller.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const APP_URL = Deno.env.get("APP_URL") ?? "https://bastion.techxserve.com";
const DEFAULT_SENDER = "Bastion <onboarding@resend.dev>";
const MAX_ATTEMPTS = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Row = {
  id: string;
  attempts: number;
  recipient: { id: string; email: string | null; task_alert_email: string | null; full_name: string | null } | null;
  message: {
    id: string;
    body: string;
    created_at: string;
    author: { full_name: string | null; email: string | null } | null;
    thread: { id: string; company_id: string; record_label: string; record_path: string; created_by: string } | null;
  } | null;
};

async function send(args: { to: string; from: string; subject: string; html: string }) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY secret is not set.");
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!isServiceRole(req)) return json({ error: "unauthorized" }, 401);
  const db = serviceClient();

  const { data, error } = await db
    .from("comment_mail_log")
    .select(`id, attempts,
      recipient:recipient_id(id, email, task_alert_email, full_name),
      message:message_id(id, body, created_at,
        author:author_id(full_name, email),
        thread:thread_id(id, company_id, record_label, record_path, created_by))`)
    .or(`status.eq.pending,and(status.eq.failed,attempts.lt.${MAX_ATTEMPTS})`)
    .order("created_at")
    .limit(100);
  if (error) return json({ error: error.message }, 500);

  const senderFor = new Map<string, string>();
  const sender = async (companyId: string) => {
    if (!senderFor.has(companyId)) {
      const { data: ns } = await db.from("notification_settings").select("sender_email").eq("company_id", companyId).maybeSingle();
      senderFor.set(companyId, ns?.sender_email?.trim() || DEFAULT_SENDER);
    }
    return senderFor.get(companyId)!;
  };

  let sent = 0, failed = 0, noAddress = 0;
  for (const r of (data ?? []) as unknown as Row[]) {
    const m = r.message, t = m?.thread, to = (r.recipient?.task_alert_email?.trim() || r.recipient?.email?.trim()) ?? "";
    if (!m || !t) continue;
    if (!to) {
      await db.from("comment_mail_log").update({ status: "no_address", attempts: r.attempts + 1 }).eq("id", r.id);
      noAddress++;
      continue;
    }
    const who = m.author?.full_name || m.author?.email || "Someone";
    // The thread's opening message tags people in; anything after it is a reply.
    const { count: earlier } = await db.from("comment_messages").select("id", { count: "exact", head: true })
      .eq("thread_id", t.id).lt("created_at", m.created_at);
    const isFirst = (earlier ?? 0) === 0;
    const threadUrl = `${APP_URL}/app/comments?thread=${t.id}`;
    const recordUrl = `${APP_URL}${t.record_path}`;
    const subject = `${who} ${isFirst ? "tagged you" : "replied"}: ${t.record_label}`.slice(0, 180);
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;">
      <p style="margin:0 0 6px;color:#64748b;font-size:12px;">About</p>
      <p style="margin:0 0 14px;font-size:14px;font-weight:600;color:#0f172a;">${esc(t.record_label)}</p>
      <div style="border-left:3px solid #cbd5e1;padding:8px 12px;margin:0 0 14px;background:#f8fafc;">
        <p style="margin:0 0 4px;font-size:12px;color:#64748b;">${esc(who)} wrote</p>
        <p style="margin:0;font-size:14px;color:#0f172a;white-space:pre-wrap;">${esc(m.body)}</p>
      </div>
      <p style="margin:0 0 6px;"><a href="${esc(threadUrl)}" style="color:#1d4ed8;font-size:14px;">Reply in Bastion</a>
        &nbsp;·&nbsp;<a href="${esc(recordUrl)}" style="color:#1d4ed8;font-size:14px;">Open the record</a></p>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:11px;">Only the people tagged in this conversation can see it.</p>
    </div>`;
    try {
      await send({ to, from: await sender(t.company_id), subject, html });
      await db.from("comment_mail_log").update({ status: "sent", email: to, sent_at: new Date().toISOString(), attempts: r.attempts + 1, error: null }).eq("id", r.id);
      sent++;
    } catch (e) {
      await db.from("comment_mail_log").update({ status: "failed", email: to, attempts: r.attempts + 1, error: (e as Error).message.slice(0, 500) }).eq("id", r.id);
      failed++;
    }
  }
  return json({ sent, failed, no_address: noAddress });
});
