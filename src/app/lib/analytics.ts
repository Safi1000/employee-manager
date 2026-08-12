// Google Analytics 4, on the PUBLIC surface only.
//
// This is deliberately not the snippet Google hands you. That one goes in
// index.html — and vercel.json rewrites every path to /index.html, so it would
// load on every route in the app, including the whole CRM. Every navigation
// inside /super-admin would send its URL to Google.
//
// Instead the tag is injected on demand by <PublicAnalytics>, which is mounted
// on the marketing and signup routes and nowhere else. Nothing behind a login
// is ever measured.
//
// Two further protections live in here:
//
//   1. send_page_view is OFF. react-router navigates client-side, so the
//      automatic pageview would fire once on first load and then never again.
//      <PublicAnalytics> sends them manually instead.
//
//   2. Query strings are ALLOWLISTED, not stripped. /signup/complete carries
//      ?token=…&session_id=… — the token is what authorises creating the
//      account, and gtag defaults page_location to window.location.href, so
//      without this it would be shipped to Google's servers verbatim. Only
//      known-safe marketing params survive; anything unrecognised is dropped
//      rather than judged.
//
// Absent VITE_GA_MEASUREMENT_ID the whole module is inert — no script, no
// requests — which is what keeps local dev and preview deploys out of the data.

import { isNative } from "./platform";

const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;

// The native app never loads GA at all. Three reasons, any one sufficient:
// the public routes GA is scoped to do not exist in the app build (see
// routes.tsx), a third-party tracker inside an app is a declarable data
// collection on both App Store Privacy and Play Data Safety forms, and GA4 web
// sessions from a WebView pollute the website's acquisition reports with
// traffic that has no referrer and never converts.
const trackingAllowed = () => Boolean(MEASUREMENT_ID) && !isNative;

/**
 * Query params allowed through to Google. Campaign tags plus the two the
 * pricing calculator passes into the signup form, which are genuinely useful
 * for seeing what size plan people arrive intending to buy.
 *
 * `token` and `session_id` are absent on purpose and must stay that way.
 */
const SAFE_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "ref",
  "guards", "care", "canceled",
]);

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export const analyticsEnabled = () => trackingAllowed();

let injected = false;

/**
 * Adds the gtag script once. Safe to call on every navigation.
 */
function ensureTag(): boolean {
  // The single choke point every export below funnels through: no tag is ever
  // injected in the native build, so no gtag call anywhere can fire there.
  if (!trackingAllowed() || !MEASUREMENT_ID || typeof window === "undefined") return false;
  if (injected) return true;
  injected = true;

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  // Must stay a real `function` — gtag relies on `arguments`, which an arrow
  // function does not have.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", MEASUREMENT_ID, {
    // Pageviews are sent by hand — see the note at the top.
    send_page_view: false,
  });
  return true;
}

/**
 * Rebuilds a location with only the allowlisted query params, so nothing
 * sensitive can ride along in page_path or page_location.
 */
export function safeLocation(pathname: string, search: string): { path: string; url: string } {
  const kept = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(search)) {
    if (SAFE_PARAMS.has(k)) kept.append(k, v);
  }
  const qs = kept.toString();
  const path = qs ? `${pathname}?${qs}` : pathname;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return { path, url: `${origin}${path}` };
}

export function trackPageView(pathname: string, search: string) {
  if (!ensureTag()) return;
  const { path, url } = safeLocation(pathname, search);
  window.gtag!("event", "page_view", {
    page_path: path,
    // Set explicitly. Left alone, gtag reads window.location.href — which on
    // /signup/complete still contains the signup token.
    page_location: url,
    page_title: document.title,
  });
}

export function trackEvent(name: string, params: Record<string, unknown> = {}) {
  if (!ensureTag()) return;
  window.gtag!("event", name, params);
}

// ---------------------------------------------------------------------------
// The signup funnel
// ---------------------------------------------------------------------------
// GA4's own recommended event names, not invented ones: `begin_checkout` and
// `sign_up` populate the built-in funnel and monetisation reports, whereas a
// custom name would need a report building by hand before it showed anything.

/** Continue to Payment pressed — leaving for Stripe Checkout. */
export function trackBeginCheckout(args: { guards: number; care: boolean; value: number }) {
  trackEvent("begin_checkout", {
    currency: "PKR",
    value: args.value,
    items: [{
      item_id: args.care ? "bastion_care" : "bastion_base",
      item_name: args.care ? "Bastion + Care" : "Bastion",
      quantity: args.guards,
      price: args.value,
    }],
  });
}

/** The company and its super admin actually exist — the conversion. */
export function trackSignUp() {
  trackEvent("sign_up", { method: "stripe_checkout" });
}
