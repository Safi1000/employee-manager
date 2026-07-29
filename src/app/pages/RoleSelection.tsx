import { Suspense, lazy } from "react";
import { Navigate } from "react-router";
import { ROLE_HOMES, useAuth } from "../lib/auth";

// Lazy-loaded so the landing page (BastionLanding + its raw HTML/CSS/JS strings)
// is code-split into its OWN chunk, fetched only when a logged-out visitor
// actually renders it at "/". Logged-in users redirect before it renders, so
// they never download the landing chunk. A full-screen obsidian placeholder
// matches the landing's background to avoid a white flash while it loads.
const BastionLanding = lazy(() => import("../landing/BastionLanding"));
const LandingFallback = <div style={{ minHeight: "100vh", background: "#12140f" }} />;

export default function RoleSelection() {
  const { session, profile, loading } = useAuth();
  // While auth is resolving, render nothing — this also prevents a logged-in user
  // who briefly passes through "/" from triggering the landing chunk download.
  if (loading) return null;
  // A confirmed session goes straight to its role home; otherwise an
  // unauthenticated visitor sees the public Bastion landing page (its "Sign in"
  // button routes to /login).
  if (session && profile) return <Navigate to={ROLE_HOMES[profile.role]} replace />;
  return <Suspense fallback={LandingFallback}>{<BastionLanding />}</Suspense>;
}
