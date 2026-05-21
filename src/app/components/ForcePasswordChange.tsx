import { useState } from "react";
import { Lock, Loader2, ShieldCheck } from "lucide-react";
import { callChangePassword, useAuth } from "../lib/auth";

/**
 * Full-screen overlay shown when profile.must_change_password is true.
 * The user cannot navigate away until they set a new password.
 */
export default function ForcePasswordChange() {
  const { profile, refreshProfile } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!profile?.must_change_password) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    const res = await callChangePassword({ new_password: password });
    setSubmitting(false);

    if ("error" in res && res.error) {
      setError(res.error);
      return;
    }

    // Refresh profile so must_change_password becomes false
    await refreshProfile();
  };

  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/60 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-6 md:p-8">
        <div className="text-center mb-6">
          <div className="w-12 h-12 bg-brand-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <ShieldCheck className="w-6 h-6 text-brand-600" strokeWidth={1.5} />
          </div>
          <h2 className="text-xl font-medium text-slate-900 mb-1">Set Your Password</h2>
          <p className="text-sm text-slate-500">
            Your account was created with a temporary password. Please set a new password to continue.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">New Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                placeholder="At least 8 characters"
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Confirm Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                placeholder="Re-enter your password"
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              />
            </div>
          </div>

          {error && (
            <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded">{error}</div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 px-4 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Set Password & Continue
          </button>
        </form>
      </div>
    </div>
  );
}
