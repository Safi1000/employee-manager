import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Lock, Mail, Loader2 } from "lucide-react";
import { ROLE_HOMES, useAuth } from "../lib/auth";

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

  // Already authenticated â†’ bounce. (Otherwise we render the form immediately,
  // even while auth is still resolving, so the user never sees a blank spinner.)
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
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-slate-200 p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-medium text-slate-900 mb-2">Welcome Back</h1>
          <p className="text-slate-500 text-sm">Sign in to continue</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="block text-sm text-slate-700 mb-2">Email Address</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="name@company.com"
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-2">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢"
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
          </div>

          {error && (
            <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded">{error}</div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2 px-4 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}
