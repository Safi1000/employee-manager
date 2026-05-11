import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, type Profile, type UserRole } from "./supabase";

type AuthCtx = {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
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
  const [loading, setLoading] = useState(true);

  const loadProfile = async (userId: string) => {
    try {
      const { data } = await supabase
        .from("profiles")
        .select("id, company_id, role, full_name, email, created_at, updated_at")
        .eq("id", userId)
        .maybeSingle();
      setProfile((data as Profile) ?? null);
    } catch {
      setProfile(null);
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        setSession(data.session ?? null);
        if (data.session?.user) await loadProfile(data.session.user.id);
      } catch {
        if (!mounted) return;
        setSession(null);
        setProfile(null);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, s) => {
      setSession(s);
      if (s?.user) await loadProfile(s.user.id);
      else setProfile(null);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return {};
  };

  const signOut = async () => {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // ignore — local clear below still runs
    }
    setSession(null);
    setProfile(null);
  };

  const refreshProfile = async () => {
    if (session?.user) await loadProfile(session.user.id);
  };

  return (
    <Ctx.Provider value={{ session, profile, loading, signIn, signOut, refreshProfile }}>
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
