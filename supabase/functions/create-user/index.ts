// Edge function: create-user
// Auth: SSA can create any role for any company; super_admin can create
// super_admin/hr/accounting for their own company only.
// Body: { email, password, role, company_id, full_name?, permissions[]? }
// Deploy with the Supabase CLI or via MCP `deploy_edge_function`.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "missing_token" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "invalid_token" }, 401);
  const callerId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: callerProfile, error: profErr } = await admin
    .from("profiles")
    .select("id, role, company_id")
    .eq("id", callerId)
    .maybeSingle();
  if (profErr || !callerProfile) return json({ error: "no_profile" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const role = String(body.role ?? "");
  const company_id = body.company_id == null ? null : String(body.company_id);
  const full_name = body.full_name == null ? null : String(body.full_name).trim();
  const permissions = Array.isArray(body.permissions)
    ? body.permissions.map((p) => String(p)).filter((p) => p.length > 0)
    : [];

  if (!email || !password) return json({ error: "email_and_password_required" }, 400);
  if (password.length < 8) return json({ error: "password_too_short" }, 400);
  if (!["super_admin", "hr", "accounting"].includes(role)) return json({ error: "invalid_role" }, 400);
  if (!company_id) return json({ error: "company_id_required" }, 400);

  if (callerProfile.role === "super_super_admin") {
    // ok
  } else if (callerProfile.role === "super_admin") {
    if (callerProfile.company_id !== company_id) return json({ error: "wrong_company" }, 403);
    if (!["super_admin", "hr", "accounting"].includes(role)) return json({ error: "role_not_allowed" }, 403);
  } else {
    return json({ error: "forbidden" }, 403);
  }

  const { data: companyRow, error: companyErr } = await admin
    .from("companies").select("id, active").eq("id", company_id).maybeSingle();
  if (companyErr || !companyRow) return json({ error: "company_not_found" }, 404);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name },
  });
  if (createErr || !created.user) return json({ error: "create_failed", detail: createErr?.message }, 400);

  const { error: insErr } = await admin.from("profiles").insert({
    id: created.user.id,
    company_id,
    role,
    email,
    full_name,
    permissions,
  });
  if (insErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: "profile_insert_failed", detail: insErr.message }, 500);
  }

  return json({ ok: true, user_id: created.user.id }, 201);
});
