import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { ArrowRight, Building2, Check, Loader2, Mail, ShieldCheck, User } from "lucide-react";
import { ROLE_HOMES, useAuth } from "../lib/auth";
import { PRICING, computePricing, money, normaliseGuards } from "../lib/pricing";
import { startCheckout } from "../lib/billing";
import ThemeToggle from "../components/ThemeToggle";

// Step 1 of self-serve signup.
//
// Nothing is created here. The form collects who they are and what size plan
// they want, and hands off to Stripe Checkout. The account itself is made on
// the way back, in SignupComplete, and only if Stripe confirms the payment —
// so a visitor who abandons this page leaves nothing behind to sign in with.
//
// Notably there is NO password field. Collecting a password before payment
// would mean storing it somewhere while they are away at Stripe, and a
// password sitting in an application table is a liability with no upside.

function Shield({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className}>
      <path d="M16 2.5 4.5 7v8.5c0 6.6 4.7 10.5 11.5 13.3C22.8 25.9 27.5 22 27.5 15.5V7z" stroke="currentColor" strokeWidth="1.7" />
      <path d="M13 15.5a3 3 0 0 1 3-3 3 3 0 0 1 3 3 3 3 0 0 1-3 3M19 16.5a3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export default function Signup() {
  const { session, profile, loading } = useAuth();
  const [params] = useSearchParams();

  // The landing calculator passes its state through, so someone who priced
  // 240 guards with Care on arrives with the form already set that way.
  const [guards, setGuards] = useState(() => {
    const raw = Number(params.get("guards"));
    return Number.isFinite(raw) && raw > 0 ? normaliseGuards(raw) : PRICING.slider.default;
  });
  const [care, setCare] = useState(params.get("care") === "1");
  const [companyName, setCompanyName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canceled = params.get("canceled") === "1";

  // The quote shown here is computed by the same function the edge function
  // uses to build the Stripe line item, so what they see is what they pay.
  const quote = useMemo(() => computePricing(guards, care), [guards, care]);

  useEffect(() => { document.title = "Sign up · Bastion"; }, []);

  if (!loading && session && profile) return <Navigate to={ROLE_HOMES[profile.role]} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await startCheckout({
      email: email.trim().toLowerCase(),
      full_name: fullName.trim() || null,
      company_name: companyName.trim(),
      guards,
      care,
    });
    if ("error" in res) {
      setError(res.error);
      setSubmitting(false);
      return;
    }
    // Hand the browser to Stripe. Deliberately not a router navigate — this
    // leaves the app entirely.
    window.location.href = res.url;
  };

  const inputClass =
    "w-full pl-10 pr-4 py-2.5 bg-input-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-brand-500/60 focus:border-brand-500 transition-all";

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-10 lg:grid-cols-[1fr_400px] lg:py-16">

        {/* ── form ── */}
        <div>
          <div className="mb-8 flex items-center justify-between">
            <Link to="/" className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500/15 text-brand-600 dark:text-brand-500">
                <Shield className="h-6 w-6" />
              </div>
              <div>
                <p className="font-bold leading-none tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>Bastion</p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Security-services CRM</p>
              </div>
            </Link>
            <ThemeToggle />
          </div>

          <h1 className="text-3xl font-bold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
            Start your workspace
          </h1>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            Pick the size of your roster, pay, and your workspace is ready. You'll be the
            super admin and can add your own users straight away — they sign in directly,
            no second payment.
          </p>

          {canceled && (
            <div className="mt-6 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2.5 text-sm text-warning-700 dark:text-warning-500">
              Checkout was cancelled. Nothing was charged — you can try again below.
            </div>
          )}

          <form onSubmit={submit} className="mt-8 space-y-6">
            <div className="rounded-2xl border border-border bg-card p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Your company</h2>

              <div className="mt-4 space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Company name</label>
                  <div className="relative">
                    <Building2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
                    <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} required
                      placeholder="Acme Security Services" className={inputClass} />
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your name</label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
                    <input value={fullName} onChange={(e) => setFullName(e.target.value)}
                      placeholder="Full name" className={inputClass} />
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Work email</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
                      placeholder="you@company.com" className={inputClass} />
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    This becomes your super admin login. You'll choose a password after payment.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Your plan</h2>

              <label className="mt-4 block text-sm font-medium text-foreground">How many guards do you run?</label>
              <div className="mt-3 flex items-center gap-4">
                <input
                  type="range"
                  min={PRICING.slider.min}
                  max={PRICING.slider.max}
                  step={PRICING.slider.step}
                  value={Math.min(guards, PRICING.slider.max)}
                  onChange={(e) => setGuards(normaliseGuards(Number(e.target.value)))}
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-brand-500"
                />
                <input
                  type="number"
                  min={PRICING.slider.min}
                  max={PRICING.inputMax}
                  value={guards}
                  onChange={(e) => setGuards(normaliseGuards(Number(e.target.value)))}
                  className="w-24 rounded-lg border border-border bg-input-background px-3 py-2 text-right text-sm font-semibold tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500/60"
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                You can add {PRICING.slider.max.toLocaleString()} on the slider, or type up to {PRICING.inputMax.toLocaleString()}.
                Change it any time — upgrades take effect immediately.
              </p>

              <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/40">
                <input type="checkbox" checked={care} onChange={(e) => setCare(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-brand-500" />
                <span className="text-sm">
                  <b className="text-foreground">{PRICING.care.label}</b>
                  <span className="block text-xs text-muted-foreground">
                    Priority support and onboarding · {money(PRICING.care.price)}/month
                  </span>
                </span>
              </label>
            </div>

            {error && (
              <div className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm text-danger-700 dark:text-danger-500">
                {error}
              </div>
            )}

            <button type="submit" disabled={submitting}
              className="group flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-3 text-sm font-semibold text-[#241a06] shadow-sm transition-all hover:bg-brand-600 disabled:opacity-50">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Continue to payment
              {!submitting && <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
            </button>

            <p className="text-center text-xs text-muted-foreground">
              Already have an account? <Link to="/login" className="font-semibold text-brand-700 hover:underline dark:text-brand-500">Sign in</Link>
            </p>
          </form>
        </div>

        {/* ── live quote ── */}
        <aside className="lg:sticky lg:top-16 lg:self-start">
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xl shadow-black/5">
            <div className="border-b border-border px-6 py-4">
              <p className="text-sm font-semibold text-foreground">Your monthly invoice</p>
              <p className="text-xs text-muted-foreground">Updates as you change the plan.</p>
            </div>

            <div className="space-y-3 px-6 py-5">
              {quote.lines.map((l) => (
                <div key={l.label} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">
                    <span className="text-foreground">{l.label}</span>{" "}
                    <em className="text-xs not-italic">{l.detail}</em>
                  </span>
                  <b className="tabular-nums text-foreground">{money(l.amount)}</b>
                </div>
              ))}

              <div className="flex items-baseline justify-between gap-3 border-t border-border pt-3 text-base">
                <span className="font-semibold text-foreground">Total per month</span>
                <b className="tabular-nums text-foreground">{money(quote.total)}</b>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Per guard</p>
                  <p className="mt-1 text-sm font-bold tabular-nums text-foreground">{money(quote.perGuard)}</p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">AI credit / month</p>
                  <p className="mt-1 text-sm font-bold tabular-nums text-foreground">{money(quote.aiCredit)}</p>
                </div>
              </div>
            </div>

            <div className="space-y-2 border-t border-border bg-muted/30 px-6 py-4 text-xs text-muted-foreground">
              {[
                `Covers ${quote.guards.toLocaleString()} guards, plus a 5-guard buffer`,
                "Unlimited users on your team, at no extra cost",
                "Cancel or change your plan any time",
              ].map((t) => (
                <div key={t} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-success-600" strokeWidth={3} />
                  <span>{t}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 flex items-start gap-2 px-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
            <span>
              Payment is handled by Stripe — we never see your card. Prices are quoted in PKR
              and charged as the equivalent in USD.
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
