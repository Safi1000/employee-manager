// Edge function: push-send (0622)
//
// Delivers one push_outbox row to the phones of its user_ids through Expo's push
// service (which hands Android to Firebase and iPhone to Apple). Called by
// queue_push() over pg_net with the service-role key, after the transaction that
// queued it commits — so a request that rolled back notifies nobody.
//
// Service role only: a signed-in user cannot call it. It reads push_tokens
// itself; the caller passes only the outbox id. A phone whose token Expo reports
// as no longer registered has that token removed.
//
// Until the field app is built with push credentials (Firebase for Android, the
// Apple push key for iPhone), no phone has a token and the row is marked
// "no devices" — the Bastion alert raised alongside it still reaches the web.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isServiceRole, serviceClient } from "../_shared/caller.ts";

const EXPO_PUSH = "https://exp.host/--/api/v2/push/send";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!isServiceRole(req)) return json({ error: "Not allowed" }, 403);

  let outboxId: string | undefined;
  try { outboxId = (await req.json())?.outbox_id; } catch { /* below */ }
  if (!outboxId) return json({ error: "outbox_id is required" }, 400);

  const db = serviceClient();
  const { data: row, error } = await db.from("push_outbox").select("id, user_ids, title, body, data, sent_at").eq("id", outboxId).maybeSingle();
  if (error || !row) return json({ error: error?.message ?? "Not found" }, 404);
  if (row.sent_at) return json({ ok: true, already: true });

  const { data: tokens } = await db.from("push_tokens").select("user_id, token").in("user_id", row.user_ids as string[]);
  const list = (tokens ?? []) as { user_id: string; token: string }[];
  if (!list.length) {
    await db.from("push_outbox").update({ sent_at: new Date().toISOString(), result: "no devices" }).eq("id", row.id);
    return json({ ok: true, sent: 0 });
  }

  const messages = list.map((t) => ({ to: t.token, title: row.title, body: row.body, data: row.data ?? {}, sound: "default", priority: "high" }));
  let result = "";
  try {
    const res = await fetch(EXPO_PUSH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
    });
    const out = await res.json() as { data?: { status: string; details?: { error?: string } }[]; errors?: unknown[] };
    const tickets = out.data ?? [];
    const dead = tickets.map((t, i) => (t.status === "error" && t.details?.error === "DeviceNotRegistered" ? list[i] : null)).filter(Boolean) as typeof list;
    for (const d of dead) await db.from("push_tokens").delete().eq("user_id", d.user_id).eq("token", d.token);
    const ok = tickets.filter((t) => t.status === "ok").length;
    result = `sent ${ok} of ${messages.length}${dead.length ? `, ${dead.length} stale token(s) removed` : ""}${out.errors ? ` · ${JSON.stringify(out.errors).slice(0, 200)}` : ""}`;
  } catch (e) {
    result = `failed: ${(e as Error).message}`.slice(0, 300);
  }
  await db.from("push_outbox").update({ sent_at: new Date().toISOString(), result }).eq("id", row.id);
  return json({ ok: true, result });
});
