import { Navigate } from "react-router";
import { ROLE_HOMES, useAuth } from "../lib/auth";

export default function RoleSelection() {
  const { session, profile, loading } = useAuth();
  // Root path: if we have a confirmed session, send to role home; otherwise
  // go straight to /login. Never show a spinner here.
  if (!loading && session && profile) return <Navigate to={ROLE_HOMES[profile.role]} replace />;
  return <Navigate to="/login" replace />;
}
