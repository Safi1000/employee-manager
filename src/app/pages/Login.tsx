import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Lock, Mail, Loader2, ArrowRight, Check, Eye, EyeOff, Clock } from "lucide-react";
import { ROLE_HOMES, useAuth } from "../lib/auth";
import ThemeToggle from "../components/ThemeToggle";

const FEATURES = [
  "Clients, contracts and invoices in one chain",
  "Attendance that becomes payroll automatically",
  "Every rupee tracked through banks and cash",
  "Licences, incidents and audit trail built in",
];

/** Bastion shield mark. */
function Shield({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className}>
      <path d="M16 2.5 4.5 7v8.5c0 6.6 4.7 10.5 11.5 13.3C22.8 25.9 27.5 22 27.5 15.5V7z" stroke="currentColor" strokeWidth="1.7" />
      <path d="M13 15.5a3 3 0 0 1 3-3 3 3 0 0 1 3 3 3 3 0 0 1-3 3M19 16.5a3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, profile, loading, signIn } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idleLogout, setIdleLogout] = useState(false);

  // Show a one-time notice if we landed here from an inactivity auto-logout.
  useEffect(() => {
    try {
      if (localStorage.getItem("txs.logout_reason") === "inactivity") {
        setIdleLogout(true);
        localStorage.removeItem("txs.logout_reason");
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!loading && session && profile) {
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== "/login" ? from : ROLE_HOMES[profile.role], { replace: true });
    }
  }, [loading, session, profile, navigate, location.state]);

  if (!loading && session && profile) return <Navigate to={ROLE_HOMES[profile.role]} replace />;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: err } = await signIn(email.trim(), password);
    setSubmitting(false);
    if (err) setError(err);
  };

  const inputClass =
    "w-full pl-10 pr-4 py-2.5 bg-input-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-brand-500/60 focus:border-brand-500 transition-all";

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[45%_55%]">

      {/* ── Brand panel (always the obsidian "command center" look) ── */}
      <div
        className="relative hidden flex-col justify-between overflow-hidden p-12 lg:flex"
        style={{ background: "linear-gradient(160deg, #12140f 0%, #171a10 55%, #1c1e12 100%)", color: "#ece6d6" }}
      >
        {/* Ambient glow + engraved grid */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full" style={{ background: "radial-gradient(circle, rgba(233,167,60,0.20), transparent 65%)" }} />
          <div className="absolute -bottom-20 -left-16 h-72 w-72 rounded-full" style={{ background: "radial-gradient(circle, rgba(79,170,132,0.12), transparent 65%)" }} />
          <div className="absolute inset-0" style={{ backgroundImage: "linear-gradient(rgba(236,230,214,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(236,230,214,0.05) 1px, transparent 1px)", backgroundSize: "56px 56px", maskImage: "radial-gradient(120% 80% at 70% 20%, #000, transparent 75%)", WebkitMaskImage: "radial-gradient(120% 80% at 70% 20%, #000, transparent 75%)" }} />
        </div>

        {/* Logo */}
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: "rgba(233,167,60,0.15)", border: "1px solid rgba(233,167,60,0.3)", color: "#e9a73c" }}>
            <Shield className="h-6 w-6" />
          </div>
          <div>
            <p className="text-lg font-bold leading-none tracking-tight" style={{ fontFamily: "var(--font-display)" }}>Bastion</p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: "rgba(233,167,60,0.7)" }}>
              Security-services CRM
            </p>
          </div>
        </div>

        {/* Body copy */}
        <div className="relative space-y-7">
          <h2 className="text-[32px] font-bold leading-[1.1] tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            Every guard. Every rupee.<br />
            <span style={{ color: "#e9a73c" }}>One unbroken chain.</span>
          </h2>
          <p className="max-w-sm text-[14px] leading-relaxed" style={{ color: "rgba(236,230,214,0.6)" }}>
            Sign in to run the whole back office, from hire to payslip to the bank balance. Do one thing here, and the right numbers change everywhere else.
          </p>
          <div className="space-y-3">
            {FEATURES.map((f) => (
              <div key={f} className="flex items-center gap-3">
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full" style={{ background: "rgba(79,170,132,0.18)", color: "#5cbf95" }}>
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
                <span className="text-sm" style={{ color: "rgba(236,230,214,0.78)" }}>{f}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-[12px]" style={{ color: "rgba(236,230,214,0.4)" }}>Bastion · A TechxServe Product</p>
      </div>

      {/* ── Form panel ── */}
      <div className="relative flex flex-col items-center justify-center px-6 py-12">
        <div className="absolute right-5 top-5">
          <ThemeToggle />
        </div>

        {/* Mobile brand */}
        <div className="mb-8 flex items-center gap-3 lg:hidden">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500/15 text-brand-600 dark:text-brand-500">
            <Shield className="h-5 w-5" />
          </div>
          <p className="font-bold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>Bastion</p>
        </div>

        <div className="w-full max-w-sm">
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xl shadow-black/5">

            <div className="border-b border-border px-8 py-7">
              <h1 className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>Welcome back</h1>
              <p className="mt-1 text-sm text-muted-foreground">Sign in to your workspace to continue.</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-5 px-8 py-7">
              {idleLogout && (
                <div className="flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2.5 text-sm text-warning-700 dark:text-warning-500">
                  <Clock className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
                  <span>You were logged out due to inactivity. Please sign in again.</span>
                </div>
              )}
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Email address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="name@company.com"
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    className={inputClass.replace("pr-4", "pr-10")}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    tabIndex={-1}
                    className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" strokeWidth={1.5} />
                    ) : (
                      <Eye className="h-4 w-4" strokeWidth={1.5} />
                    )}
                  </button>
                </div>
              </div>

              {error && (
                <div className="text-sm text-danger-700 dark:text-danger-500 bg-danger-50 border border-danger-200 px-3 py-2.5 rounded-lg">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="group w-full py-2.5 px-4 disabled:opacity-50 bg-brand-500 hover:bg-brand-600 text-[#241a06] rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-2 shadow-sm"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Sign in
                {!submitting && <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />}
              </button>
            </form>
          </div>

          {/* TechxServe attribution */}
          <div className="mt-8 border-t border-border pt-6 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3">
              Built by TechxServe
            </p>
            <div className="flex items-center justify-center gap-3 text-sm font-semibold">
              <a href="https://techxserve.com" target="_blank" rel="noopener noreferrer" className="text-brand-700 dark:text-brand-500 hover:underline">
                techxserve.com
              </a>
              <span className="text-border">·</span>
              <a href="mailto:info@techxserve.com" className="text-brand-700 dark:text-brand-500 hover:underline">
                info@techxserve.com
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
