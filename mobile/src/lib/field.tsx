// The field login's state: signed out → (authenticator code) → this phone
// checked → sites.
//
// Two kinds of login (0612). A site supervisor signs in with employee code +
// PIN and sees its own sites; its session lasts 14 hours (0608). Office staff
// granted "Field app" sign in with their own Bastion email + password + the
// authenticator code, see every site (their region's, if pinned), and keep the
// office's 8-hour session (0600). field_me says which, and how long.
//
// After sign-in the app registers this phone (field_register_device). Every
// new phone — the login's first one too (0611) — waits until a super admin
// approves it in Operations › Field Supervisors. The server refuses a session
// past its limit, and the app signs out on its own a moment before, so nobody
// sees a half-working screen.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { deviceId, deviceLabel, fieldEmail, fieldPassword, supabase } from "./supabase";

export type Site = { id: string; name: string; client: string | null; location: string | null; region: string | null; guards: number };
export type Me = {
  name: string; employee_code: string | null; kind: "supervisor" | "office"; title: string | null;
  session_hours: number; sites: Site[];
};
export type Guard = {
  employee_id: string; full_name: string; employee_code: string | null; shift: string | null;
  phone: string | null; has_photo: boolean; flags: string[] | null;
};

type Phase = "loading" | "signedOut" | "mfa" | "pending" | "revoked" | "ready" | "error";
type Ctx = {
  phase: Phase; me: Me | null; error: string | null; notice: string | null; endsAt: number | null;
  signIn: (code: string, pin: string) => Promise<string | null>;
  signInOffice: (email: string, password: string) => Promise<string | null>;
  verifyCode: (code: string) => Promise<string | null>;
  signOut: (notice?: string) => Promise<void>;
  recheck: () => Promise<void>;
  roster: (siteId: string) => Promise<Guard[]>;
  photo: (siteId: string, employeeId: string) => Promise<string | null>;
};

const FieldCtx = createContext<Ctx | null>(null);
/** Before field_me says otherwise, the longest a field session can last. */
const MAX_SESSION_HOURS = 14;
const NO_ACCESS = "Your login doesn't have field app access. Ask a super admin to tick Field app on your permissions.";

/** Sign-in time = the earliest auth method stamp in the token, as on the web. */
function sessionEnd(s: Session | null, hours: number): number | null {
  if (!s) return null;
  try {
    const b64 = s.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))) as { amr?: { timestamp: number }[] };
    const stamps = (claims.amr ?? []).map((a) => a.timestamp).filter((n) => Number.isFinite(n));
    if (!stamps.length) return null;
    return (Math.min(...stamps) + hours * 3600) * 1000;
  } catch {
    return null;
  }
}

/** Turn the gate's refusals into what the supervisor should do. */
function readError(message: string): { phase?: Phase; signOut?: string; text: string } {
  if (/session expired/i.test(message)) return { signOut: "Your session ended. Sign in again.", text: message };
  if (/two-factor required/i.test(message)) return { signOut: "Set up your authenticator app in Bastion on the web first, then sign in here.", text: message };
  if (/account disabled/i.test(message)) return { signOut: "This login has been switched off. Ask your office.", text: message };
  if (/not approved for this login/i.test(message)) return { phase: "pending", text: message };
  if (/only field logins/i.test(message)) return { signOut: NO_ACCESS, text: message };
  if (/can only be used in the bastion field app/i.test(message)) return { signOut: "This login works in the field app only.", text: message };
  if (/network request failed|failed to fetch/i.test(message)) return { text: "No internet connection. Check your signal and try again." };
  return { text: message };
}

