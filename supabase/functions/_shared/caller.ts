// Who is calling, and which company they act for.
//
// The gateway's verify_jwt only proves the token is A valid JWT — the public
// anon key is one, and it ships in every browser bundle. So a function that
// does anything on a company's behalf must resolve the caller itself. Found by
// the 2026-10-08 security audit: the gdrive functions checked only that the
// header began with "Bearer ", so the anon key could upload into any company's
// folder and delete any file by id.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export type Caller = {
  userId: string;
  /** The company the caller acts for (an SSA's view-as company, else their own). */
  companyId: string | null;
  isSSA: boolean;
};

export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE);
}

/** Resolves a signed-in user with a profile, or null for anything else (anon key included). */
export async function resolveCaller(req: Request): Promise<Caller | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const admin = serviceClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: p } = await admin
    .from("profiles")
    .select("company_id, role, view_as_company")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!p) return null;
  const isSSA = p.role === "super_super_admin";
  return {
    userId: data.user.id,
    companyId: ((isSSA ? p.view_as_company : null) ?? p.company_id) as string | null,
    isSSA,
  };
}

/** May this caller act for this company? */
export function actsFor(caller: Caller, companyId: string): boolean {
  return caller.isSSA || (!!caller.companyId && caller.companyId === companyId);
}

/** Is the header the project's service-role credential (cron / pg_net)? */
export function isServiceRole(req: Request): boolean {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (SERVICE_ROLE && token === SERVICE_ROLE) return true;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    // A JWT's role claim is only trustworthy once its signature is checked; the
    // gateway (verify_jwt = true) has already done that before we run.
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}
