import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, CheckCircle2, Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { ROLE_HOMES, useAuth } from "../lib/auth";
import { completeSignup } from "../lib/billing";
import ThemeToggle from "../components/ThemeToggle";

// Step 2 of self-serve signup — where Stripe sends the browser back.
//
// The company and its super admin are created HERE, by the signup-complete
// edge function, and only if the payment has been confirmed. This page cannot
// force that: it just passes the token along and shows whatever the server
// decides. That is the point — the rule lives on the server, not in the UI.

function Shield({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className}>
      <path d="M16 2.5 4.5 7v8.5c0 6.6 4.7 10.5 11.5 13.3C22.8 25.9 27.5 22 27.5 15.5V7z" stroke="currentColor" strokeWidth="1.7" />
      <path d="M13 15.5a3 3 0 0 1 3-3 3 3 0 0 1 3 3 3 3 0 0 1-3 3M19 16.5a3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export default function SignupComplete() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { session, profile, loading, signIn } = useAuth();

  const token = params.get("token") ?? "";
  const sessionId = params.get("session_id");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { document.title = "Finish setting up · Bastion"; }, []);

  if (!loading && session && profile) return <Navigate to={ROLE_HOMES[profile.role]} replace />;

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-bold text-foreground">Nothing to finish here</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page is the last step of signing up, and it needs the link Stripe sent you back on.
          </p>
          <Link to="/signup" className="mt-5 inline-block text-sm font-semibold text-brand-700 hover:underline dark:text-brand-500">
            Start again →
          </Link>
        </div>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }

    setSubmitting(true);
    const res = await completeSignup({ token, password, session_id: sessionId });
    if ("error" in res) {
      setError(res.error);
      setSubmitting(false);
      return;
    }

    // Sign straight in — they have just typed this password, asking for it
    // again would be pure friction.
    const { error: signInErr } = await signIn(res.email, password);
    setSubmitting(false);
    if (signInErr) {
      // The account exists; only the automatic sign-in failed. Send them to
      // the login form rather than leaving them stuck on a dead screen.
      navigate("/login", { replace: true });
      return;
    }
    navigate("/super-admin", { replace: true });
  };

  const inputClass =
    "w-full pl-10 pr-10 py-2.5 bg-input-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-brand-500/60 focus:border-brand-500 transition-all";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <div className="absolute right-5 top-5"><ThemeToggle /></div>

      <div className="mb-8 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500/15 text-brand-600 dark:text-brand-500">
          <Shield className="h-6 w-6" />
        </div>
        <p className="font-bold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>Bastion</p>
      </div>

      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card shadow-xl shadow-black/5">
        <div className="border-b border-border px-8 py-7">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-success-50 text-success-600">
            <CheckCircle2 className="h-5 w-5" strokeWidth={2} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
            Payment received
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One last thing — choose a password and your workspace is ready.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-5 px-8 py-7">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
              <input type={show ? "text" : "password"} value={password} required minLength={8}
                onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" className={inputClass} />
              <button type="button" onClick={() => setShow((v) => !v)} tabIndex={-1}
                aria-label={show ? "Hide password" : "Show password"}
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground">
                {show ? <EyeOff className="h-4 w-4" strokeWidth={1.5} /> : <Eye className="h-4 w-4" strokeWidth={1.5} />}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Confirm password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
              <input type={show ? "text" : "password"} value={confirm} required minLength={8}
                onChange={(e) => setConfirm(e.target.value)} placeholder="Type it again" className={inputClass} />
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm text-danger-700 dark:text-danger-500">
              {error}
            </div>
          )}

          <button type="submit" disabled={submitting}
            className="group flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-[#241a06] shadow-sm transition-all hover:bg-brand-600 disabled:opacity-50">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create my workspace
            {!submitting && <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
          </button>

          <p className="text-center text-xs text-muted-foreground">
            Keep this page open until it finishes. If anything goes wrong, your payment is
            safe and the link stays valid for 7 days.
          </p>
        </form>
      </div>
    </div>
  );
}
