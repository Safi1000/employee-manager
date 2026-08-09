import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { trackPageView } from "../lib/analytics";

/**
 * Pathless layout route that turns Google Analytics on for the routes nested
 * beneath it — the landing page, login and the two signup steps — and nowhere
 * else.
 *
 * The whole point is what it does NOT wrap. /super-admin and
 * /super-super-admin sit outside it, so no authenticated URL, and nothing about
 * an employee, client or tenant, is ever sent to Google. Putting the tag in
 * index.html instead would have covered every route, because vercel.json
 * rewrites all paths to it.
 *
 * Mounting this component is also what loads the script at all: with no
 * VITE_GA_MEASUREMENT_ID set it does nothing and makes no requests, which is
 * why local dev and preview deploys stay out of the reporting.
 */
export default function PublicAnalytics() {
  const { pathname, search } = useLocation();

  // One page_view per client-side navigation. GA4's automatic pageview is
  // disabled in the config for exactly this reason: it fires on document load,
  // and a SPA only loads the document once.
  useEffect(() => {
    trackPageView(pathname, search);
  }, [pathname, search]);

  return <Outlet />;
}
