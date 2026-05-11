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
  const { session, profile, company, loading } = useAuth();
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

  // Block company users whose company is deactivated OR whose subscription has lapsed.
  // SSA is never blocked.
  if (profile.role !== "super_super_admin" && company) {
    const today = new Date().toISOString().slice(0, 10);
    const expired =
      company.subscription_expires_at != null &&
      company.subscription_expires_at < today;
    if (company.active === false || expired) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-8">
          <div className="max-w-md text-center bg-white border border-slate-200 rounded-lg p-8">
            <h1 className="text-xl text-slate-900 mb-2">Access suspended</h1>
            <p className="text-sm text-slate-600 mb-6">
              {expired
                ? "Your company's subscription has expired. Contact your administrator to renew."
                : "Your company has been deactivated. Contact your administrator for help."}
            </p>
            <a href="/login" className="text-sm text-blue-600 hover:underline">Sign out</a>
          </div>
        </div>
      );
    }
  }

  if (roles && !roles.includes(profile.role)) {
    // Special case: SSA can enter super-admin routes only when they've picked a company to view.
    const ssaViewing = profile.role === "super_super_admin" && !!profile.view_as_company;
    if (!(ssaViewing && roles.includes("super_admin"))) {
      return <Navigate to={ROLE_HOMES[profile.role]} replace />;
    }
  }

  return <>{children}</>;
}
