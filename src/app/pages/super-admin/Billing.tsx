import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  AlertTriangle, CheckCircle2, CreditCard, ExternalLink, Loader2, Sparkles, Users,
} from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  buyAiTopup, changePlan, guardCapState, openBillingPortal, useBilling,
} from "../../lib/billing";
import { AI_TOPUP_PACKS, PRICING, computePricing, money, normaliseGuards } from "../../lib/pricing";

// Billing home for an org's own subscription: what they pay for, how much of it
// they are using, and the two things they can buy (a bigger plan, more AI
// credit). Everything that moves money goes through the billing-manage edge
// function — this screen never talks to Stripe directly.

/** The subscription's state, said in words rather than a status code. */
const STATUS_COPY: Record<string, { label: string; tone: "ok" | "warn" | "bad" }> = {
  active: { label: "Active", tone: "ok" },
  trialing: { label: "Trial", tone: "ok" },
  past_due: { label: "Payment failed", tone: "warn" },
  unpaid: { label: "Unpaid", tone: "bad" },
  canceled: { label: "Cancelled", tone: "bad" },
  incomplete: { label: "Incomplete", tone: "warn" },
};

function Card({ title, icon, children, action }: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {icon}{title}
        </h2>
        {action}
      </header>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

/** A used/allowed bar that turns amber inside the buffer and red at the cap. */
function Meter({ used, limit, hardLimit }: { used: number; limit: number; hardLimit: number }) {
  const pct = hardLimit > 0 ? Math.min((used / hardLimit) * 100, 100) : 0;
  const paidPct = hardLimit > 0 ? Math.min((limit / hardLimit) * 100, 100) : 0;
  const tone = used > hardLimit ? "bg-danger-500" : used > limit ? "bg-warning-500" : "bg-brand-500";
  return (
    <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
      {/* Where the paid plan ends and the buffer begins. */}
      <div className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${paidPct}%` }} />
    </div>
  );
}

export default function Billing() {
  const { profile } = useAuth();
  const { summary, loading, reload } = useBilling();
  const [searchParams] = useSearchParams();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canManage = profile?.role === "super_admin" || profile?.role === "super_super_admin";

  // Stripe redirects back here after a top-up. The webhook is what actually
  // grants the credit, and it can land a beat after the browser does — so
  // reload rather than assume, and say "on its way" rather than a number.
  useEffect(() => {
    const t = searchParams.get("topup");
    if (t === "success") {
      setNotice("Payment received. Your AI credit will appear within a few seconds.");
      const timer = setTimeout(() => { void reload(); }, 2500);
      return () => clearTimeout(timer);
    }
    if (t === "canceled") setNotice("Top-up cancelled — nothing was charged.");
  }, [searchParams, reload]);

  const cap = useMemo(() => guardCapState(summary), [summary]);

  // Plan editor state, seeded from the live plan once it loads.
  const [guards, setGuards] = useState<number | null>(null);
  const [care, setCare] = useState<boolean | null>(null);
  useEffect(() => {
    if (!summary) return;
    setGuards((g) => g ?? summary.guard_limit ?? PRICING.slider.default);
    setCare((c) => c ?? summary.plan_care);
  }, [summary]);

  const draftQuote = useMemo(
    () => computePricing(guards ?? PRICING.slider.default, care ?? false),
    [guards, care],
  );

  const run = async (key: string, fn: () => Promise<{ url?: string; ok?: boolean } | { error: string }>) => {
    setBusy(key); setError(null); setNotice(null);
    const res = await fn();
    if ("error" in res) { setError(res.error); setBusy(null); return; }
    if (res.url) { window.location.href = res.url; return; }
    await reload();
    setNotice("Your plan has been updated. Stripe will settle the difference on your next invoice.");
    setBusy(null);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your plan…
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        No billing information for this company.
      </div>
    );
  }

  const status = summary.billing_status ? STATUS_COPY[summary.billing_status] : null;
  const planChanged =
    guards !== null && care !== null &&
    (guards !== summary.guard_limit || care !== summary.plan_care);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
          Plan &amp; billing
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What you pay for, what you're using, and how to change it.
        </p>
      </header>

      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-success-200 bg-success-50 px-3 py-2.5 text-sm text-success-700 dark:text-success-500">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm text-danger-700 dark:text-danger-500">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
          <span>{error}</span>
        </div>
      )}

      {/* A company created by hand has no plan and nothing here applies. */}
      {cap.uncapped && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
          <span>
            This company was set up manually, so it has no guard limit and no self-serve
            subscription. Billing is handled outside the app.
          </span>
        </div>
      )}

      {/* ── current plan ── */}
      <Card
        title="Your plan"
        icon={<CreditCard className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />}
        action={status ? (
          <span className={
            "rounded-full px-2.5 py-1 text-xs font-semibold " +
            (status.tone === "ok" ? "bg-success-50 text-success-700"
              : status.tone === "warn" ? "bg-warning-50 text-warning-700"
              : "bg-danger-50 text-danger-700")
          }>{status.label}</span>
        ) : undefined}
      >
        <div className="grid gap-5 sm:grid-cols-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Monthly</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
              {summary.plan_price_pkr != null ? money(summary.plan_price_pkr) : "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Guards covered</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
              {summary.guard_limit ?? "Unlimited"}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Renews</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
              {summary.current_period_end
                ? new Date(summary.current_period_end).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
                : summary.subscription_expires_at ?? "—"}
            </p>
          </div>
        </div>

        {summary.plan_care && (
          <p className="mt-4 text-xs text-muted-foreground">
            Includes {PRICING.care.label} — priority support and onboarding.
          </p>
        )}

        {summary.has_subscription && canManage && (
          <button
            onClick={() => run("portal", openBillingPortal)}
            disabled={busy === "portal"}
            className="mt-5 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {busy === "portal" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" strokeWidth={1.5} />}
            Card, invoices &amp; cancellation
          </button>
        )}
      </Card>

      {/* ── guard usage ── */}
      {!cap.uncapped && (
        <Card title="Guards" icon={<Users className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />}>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm text-foreground">
              <b className="text-2xl font-bold tabular-nums">{cap.used}</b>
              <span className="ml-2 text-muted-foreground">of {cap.limit} covered</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {cap.remaining === 0
                ? "No room left"
                : `${cap.remaining} more can be added`}
            </p>
          </div>

          <div className="mt-3">
            <Meter used={cap.used} limit={cap.limit} hardLimit={cap.limit + cap.buffer} />
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Your plan covers {cap.limit} guards. We allow {cap.buffer} over that as breathing
            room, so you are only stopped at {cap.limit + cap.buffer}. Office staff don't count.
          </p>

          {cap.atHardLimit && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm text-danger-700 dark:text-danger-500">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
              <span>
                You've used your buffer as well. Adding another guard will be refused until
                you raise your plan below.
              </span>
            </div>
          )}
          {cap.inBuffer && !cap.atHardLimit && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2.5 text-sm text-warning-700 dark:text-warning-500">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
              <span>
                You're {cap.used - cap.limit} over your paid plan and into the {cap.buffer}-guard
                buffer. You can keep working, but raise your plan before the buffer runs out.
              </span>
            </div>
          )}
        </Card>
      )}

      {/* ── change plan ── */}
      {!cap.uncapped && summary.has_subscription && canManage && guards !== null && care !== null && (
        <Card title="Change your plan">
          <label className="block text-sm font-medium text-foreground">Guards covered</label>
          <div className="mt-3 flex items-center gap-4">
            <input type="range" min={PRICING.slider.min} max={PRICING.slider.max} step={PRICING.slider.step}
              value={Math.min(guards, PRICING.slider.max)}
              onChange={(e) => setGuards(normaliseGuards(Number(e.target.value)))}
              className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-brand-500" />
            <input type="number" min={PRICING.slider.min} max={PRICING.inputMax} value={guards}
              onChange={(e) => setGuards(normaliseGuards(Number(e.target.value)))}
              className="w-24 rounded-lg border border-border bg-input-background px-3 py-2 text-right text-sm font-semibold tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500/60" />
          </div>

          <label className="mt-4 flex cursor-pointer items-start gap-3">
            <input type="checkbox" checked={care} onChange={(e) => setCare(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-brand-500" />
            <span className="text-sm">
              <b className="text-foreground">{PRICING.care.label}</b>
              <span className="block text-xs text-muted-foreground">
                Priority support and onboarding · {money(PRICING.care.price)}/month
              </span>
            </span>
          </label>

          <div className="mt-5 space-y-2 rounded-lg bg-muted/40 p-4">
            {draftQuote.lines.map((l) => (
              <div key={l.label} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-muted-foreground">
                  <span className="text-foreground">{l.label}</span> <em className="text-xs not-italic">{l.detail}</em>
                </span>
                <b className="tabular-nums text-foreground">{money(l.amount)}</b>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2 text-sm">
              <span className="font-semibold text-foreground">New monthly total</span>
              <b className="tabular-nums text-foreground">{money(draftQuote.total)}</b>
            </div>
            <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
              <span>Included AI credit</span>
              <span className="tabular-nums">{money(draftQuote.aiCredit)}/month</span>
            </div>
          </div>

          {guards < cap.used && (
            <p className="mt-3 text-xs text-danger-700 dark:text-danger-500">
              You already have {cap.used} guards on the books. Pick {cap.used} or more.
            </p>
          )}

          <button
            onClick={() => run("plan", () => changePlan(guards, care))}
            disabled={!planChanged || guards < cap.used || busy === "plan"}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-[#241a06] transition-colors hover:bg-brand-600 disabled:opacity-50"
          >
            {busy === "plan" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {planChanged ? "Update my plan" : "No changes to apply"}
          </button>
          <p className="mt-2 text-xs text-muted-foreground">
            The new limit applies straight away. Stripe works out the part-month difference
            and puts it on your next invoice — nothing is charged right now.
          </p>
        </Card>
      )}

      {/* ── AI credit ── */}
      <Card title="AI credit" icon={<Sparkles className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />}>
        {cap.uncapped ? (
          <p className="text-sm text-muted-foreground">
            AI usage isn't metered on this company — it has no self-serve plan, so the
            assistant runs without a credit limit.
          </p>
        ) : (
        <>
        <div className="grid gap-5 sm:grid-cols-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Available now</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{money(summary.ai_credit_available)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Monthly allowance</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{money(summary.ai_credit_monthly)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Top-up balance</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{money(summary.ai_credit_topup)}</p>
          </div>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          Your allowance resets every renewal and does not roll over. Top-ups you buy never
          expire and are only used once the monthly allowance is gone.
        </p>

        {summary.ai_credit_available <= 0 && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2.5 text-sm text-warning-700 dark:text-warning-500">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
            <span>Your AI credit is used up. The assistant is paused until you top up or your plan renews.</span>
          </div>
        )}

        {canManage && summary.has_subscription && (
          <div className="mt-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Buy more</p>
            <div className="flex flex-wrap gap-2">
              {AI_TOPUP_PACKS.map((p) => (
                <button key={p.id}
                  onClick={() => run(p.id, () => buyAiTopup(p.id))}
                  disabled={busy === p.id}
                  className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
                  {busy === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {money(p.credit)}
                </button>
              ))}
            </div>
          </div>
        )}
        </>
        )}
      </Card>
    </div>
  );
}
