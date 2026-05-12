import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'missing_token' }, 401);

  // Verify the caller
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'invalid_token' }, 401);
  const callerId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Get caller profile
  const { data: callerProfile } = await admin
    .from('profiles')
    .select('id, role, company_id')
    .eq('id', callerId)
    .maybeSingle();
  if (!callerProfile) return json({ error: 'no_profile' }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const targetUserId = body.target_user_id ? String(body.target_user_id) : null;
  const newPassword = String(body.new_password ?? '');
  const currentPassword = body.current_password ? String(body.current_password) : null;

  if (!newPassword || newPassword.length < 8) {
    return json({ error: 'password_must_be_at_least_8_characters' }, 400);
  }

  // === CASE 1: Self-service password change ===
  if (!targetUserId || targetUserId === callerId) {
    // For self-change, verify current password (unless must_change_password is true)
    const { data: selfProfile } = await admin
      .from('profiles')
      .select('must_change_password')
      .eq('id', callerId)
      .maybeSingle();

    if (!selfProfile?.must_change_password) {
      // Must provide current password for regular self-change
      if (!currentPassword) {
        return json({ error: 'current_password_required' }, 400);
      }
      // Verify current password by attempting sign-in
      const { data: ud } = await admin.auth.admin.getUserById(callerId);
      if (!ud.user?.email) return json({ error: 'user_not_found' }, 404);

      const verifyClient = createClient(SUPABASE_URL, ANON_KEY);
      const { error: signInErr } = await verifyClient.auth.signInWithPassword({
        email: ud.user.email,
        password: currentPassword,
      });
      if (signInErr) return json({ error: 'current_password_incorrect' }, 403);
    }

    // Update password
    const { error: updateErr } = await admin.auth.admin.updateUserById(callerId, {
      password: newPassword,
    });
    if (updateErr) return json({ error: 'update_failed', detail: updateErr.message }, 500);

    // Clear must_change_password flag
    await admin.from('profiles').update({ must_change_password: false }).eq('id', callerId);

    return json({ ok: true });
  }

  // === CASE 2: Admin changing another user's password ===
  // Get target user's profile
  const { data: targetProfile } = await admin
    .from('profiles')
    .select('id, role, company_id')
    .eq('id', targetUserId)
    .maybeSingle();
  if (!targetProfile) return json({ error: 'target_user_not_found' }, 404);

  // Authorization rules:
  // - super_super_admin can change anyone's password
  // - super_admin can change passwords for users in their company, EXCEPT other super_admins
  // - nobody else can change other users' passwords

  if (callerProfile.role === 'super_super_admin') {
    // SSA can change anyone — allowed
  } else if (callerProfile.role === 'super_admin') {
    // SA can only change users in their own company
    if (callerProfile.company_id !== targetProfile.company_id) {
      return json({ error: 'wrong_company' }, 403);
    }
    // SA cannot change another SA's password — only SSA can do that
    if (targetProfile.role === 'super_admin') {
      return json({ error: 'only_super_super_admin_can_change_super_admin_password' }, 403);
    }
  } else {
    return json({ error: 'forbidden' }, 403);
  }

  // Update the target user's password
  const { error: updateErr } = await admin.auth.admin.updateUserById(targetUserId, {
    password: newPassword,
  });
  if (updateErr) return json({ error: 'update_failed', detail: updateErr.message }, 500);

  // Set must_change_password so the user is prompted to change it on next login
  await admin.from('profiles').update({ must_change_password: true }).eq('id', targetUserId);

  return json({ ok: true });
});
