import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Lock, Mail, Loader2, Users, CheckCheck } from "lucide-react";
import { ROLE_HOMES, useAuth } from "../lib/auth";

const FEATURES = [
  "Employee lifecycle management",
  "Automated payroll engine",
  "Real-time attendance tracking",
  "Compliance & audit logging",
];

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, profile, loading, signIn } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="grid min-h-screen lg:grid-cols-[45%_55%]">

      {/* ── Brand panel (desktop only) ── */}
      <div
        className="relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex"
        style={{ background: "linear-gradient(145deg, #022c22 0%, #064e3b 55%, #065f46 100%)" }}
      >
        {/* Ambient glow */}
        <div className="pointer-events-none absolute inset-0">
          <div
            className="absolute -right-24 -top-24 h-80 w-80 rounded-full"
            style={{ background: "radial-gradient(circle, rgba(16,185,129,0.25), transparent 65%)" }}
          />
          <div
            className="absolute -bottom-16 -left-16 h-64 w-64 rounded-full"
            style={{ background: "radial-gradient(circle, rgba(5,150,105,0.2), transparent 65%)" }}
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: "radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px)",
              backgroundSize: "24px 24px",
            }}
          />
        </div>

        {/* Logo */}
        <div className="relative flex items-center gap-3">
          <div
            className="flex h-11 w-11 items-center justify-center rounded-xl shadow-lg"
            style={{ background: "rgba(16,185,129,0.25)", border: "1px solid rgba(16,185,129,0.3)" }}
          >
            <Users className="h-5 w-5 text-emerald-300" />
          </div>
          <div>
            <p className="text-lg font-bold leading-none tracking-tight">Workforce CRM</p>
            <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-widest text-emerald-400/70">
              Employee Management
            </p>
          </div>
        </div>

        {/* Body copy */}
        <div className="relative space-y-7">
          <h2 className="text-[28px] font-bold leading-tight tracking-tight">
            From hire to payslip —<br />
            <span className="text-emerald-400">every operation in one place.</span>
          </h2>
          <p className="max-w-sm text-[14px] leading-relaxed text-emerald-100/60">
            Manage your workforce, automate payroll, track attendance, and maintain compliance — all from a single, intuitive platform built for operations at scale.
          </p>
          <div className="space-y-3">
            {FEATURES.map((f) => (
              <div key={f} className="flex items-center gap-3">
                <CheckCheck className="h-4 w-4 flex-shrink-0 text-emerald-400" />
                <span className="text-sm text-emerald-100/75">{f}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-[12px] text-emerald-900/80">Workforce CRM · A TechxServe Product</p>
      </div>

      {/* ── Form panel ── */}
      <div className="flex flex-col items-center justify-center bg-slate-50 px-6 py-12">

        {/* Mobile brand */}
        <div className="mb-8 flex items-center gap-3 lg:hidden">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-700 shadow">
            <Users className="h-4 w-4 text-white" />
          </div>
          <p className="font-bold text-slate-900">Workforce CRM</p>
        </div>

        <div className="w-full max-w-sm">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">

            {/* Card header accent */}
            <div className="border-b border-slate-100 px-8 py-7">
              <h1 className="text-2xl font-bold text-slate-900">Welcome back</h1>
              <p className="mt-1 text-sm text-slate-500">Sign in to your workspace to continue.</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-5 px-8 py-7">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" strokeWidth={1.5} />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="name@company.com"
                    className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:border-transparent transition-all"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" strokeWidth={1.5} />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:border-transparent transition-all"
                  />
                </div>
              </div>

              {error && (
                <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2.5 rounded-lg">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 px-4 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-2 shadow-sm"
                style={{ background: submitting ? "#059669" : "linear-gradient(135deg, #059669, #047857)" }}
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                Sign In
              </button>
            </form>
          </div>

          {/* TechxServe attribution */}
          <div className="mt-8 flex flex-col items-center gap-3">
            <a
              href="https://techxserve.com"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-opacity hover:opacity-80"
            >
              <img src="/logo.png" alt="TechxServe" className="h-[72px] w-auto" />
            </a>
            <p className="text-xs font-bold text-slate-600">Built by TechxServe</p>
            <div className="flex items-center gap-3 text-sm font-semibold">
              <a
                href="https://techxserve.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 hover:underline"
              >
                techxserve.com
              </a>
              <span className="text-slate-300">·</span>
              <a href="mailto:info@techxserve.com" className="text-emerald-700 hover:underline">
                info@techxserve.com
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
