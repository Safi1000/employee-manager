// Edge function: field-account (0607)
//
// Creates and maintains site-supervisor logins for the field app. Super admins
// only (Shayan, 29 Oct 2026). A supervisor signs in with their EMPLOYEE CODE
// and a 6-DIGIT PIN; behind that, the auth login is
//
//   email     <employee code, lower-case>@field.techxserve.com   (never mailed)
//   password  fieldPassword(code, pin)  — the app derives the same string
//
// so no email is needed and the PIN is never the whole password. The profile is
// user_type 'site_supervisor' with no permissions: api_request_gate (0607)
// refuses it everything except the field_* functions, and only from its
// approved phone.
//
// Actions (POST JSON):
//   { action: "create", employee_id, pin, site_ids: [] }
//   { action: "reset_pin", user_id, pin }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveCaller, serviceClient } from "../_shared/caller.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const FIELD_DOMAIN = "field.techxserve.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

/** The login a supervisor's code maps to. Mirrors the field app. */
export function fieldEmail(code: string): string {
  return `${code.trim().toLowerCase().replace(/[^a-z0-9-]/g, "")}@${FIELD_DOMAIN}`;
}
/** The password a code + PIN maps to. Mirrors the field app — change both together. */
export function fieldPassword(code: string, pin: string): string {
  return `Bastion-field:${code.trim().toUpperCase()}:${pin}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const caller = await resolveCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  const admin = serviceClient();
  const { data: me } = await admin.from("profiles").select("role, company_id").eq("id", caller.userId).maybeSingle();
  if (me?.role !== "super_admin" || !me.company_id) return json({ error: "Only a super admin can manage field accounts." }, 403);
  const companyId = me.company_id as string;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const pin = String(body.pin ?? "");
  if (!/^\d{6}$/.test(pin)) return json({ error: "The PIN must be exactly 6 digits." }, 400);
  if (/^(\d)\1{5}$/.test(pin) || ["123456", "654321", "012345", "123123"].includes(pin)) {
    return json({ error: "That PIN is too easy to guess. Choose another." }, 400);
  }

  if (body.action === "create") {
    const employeeId = String(body.employee_id ?? "");
    const siteIds = Array.isArray(body.site_ids) ? body.site_ids.map(String) : [];
    const { data: emp } = await admin.from("employees").select("id, company_id, full_name, employee_code, status")
      .eq("id", employeeId).maybeSingle();
    if (!emp || emp.company_id !== companyId) return json({ error: "Employee not found." }, 404);
    if (emp.status !== "Active" && emp.status !== "On Leave") return json({ error: "Only active employees can have a field login." }, 400);
    if (!emp.employee_code) return json({ error: "This employee has no employee code." }, 400);
    if (siteIds.length) {
      const { data: sites } = await admin.from("sites").select("id").eq("company_id", companyId).in("id", siteIds);
      if ((sites ?? []).length !== new Set(siteIds).size) return json({ error: "A chosen site was not found." }, 400);
    }
    const { data: already } = await admin.from("profiles").select("id").eq("employee_id", emp.id).eq("user_type", "site_supervisor").maybeSingle();
    if (already) return json({ error: "This employee already has a field login. Reset its PIN instead." }, 409);

    const email = fieldEmail(emp.employee_code);
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password: fieldPassword(emp.employee_code, pin), email_confirm: true,
      user_metadata: { full_name: emp.full_name, field: true },
    });
    if (createErr || !created.user) {
      const msg = (createErr?.message ?? "").toLowerCase();
      if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) return json({ error: "A login for this code already exists." }, 409);
      return json({ error: "Could not create the login.", detail: createErr?.message }, 400);
    }
    const { error: insErr } = await admin.from("profiles").insert({
      id: created.user.id, company_id: companyId, role: "ops_manager", title: "Site Supervisor",
      email, full_name: emp.full_name, permissions: [], user_type: "site_supervisor",
      employee_id: emp.id, site_scope: [...new Set(siteIds)], must_change_password: false,
    });
    if (insErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      return json({ error: "Could not create the login.", detail: insErr.message }, 500);
    }
    return json({ ok: true, user_id: created.user.id, code: emp.employee_code }, 201);
  }

  if (body.action === "reset_pin") {
    const userId = String(body.user_id ?? "");
    const { data: p } = await admin.from("profiles").select("id, company_id, user_type, employee_id").eq("id", userId).maybeSingle();
    if (!p || p.company_id !== companyId || p.user_type !== "site_supervisor") return json({ error: "Field login not found." }, 404);
    const { data: emp } = await admin.from("employees").select("employee_code").eq("id", p.employee_id).maybeSingle();
    if (!emp?.employee_code) return json({ error: "The linked employee has no code." }, 400);
    const { error } = await admin.auth.admin.updateUserById(userId, { password: fieldPassword(emp.employee_code, pin) });
    if (error) return json({ error: "Could not reset the PIN.", detail: error.message }, 400);
    // Every phone signed in with the old PIN is signed out — through the
    // ordinary users.manage function, as the super admin who asked.
    const asCaller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { error: outErr } = await asCaller.rpc("end_user_sessions", { p_user_id: userId });
    return json({ ok: true, signed_out: !outErr });
  }

  return json({ error: "Unknown action." }, 400);
});
