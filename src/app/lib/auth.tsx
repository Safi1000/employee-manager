import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, type Company, type Profile, type UserRole } from "./supabase";

type AuthCtx = {
  session: Session | null;
  profile: Profile | null;
  company: Company | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  setViewAsCompany: (companyId: string | null) => Promise<{ error?: string }>;
};

const Ctx = createContext<AuthCtx | null>(null);

export const ROLE_HOMES: Record<UserRole, string> = {
  super_super_admin: "/super-super-admin",
  super_admin: "/super-admin",
  hr: "/hr",
  accounting: "/accounts",
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  const wipeAuthStorage = () => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith("sb-") || k.includes("supabase"))) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
    } catch {
      // ignore
    }
  };

  const loadProfileAndCompany = async (userId: string): Promise<boolean> => {
    try {
      const { data } = await supabase
        .from("profiles")
        .select("id, company_id, role, full_name, email, view_as_company, created_at, updated_at")
        .eq("id", userId)
        .maybeSingle();
      const p = (data as Profile) ?? null;
      setProfile(p);

      if (!p) return false;

      const effectiveCompanyId = p.view_as_company ?? p.company_id ?? null;
      if (effectiveCompanyId) {
        const { data: c } = await supabase
          .from("companies")
          .select("*")
          .eq("id", effectiveCompanyId)
          .maybeSingle();
        setCompany((c as Company) ?? null);
      } else {
        setCompany(null);
      }
      return true;
    } catch {
      setProfile(null);
      setCompany(null);
      return false;
    }
  };

  useEffect(() => {
    let mounted = true;

    // Hard timeout: if init isn't done in 4s, give up, wipe storage, fall through
    // to an unauthenticated state. Avoids the "spinner forever" trap.
    const failsafe = setTimeout(() => {
      if (!mounted) return;
      wipeAuthStorage();
      setSession(null);
      setProfile(null);
      setCompany(null);
      setLoading(false);
    }, 4000);

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        if (data.session?.user) {
          // Best-effort: sync expired-subscription deactivations before loading state.
          // Fire-and-forget so it can't block the spinner.
          (async () => {
            try { await supabase.rpc("enforce_subscription_expiry"); } catch { /* ignore */ }
          })();
          const ok = await loadProfileAndCompany(data.session.user.id);
          if (!ok) {
            // Stale session: token decodes to a user with no profile (deleted/mismatched).
            // Wipe everything so the next render lands cleanly on /login.
            wipeAuthStorage();
            try { await supabase.auth.signOut({ scope: "local" }); } catch { /* ignore */ }
            setSession(null);
          } else {
            setSession(data.session);
          }
        } else {
          setSession(null);
        }
      } catch {
        if (!mounted) return;
        wipeAuthStorage();
        setSession(null);
        setProfile(null);
        setCompany(null);
      } finally {
        clearTimeout(failsafe);
        if (mounted) setLoading(false);
      }
    })();
    // IMPORTANT: don't await supabase calls inside this callback — it deadlocks
    // the auth client's internal lock. Defer with setTimeout(0).
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s?.user) {
        const uid = s.user.id;
        setTimeout(() => { loadProfileAndCompany(uid); }, 0);
      } else {
        setProfile(null);
        setCompany(null);
      }
    });
    return () => {
      mounted = false;
      clearTimeout(failsafe);
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return {};
  };

  const signOut = async () => {
    // For SSA, clear view_as_company so they don't come back to a stale "viewing as X" state.
    if (profile?.role === "super_super_admin" && profile.view_as_company) {
      try {
        await supabase.from("profiles").update({ view_as_company: null }).eq("id", profile.id);
      } catch {
        // best effort
      }
    }
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // ignore
    }
    wipeAuthStorage();
    setSession(null);
    setProfile(null);
    setCompany(null);
  };

  const refreshProfile = async () => {
    if (session?.user) await loadProfileAndCompany(session.user.id);
  };

  const setViewAsCompany = async (companyId: string | null) => {
    if (!profile) return { error: "no_profile" };
    if (profile.role !== "super_super_admin") return { error: "forbidden" };
    const { error } = await supabase
      .from("profiles")
      .update({ view_as_company: companyId })
      .eq("id", profile.id);
    if (error) return { error: error.message };
    await refreshProfile();
    return {};
  };

  return (
    <Ctx.Provider
      value={{
        session,
        profile,
        company,
        loading,
        signIn,
        signOut,
        refreshProfile,
        setViewAsCompany,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export async function callCreateUser(input: {
  email: string;
  password: string;
  role: "super_admin" | "hr" | "accounting";
  company_id: string;
  full_name?: string | null;
}) {
  const { data, error } = await supabase.functions.invoke("create-user", { body: input });
  if (error) return { error: error.message };
  if (data && typeof data === "object" && "error" in data) {
    return { error: String((data as { error: unknown }).error) };
  }
  return { ok: true as const, user_id: (data as { user_id: string }).user_id };
}
