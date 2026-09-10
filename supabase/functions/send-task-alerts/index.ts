// Edge function: send-task-alerts
//
// Two kinds of mail about the task board, both to the address the user set on
// the board themselves (`profiles.task_alert_email`):
//
//   1. ASSIGNMENT — a task now has an assignee who has not yet been told.
//   2. REMINDER   — an unfinished task's due date is 7 / 3 / 1 / 0 days out.
//
// Called daily by pg_cron with the service-role key, or with ?test=1 from a
// signed-in session to send the caller one sample of each kind they are owed.
//
// WHY NOTHING IS SENT FROM THE APP. The obvious place to announce an assignment
// is the moment the board saves one — and that is the one place it must not be,
// because a browser that closes between the UPDATE and the fetch has already
// committed the assignment and lost the notification, silently and with no
// record that anything was owed. The task row IS the record; this job reads it.
// A missed run therefore catches up on the next one instead of dropping mail,
// which is the whole reason the state lives in the database rather than in a
// callback.
//
// DE-DUPLICATION IS THE DATABASE'S JOB, not this file's. `task_alert_log` has a
// unique index on (task_id, alert_kind, recipient_email) — 0418 — so a second
// send is refused by Postgres, not by this code remembering to check. The
// insert happens BEFORE the send for exactly that reason: see the note on
// `claim` below. A daily job that re-sent "due in 3 days" every morning for
// three mornings would train everyone to ignore it, which costs more than
// missing it once.
//
// Email transport: Resend. RESEND_API_KEY must be set under Edge Functions →
// Secrets, and the `from` domain must be verified in the Resend account.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Days-out values that earn a reminder. 0 is "due today" and is included on
// purpose: the day itself is the one people most want to be told about, and a
// list that stops at 1 quietly treats the deadline as the day after.
const REMINDER_DAYS = [7, 3, 1, 0];

const DEFAULT_SENDER = "Task Board <onboarding@resend.dev>";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

type TaskRow = {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  due_date: string | null;
  assignee_id: string | null;
};

function shell(heading: string, accent: string, body: string) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;">
    <div style="background:${accent};padding:16px 20px;">
      <p style="margin:0;color:#ffffff;font-size:16px;">${esc(heading)}</p>
    </div>
    <div style="padding:20px;color:#0f172a;font-size:14px;line-height:1.6;">${body}</div>
    <div style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:11px;">
      You are receiving this because you set this address on your task board.
      Clear it there to stop these messages.
    </div>
  </div>
</body></html>`;
}

function taskBlock(task: TaskRow) {
  const rows: string[] = [];
  rows.push(`<p style="margin:0 0 8px;font-size:16px;">${esc(task.title)}</p>`);
  if (task.description) {
    rows.push(
      `<p style="margin:0 0 12px;color:#475569;white-space:pre-wrap;">${esc(task.description)}</p>`,
    );
  }
  const meta: string[] = [];
  if (task.priority) meta.push(`Priority: ${esc(task.priority)}`);
  if (task.due_date) meta.push(`Due: ${esc(fmtDate(task.due_date))}`);
  if (meta.length) {
    rows.push(`<p style="margin:0;color:#64748b;font-size:12px;">${meta.join(" &middot; ")}</p>`);
  }
  return `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:14px;">${rows.join("")}</div>`;
}

