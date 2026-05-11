import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { Loader2 } from "lucide-react";
import { ROLE_HOMES, useAuth } from "../lib/auth";
import type { UserRole } from "../lib/supabase";

export default function RequireAuth({
  roles,
  children,
}: {
  roles?: UserRole[];
  children: ReactNode;
}) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
      </div>
    );
  }
  if (!session || !profile) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  if (roles && !roles.includes(profile.role)) {
    return <Navigate to={ROLE_HOMES[profile.role]} replace />;
  }
  return <>{children}</>;
}
