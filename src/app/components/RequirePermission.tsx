import { ReactNode } from "react";
import { Navigate } from "react-router";
import { hasAnyPermission, useAuth } from "../lib/auth";

// Per-page guard. SSA + super_admin pass through (they have everything).
// Other roles must have at least ONE of the listed permissions.
export default function RequirePermission({
  any,
  children,
  fallback = "/super-admin",
}: {
  any: string[];
  children: ReactNode;
  fallback?: string;
}) {
  const { profile } = useAuth();
  if (!profile) return null;
  if (profile.role === "super_super_admin" || profile.role === "super_admin") {
    return <>{children}</>;
  }
  if (!hasAnyPermission(profile, any)) {
    return <Navigate to={fallback} replace />;
  }
  return <>{children}</>;
}
