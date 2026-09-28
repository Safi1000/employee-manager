// Auth, following the build brief: same accounts as web, profile row carries
// role + permissions, can() mirrors hasPermission.
import React, { createContext, useContext, useEffect, useState } from "react";
import { hasAny, hasPermission, UserRole } from "./permissions";
import { isLive, supabase } from "./supabase";

export type Profile = {
  id: string;
  name: string;
  email: string;
  title: string;
  role: UserRole;
  permissions: string[];
  branch_id: string | null;
  employee_id: string | null;
};

type AuthCtx = {
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  can: (key: string) => boolean;
  canAny: (keys: string[]) => boolean;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadProfile(userId: string, email: string) {
    if (!supabase) return;
    const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
    if (data) {
      setProfile({
        id: userId, email, name: data.full_name ?? email, title: data.title ?? "", role: data.role,
        permissions: data.permissions ?? [], branch_id: data.branch_id ?? null, employee_id: data.employee_id ?? null,
      });
    }
  }

  useEffect(() => {
    if (isLive && supabase) {
      supabase.auth.getSession().then(async ({ data }) => {
        if (data.session) await loadProfile(data.session.user.id, data.session.user.email ?? "");
        setLoading(false);
      });
      const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
        if (session) loadProfile(session.user.id, session.user.email ?? "");
        else setProfile(null);
      });
      return () => sub.subscription.unsubscribe();
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
    setLoading(false);
  }, []);

  const value: AuthCtx = {
    profile,
    loading,
    async signIn(email, password) {
      if (!supabase) return "This build has no server configured.";
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? error.message : null;
    },
    async signOut() {
      if (supabase) await supabase.auth.signOut();
      setProfile(null);
    },
    can: (k) => hasPermission(profile, k),
    canAny: (ks) => hasAny(profile, ks),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("AuthProvider missing");
  return c;
}
