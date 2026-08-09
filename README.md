
  # CRM DESIGN

  This is a code bundle for CRM DESIGN. The original project is available at https://www.figma.com/design/5M5cPRyzAfgHnXG1bFNdjy/CRM-DESIGN.

  ## Running the code

  Run `npm i` to install the dependencies.

  Run `npm run dev` to start the development server.

## Google Analytics

GA4 runs on the **public surface only** — the landing page, `/login`, `/signup`
and `/signup/complete`. It is not loaded anywhere behind a login.

That boundary is a pathless layout route in `src/app/routes.tsx` wrapping those
four routes with `<PublicAnalytics>`; `/super-admin` and `/super-super-admin`
sit outside it. **Do not put the gtag snippet in `index.html`** — `vercel.json`
rewrites every path to `/index.html`, so a tag there would load inside the whole
CRM and send authenticated URLs to Google on every navigation.

### Configuration

Set `VITE_GA_MEASUREMENT_ID` (`G-…`) in Vercel, **Production only**. With the
variable unset the module is completely inert — no script, no requests — which
is what keeps local dev and preview deploys out of the reporting.

`VITE_*` values are inlined at **build** time. Setting the variable on an
existing deployment does nothing until you rebuild, without the build cache.

### Things that will silently break the numbers

- **Stripe referral exclusion.** Signup goes `/signup` → `checkout.stripe.com` →
  `/signup/complete`. Unless `checkout.stripe.com` is listed under *Admin → Data
  Streams → Configure tag settings → List unwanted referrals*, GA4 treats the
  return as a new session and credits every paid conversion to Stripe instead of
  the channel that actually produced it.
- **Data retention** defaults to 2 months on the free tier. Raise it to 14
  months; it cannot be applied retroactively.
- **Internal traffic filters** ship as *Testing*, which does nothing. They must
  be switched to *Active* under *Admin → Data filters*.
- **Ad blockers** drop 20–40% of events for a technical audience. Count signups
  from the `companies` table or Stripe, never from GA4.

### Query strings are allowlisted, not stripped

`/signup/complete` carries `?token=…&session_id=…`, and gtag defaults
`page_location` to `window.location.href`. `safeLocation()` in
`src/app/lib/analytics.ts` rebuilds the URL from a fixed allowlist (`utm_*`,
`gclid`, `fbclid`, `ref`, `guards`, `care`, `canceled`) so the signup token
cannot reach Google. **Add to `SAFE_PARAMS` only after checking the value can
never identify a person or authorise anything.**

### Events

| Event | Fires when | Notes |
|---|---|---|
| `page_view` | every client-side navigation on a public route | manual; `send_page_view` is off because a SPA loads the document once |
| `begin_checkout` | Stripe returns a Checkout URL, just before redirect | carries `currency: PKR` and the quoted `value` |
| `sign_up` | the company and super admin are actually created | the conversion — not fired on merely reaching the form |

Both are GA4 *recommended* event names, so they populate the built-in funnel and
monetisation reports without a custom report being built first.
  # employee-manager
