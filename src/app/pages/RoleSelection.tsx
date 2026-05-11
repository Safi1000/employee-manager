import { Navigate } from "react-router";
import { Loader2 } from "lucide-react";
import { ROLE_HOMES, useAuth } from "../lib/auth";

export default function RoleSelection() {
  const { session, profile, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
      </div>
    );
  }
  if (!session || !profile) return <Navigate to="/login" replace />;
  return <Navigate to={ROLE_HOMES[profile.role]} replace />;
}