async function sendViaResend(args: { to: string; from: string; subject: string; html: string }) {
  if (!RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY secret is not set. Add it under Edge Functions → Secrets.");
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
    throw new Error(`Resend send failed (status ${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as { id: string };
}

/**
 * Reserve the right to send one alert, by writing the log row FIRST.
 *
 * The order matters and it is not the intuitive one. Send-then-log loses the
 * log row whenever the process dies between the two, and the next run sends the
 * same mail again — the failure mode is a duplicate, forever, every morning.
 * Log-then-send loses the MAIL when the send fails after the row lands, and the
 * failure mode is one missing message, once. Neither is free; the second is the
 * one you can live with, and it is the one a unique index can enforce.
 *
 * Returns false when the row already exists, which is the de-duplication
 * working rather than an error.
 */
async function claim(
  db: SupabaseClient,
  row: { company_id: string; task_id: string; alert_kind: string; recipient_email: string },
): Promise<boolean> {
  const { error } = await db.from("task_alert_log").insert(row);
  if (!error) return true;
  // 23505 = unique_violation: already sent. Anything else is a real fault and
  // must not be swallowed into "already sent", which would silence the whole
  // job the day the table changes shape.
  if ((error as { code?: string }).code === "23505") return false;
  throw new Error(`task_alert_log insert failed: ${error.message}`);
}

async function run(db: SupabaseClient, opts: { today: string; onlyUser?: string; isTest: boolean }) {
  const sent: { kind: string; task: string; to: string }[] = [];
  const skipped: string[] = [];
  const failed: { task: string; reason: string }[] = [];

  // Everyone who has asked to hear anything. A null address is an opt-out and
  // is the default, so this is normally a short list.
  let profileQuery = db
    .from("profiles")
    .select("id, full_name, task_alert_email")
    .not("task_alert_email", "is", null);
  if (opts.onlyUser) profileQuery = profileQuery.eq("id", opts.onlyUser);
  const { data: profiles, error: pErr } = await profileQuery;
  if (pErr) throw new Error(`profiles read failed: ${pErr.message}`);
  if (!profiles || profiles.length === 0) {
    return { sent, skipped: ["No user has set a task alert address."], failed };
  }

  const byId = new Map(profiles.map((p) => [p.id as string, p]));

  // Every OPEN task belonging to someone who wants mail — deliberately with no
  // due-date bound, and the reason is the assignment alert. A task with no due
  // date, or one due next year, still has to be announced when it is assigned,
  // so narrowing this to the reminder horizon would silently stop announcing
  // exactly the tasks nobody has put a date on. Reminders re-filter by date
  // below, where the bound actually applies.
  //
  // The list is bounded by `status <> done` and by the assignee set, which on
  // this board is a handful of people. If it ever is not, the split is one
  // query for assignment (no date) and one for reminders (dated), not a date
  // bound on this one.
  const { data: tasks, error: tErr } = await db
    .from("tasks")
    .select("id, company_id, title, description, status, priority, due_date, assignee_id")
    .in("assignee_id", Array.from(byId.keys()))
    .neq("status", "done");
  if (tErr) throw new Error(`tasks read failed: ${tErr.message}`);

  const senderFor = new Map<string, string>();
  const resolveSender = async (companyId: string) => {
    if (senderFor.has(companyId)) return senderFor.get(companyId)!;
    const { data: ns } = await db
      .from("notification_settings")
      .select("sender_email")
      .eq("company_id", companyId)
      .maybeSingle();
    const s = ns?.sender_email?.trim() || DEFAULT_SENDER;
    senderFor.set(companyId, s);
    return s;
  };

  for (const task of (tasks ?? []) as TaskRow[]) {
    const person = task.assignee_id ? byId.get(task.assignee_id) : null;
    const to = (person?.task_alert_email as string | null)?.trim();
    if (!to) continue;

    const jobs: { kind: string; subject: string; heading: string; accent: string; lead: string }[] = [];

    // 1. Assignment. Owed to every assigned task that has not been announced —
    //    including ones assigned before this job existed, which is deliberate:
    //    the alternative is a cutoff date nothing records and nobody remembers.
    jobs.push({
      kind: "assigned",
      subject: `New task: ${task.title}`,
      heading: "A task has been assigned to you",
      accent: "#2563eb",
      lead: "You have been assigned the following task.",
    });

    // 2. Reminders. Only the TIGHTEST threshold the task currently qualifies
    //    for — a task seven days out crosses 7, then 3, then 1, then 0 on four
    //    separate days, and each is a separate log row, so it is announced once
    //    per threshold rather than four times today.
    if (task.due_date) {
      const days = Math.round(
        (new Date(task.due_date).getTime() - new Date(opts.today).getTime()) / 86_400_000,
      );
      const threshold = REMINDER_DAYS.find((d) => d === days);
      if (threshold !== undefined) {
        jobs.push({
          kind: `due_${threshold}`,
          subject:
            threshold === 0
              ? `Due today: ${task.title}`
              : `Due in ${threshold} day${threshold === 1 ? "" : "s"}: ${task.title}`,
          heading: threshold === 0 ? "This task is due today" : "A task is coming due",
          accent: threshold <= 1 ? "#dc2626" : "#d97706",
          lead:
            threshold === 0
              ? "This task is due today and is not marked done."
              : `This task is due in ${threshold} day${threshold === 1 ? "" : "s"} and is not marked done.`,
        });
      }
    }

    for (const job of jobs) {
      // A test run announces what it WOULD send without consuming the claim —
      // otherwise testing the feature is what stops the real mail going out.
      if (!opts.isTest) {
        const claimed = await claim(db, {
          company_id: task.company_id,
          task_id: task.id,
          alert_kind: job.kind,
          recipient_email: to,
        });
        if (!claimed) { skipped.push(`${job.kind} for "${task.title}" (already sent)`); continue; }
      }
      try {
        await sendViaResend({
          to,
          from: await resolveSender(task.company_id),
          subject: job.subject,
          html: shell(
            job.heading,
            job.accent,
            `<p style="margin:0 0 14px;">${esc(job.lead)}</p>${taskBlock(task)}`,
          ),
        });
        sent.push({ kind: job.kind, task: task.title, to });
      } catch (e) {
        // The claim stays. A send that failed for a bad address will fail again
        // tomorrow, and retrying it daily forever is noise, not resilience —
        // the failure is reported here and in the response instead.
        failed.push({ task: task.title, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return { sent, skipped, failed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const isTest = url.searchParams.get("test") === "1";
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let onlyUser: string | undefined;
    if (isTest) {
      // A test sends only to the caller. Without this, anyone who could reach
      // the function with ?test=1 could mail the entire company.
      const auth = req.headers.get("Authorization") ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const { data: userRes } = await db.auth.getUser(token);
      if (!userRes?.user) return json({ error: "Sign in to send a test." }, 401);
      onlyUser = userRes.user.id;
    }

    const today = new Date().toISOString().slice(0, 10);
    const result = await run(db, { today, onlyUser, isTest });
    return json({ ok: true, test: isTest, today, ...result });
  } catch (e) {
    console.error("send-task-alerts failed:", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