export function FieldProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const photos = useRef(new Map<string, Promise<string | null>>());

  const signOut = useCallback(async (why?: string) => {
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    photos.current.clear();
    setMe(null); setEndsAt(null); setError(null); setNotice(why ?? null); setPhase("signedOut");
  }, []);

  /** Register this phone, then load who we are and which sites we cover. */
  const recheck = useCallback(async () => {
    const { data: s } = await supabase.auth.getSession();
    setError(null);
    if (!s.session) { setPhase("signedOut"); return; }
    const end = sessionEnd(s.session, MAX_SESSION_HOURS);
    if (end && end <= Date.now()) { await signOut("Your session ended. Sign in again."); return; }
    // An office login with an authenticator has to enter its code before anything else.
    const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.data?.nextLevel === "aal2" && aal.data.currentLevel !== "aal2") { setPhase("mfa"); return; }

    const reg = await supabase.rpc("field_register_device", { p_device_id: await deviceId, p_label: deviceLabel() });
    if (reg.error) {
      const r = readError(reg.error.message);
      if (r.signOut) { await signOut(r.signOut); return; }
      setError(r.text); setPhase("error"); return;
    }
    if (reg.data === "pending") { setPhase("pending"); return; }
    if (reg.data === "revoked") { setPhase("revoked"); return; }

    const res = await supabase.rpc("field_me");
    if (res.error) {
      const r = readError(res.error.message);
      if (r.signOut) { await signOut(r.signOut); return; }
      if (r.phase) { setPhase(r.phase); return; }
      setError(r.text); setPhase("error"); return;
    }
    if (!res.data) { await signOut(NO_ACCESS); return; }
    const got = res.data as Me;
    const ends = sessionEnd(s.session, got.session_hours ?? MAX_SESSION_HOURS);
    if (ends && ends <= Date.now()) { await signOut("Your session ended. Sign in again."); return; }
    setEndsAt(ends);
    setMe(got);
    setPhase("ready");
  }, [signOut]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void recheck(); }, [recheck]);

  // Sign out on our own at the session's end, rather than wait for a refusal.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!endsAt) return;
    timer.current = setTimeout(() => void signOut("Your session ended. Sign in again."), Math.max(0, endsAt - Date.now()));
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [endsAt, signOut]);

  const signIn = useCallback(async (code: string, pin: string) => {
    if (!code.trim()) return "Enter your employee code.";
    if (!/^\d{6}$/.test(pin)) return "Your PIN is 6 digits.";
    const { error: e } = await supabase.auth.signInWithPassword({ email: fieldEmail(code), password: fieldPassword(code, pin) });
    if (e) return /invalid login|invalid credentials/i.test(e.message) ? "That code and PIN don't match. Check both and try again." : readError(e.message).text;
    setNotice(null);
    setPhase("loading");
    await recheck();
    return null;
  }, [recheck]);

  /** Office staff: their own Bastion email and password; the code comes next if they have an authenticator. */
  const signInOffice = useCallback(async (email: string, password: string) => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return "Enter your Bastion email address.";
    if (!password) return "Enter your password.";
    const { error: e } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (e) return /invalid login|invalid credentials/i.test(e.message) ? "That email and password don't match." : readError(e.message).text;
    setNotice(null);
    setPhase("loading");
    await recheck();
    return null;
  }, [recheck]);

  /** The 6-digit code from the authenticator app (office logins). */
  const verifyCode = useCallback(async (code: string) => {
    if (!/^\d{6}$/.test(code)) return "The code is 6 digits.";
    const f = await supabase.auth.mfa.listFactors();
    const totp = f.data?.totp?.[0];
    if (!totp) return "No authenticator is set up for this login. Set one up in Bastion on the web.";
    const { error: e } = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code });
    if (e) return /invalid|expired/i.test(e.message) ? "That code didn't work. Wait for a new one and try again." : readError(e.message).text;
    setPhase("loading");
    await recheck();
    return null;
  }, [recheck]);

  const roster = useCallback(async (siteId: string) => {
    const { data, error: e } = await supabase.rpc("field_site_roster", { p_site_id: siteId });
    if (e) {
      const r = readError(e.message);
      if (r.signOut) { await signOut(r.signOut); return []; }
      if (r.phase) { setPhase(r.phase); return []; }
      throw new Error(r.text);
    }
    return (data ?? []) as Guard[];
  }, [signOut]);

  // One photo per call (field_guard_photo, 0609), kept for the session so
  // scrolling back up does not fetch it again. A failed fetch shows initials.
  const photo = useCallback((siteId: string, employeeId: string) => {
    let p = photos.current.get(employeeId);
    if (!p) {
      p = Promise.resolve(supabase.rpc("field_guard_photo", { p_site_id: siteId, p_employee_id: employeeId }))
        .then(({ data, error: e }) => (e ? null : (data as string | null)))
        .catch(() => null);
      p.then((v) => { if (!v) photos.current.delete(employeeId); });
      photos.current.set(employeeId, p);
    }
    return p;
  }, []);

  return (
    <FieldCtx.Provider value={{ phase, me, error, notice, endsAt, signIn, signInOffice, verifyCode, signOut, recheck, roster, photo }}>
      {children}
    </FieldCtx.Provider>
  );
}

export function useField() {
  const c = useContext(FieldCtx);
  if (!c) throw new Error("FieldProvider missing");
  return c;
}
