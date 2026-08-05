# Signup, billing, guard caps and AI credits

How a new org buys Bastion, what stops them exceeding what they paid for, and
how the AI assistant is metered. Written to be followed top to bottom the first
time you set it up.

---

## 1. The rule this is built around

**Nothing exists until the money arrives.**

A visitor who fills in the signup form and then closes the tab leaves behind one
row in `signup_intents` and nothing else. No company, no login, no auth user.
The company and its super admin are created by `signup-complete`, which refuses
to run unless the matching intent is in status `paid`.

That is enforced on the server. The UI cannot skip it, and neither can anyone
calling the API directly.

Users **created by a super admin** are different: they are made through the
existing `create-user` function and simply sign in. They never see a payment
screen and they cost nothing extra — you sell guards, not seats.

---

## 2. The flow, end to end

```
Landing page ──► /signup ──► Stripe Checkout ──► /signup/complete ──► signed in
   slider          form         (card)             choose password
     │               │             │                     │
     │               ▼             ▼                     ▼
     │        signup_intents   webhook marks      company + super admin
     │         (pending)         it 'paid'           created here
     │
     └─ guards + care carried through in the URL
```

1. **`/signup`** — company name, contact name, email, guard count, Care on/off.
   No password field: collecting one before payment would mean storing it
   somewhere while they are away at Stripe.
2. **`billing-checkout`** re-prices the plan server-side (the browser's number is
   never trusted), writes a `pending` intent and opens a Stripe Checkout
   subscription session.
3. Stripe takes the card and fires `checkout.session.completed`.
   **`stripe-webhook`** flips the intent to `paid`.
4. Stripe redirects to **`/signup/complete?token=…&session_id=…`**.
5. They choose a password. **`signup-complete`** verifies the intent is `paid`,
   then creates the company (Chart of Accounts, Head Office branch and expense
   categories all auto-seed), the auth user, and the `super_admin` profile.
6. They are signed straight in.

### The race that would otherwise bite

Stripe redirects the browser back *immediately*, often before the webhook lands.
If `signup-complete` only trusted the webhook, a fast customer would hit
"payment not received" on a payment that plainly succeeded.

So it also accepts `session_id` and asks Stripe directly. It checks
`session.metadata.intent_id` matches the intent, so a paid session belonging to
someone else cannot be replayed to claim a free org.

---

## 3. What you must set up (once)

### 3.1 Stripe secrets

You gave me a **publishable** key (`pk_live_…`). That one is public by design and
cannot create charges — it isn't used anywhere in this build, because Checkout is
opened server-side and the browser is just redirected to a Stripe-hosted URL.

What the server needs is the **secret** key. Set it as a function secret; never
put it in `.env.local`, the repo, or a chat window:

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_xxx
supabase secrets set APP_URL=https://your-app-domain
supabase secrets set PKR_PER_USD=280
```

`PKR_PER_USD` is the exchange rate. See §6 — **this needs a human to review it
periodically.**

### 3.2 Deploy the functions

`stripe-webhook`, `billing-checkout` and `signup-complete` are reached by people
who are not logged in (or by Stripe), so they must skip JWT verification.
`billing-manage` must keep it.

```bash
supabase functions deploy billing-checkout  --no-verify-jwt
supabase functions deploy signup-complete   --no-verify-jwt
supabase functions deploy stripe-webhook    --no-verify-jwt
supabase functions deploy billing-manage
supabase functions deploy ai-chat
```

### 3.3 The webhook endpoint

In the Stripe dashboard → Developers → Webhooks → Add endpoint:

* URL: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
* Events:
  * `checkout.session.completed`
  * `invoice.paid`
  * `invoice.payment_failed`
  * `customer.subscription.updated`
  * `customer.subscription.deleted`

Copy the signing secret and set it:

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
```

**No Products or Prices need creating in the dashboard.** The monthly amount is a
pure function of guard count, so pre-making one Price per possible plan would
mean thousands of them. The functions create prices inline instead.

### 3.4 The billing portal

Stripe dashboard → Settings → Billing → Customer portal → activate it. Without
this, the "Card, invoices & cancellation" button returns an error.

---

## 4. Pricing

The model lives in **one file**: `supabase/functions/_shared/pricing.ts`.
`src/app/lib/pricing.ts` re-exports it for the browser.

That matters. The landing calculator, the signup form, the Billing screen and the
code that builds the Stripe line item all import the same function. The number
on the slider and the number on the card cannot drift apart.

```
total = 7,500 platform fee
      + marginal per-guard bands (1–50 free, 51–100 @85, 101–250 @70,
                                  251–500 @55, 501+ @45)
      + 5,000 if Bastion Care
```

Verified against the landing page's own reference case:

| Guards | Care | Total PKR | Per guard | AI credit | Charged (USD cents) |
|-------:|:----:|----------:|----------:|----------:|--------------------:|
| 50 | – | 7,500 | 150 | 250 | 2,679 |
| 51 | – | 7,585 | 149 | 500 | 2,709 |
| **180** | – | **17,350** | **96** | **1,250** | 6,197 |
| 250 | – | 22,250 | 89 | 1,250 | 7,947 |
| 1,000 | ✓ | 63,500 | 64 | 5,000 | 22,679 |
| 5,000 | – | 238,500 | 48 | 5,000 | 85,179 |

To change a rate, edit `PRICING` in the shared file. Everything follows.

---

## 5. The guard cap

**Rule:** a plan covers `guard_limit` guards. Five more are allowed as a buffer.
The guard after that is refused.

* **Who counts** — everyone except `office_staff`, excluding `Inactive`.
  So `client`, `armed`, `gunman` and `reliever` all count; `On Leave` still
  counts, because the guard is still on the books.
* **Where it is enforced** — a trigger on `employees`
  (`enforce_guard_limit`). Not in the UI, so the API cannot be used to get
  around it.
* **What the user sees** — `GuardCapBanner` on Employee Management:
  amber while inside the buffer ("you're 2 over, 3 left"), red at the ceiling
  ("the next guard will be refused"), with a link to upgrade. Silent otherwise.
* **Legacy companies** — any company with `guard_limit IS NULL` is uncapped.
  Every company that existed before this feature is in that state, so nothing
  switched on retroactively for them.

Verified behaviour:

| Situation | Result |
|---|---|
| 6 guards past the paid plan | refused, with a message naming the limit and the count |
| 2 past the plan (inside the 5 buffer) | allowed |
| adding office staff while at the cap | allowed |
| deactivating a guard while over the cap | allowed |
| company with no plan | never capped |

---

## 6. Currency

Stripe has no Pakistani merchant country, so **prices are quoted in PKR and
charged in USD** at the rate in `PKR_PER_USD` (default 280).

Every row that represents money stores the PKR amount, the USD cents *and* the
rate used, so an old charge can still be explained after you change the rate.

> **This needs a human.** If the real rate moves and `PKR_PER_USD` does not, you
> are silently discounting or overcharging every customer. Put a reminder in your
> calendar. Changing it does not touch existing subscriptions — Stripe keeps
> billing the USD amount agreed at signup until the plan is changed.

Conversions round **up** to the cent, so rounding can never bill less than the
quote.

---

## 7. AI credits

Sold as a monthly PKR allowance set by the plan tier, with prepaid top-ups.

* **Monthly allowance** resets on every renewal and **does not roll over**. The
  forfeit is written to the ledger explicitly rather than the number quietly
  changing.
* **Top-ups never expire** and are spent only after the monthly allowance is
  gone — the customer's own money outlives the freebie.
* **Packs:** PKR 1,000 / 2,500 / 5,000.

### How usage is priced

`gpt-5-mini` at list price ($0.25 / $2.00 per million in/out tokens), times a
**2× markup**, converted at the same rate as subscriptions.

What that buys on the 180-guard tier (PKR 1,250/month):

| Request | Charged | Requests inside the allowance |
|---|---:|---:|
| typical (4k in, 400 out) | PKR 1.01 | ~1,240 |
| heavy (20k in, 1.5k out) | PKR 4.48 | ~279 |

The markup is a knob: `AI_COST.markup` in the shared pricing file.

### Gate behaviour

Credit is checked **before** the model runs and charged **after** (token counts
aren't knowable in advance). The last question of a month can therefore overdraw
slightly — deliberately, because refusing an answer the customer has credit for
is the worse failure.

At zero credit the assistant returns a plain-English message pointing at
Plan & Billing.

**Legacy orgs are exempt.** Metering only applies where `guard_limit IS NOT NULL`.
Without that exemption, deploying this would have switched off the assistant for
every existing company, since they all start at zero credit.

---

## 8. Testing it

Use Stripe test mode and card `4242 4242 4242 4242`, any future expiry, any CVC.

For local webhooks:

```bash
stripe listen --forward-to https://<project-ref>.supabase.co/functions/v1/stripe-webhook
```

Worth walking through:

1. **Happy path** — sign up for 60 guards, pay, set a password, land in the app.
   Check `companies.guard_limit = 60` and AI credit = PKR 500.
2. **No payment, no account** — start signup, abandon Checkout. Confirm the
   intent is `pending` and no company or login exists.
3. **Replay** — open `/signup/complete?token=…` for an unpaid intent. Must say
   payment not received.
4. **Reuse** — complete a signup, then load the same link again. Must say already
   claimed.
5. **Existing email** — try to sign up with an email that already has an account.
   Must be told to sign in.
6. **Guard cap** — add guards up to 60, then 61–65 (warned), then 66 (refused).
7. **Upgrade** — raise the plan on Plan & Billing, confirm the cap moves and
   Stripe shows a proration.
8. **Downgrade below headcount** — must be refused, naming the current count.
9. **AI credit** — talk to the assistant, watch the balance fall on Plan &
   Billing, buy a top-up, watch it rise.
10. **Renewal** — in Stripe, advance the test clock a month. `invoice.paid`
    should extend `subscription_expires_at` and reset the AI allowance.

Webhook deliveries are logged in `billing_events`, including failures.

---

## 9. Things worth knowing

* **Duplicate webhooks** are stopped by a unique index on
  `billing_events.stripe_event_id` — Stripe retries, and a retry that granted a
  second month of credit would be a silent compounding bug. A *failed* handler
  releases its claim so the retry can genuinely re-run, and leaves a
  `:failed:` row behind as a trail.
* **Failed payments do not lock anyone out immediately.** Stripe retries a
  declined card for days; cutting access on the first failure would lock out an
  org over a temporary bank decline. Status becomes `past_due`; access ends when
  the subscription is actually cancelled or `subscription_expires_at` passes.
* **Two bugs were found and fixed while building this** (see migration 0167 and
  the note in §10) — both pre-existing.

---

## 10. Bugs fixed along the way

**`log_audit_change()` made company deletion impossible** (migration 0167).
Deleting a company cascades to its children; Postgres removes the parent first,
so by the time a child's DELETE fired the audit trigger, the company was gone and
writing the audit row tripped `audit_log_company_id_fkey`. Every company delete
failed, for every caller. It surfaced here because `signup-complete` deletes the
half-built company if creating the super admin fails — without the fix, a failed
signup would strand an orphan company nobody could remove. The trigger now skips
the audit row when its company no longer exists.

**Wrong pinned Stripe API version.** `2025-01-27.acacia` did not match what
`stripe@17.7.0` ships (`2025-02-24.acacia`), which would have drifted the SDK's
types from the wire format. Caught by typechecking the functions under Deno.

---

## 11. Files

| File | What it does |
|---|---|
| `supabase/migrations/0165_billing_signup_and_ai_credits.sql` | plan columns, `signup_intents`, `billing_events`, `ai_usage`, `ai_credit_ledger`, guard-cap trigger, credit RPCs |
| `supabase/migrations/0166_ai_credit_exempt_legacy_companies.sql` | `ai_credit_status` — don't meter orgs with no plan |
| `supabase/migrations/0167_audit_log_skip_vanished_company.sql` | makes company deletion possible |
| `supabase/functions/_shared/pricing.ts` | **the** pricing model — shared by UI and server |
| `supabase/functions/_shared/billing.ts` | Stripe + Supabase clients, CORS, FX, caller auth |
| `supabase/functions/billing-checkout/` | step 1 — intent + Checkout session |
| `supabase/functions/signup-complete/` | step 2 — the paid-only gate that creates the org |
| `supabase/functions/stripe-webhook/` | the only thing that believes money moved |
| `supabase/functions/billing-manage/` | portal, plan change, AI top-up |
| `supabase/functions/ai-chat/` | now gated and metered |
| `src/app/lib/pricing.ts` | browser re-export of the shared model |
| `src/app/lib/billing.ts` | `billing_summary`, guard-cap maths, function calls |
| `src/app/pages/Signup.tsx` | step 1 UI with a live quote |
| `src/app/pages/SignupComplete.tsx` | step 2 UI — choose a password |
| `src/app/pages/super-admin/Billing.tsx` | plan, guard meter, AI credit, top-ups |
| `src/app/components/GuardCapBanner.tsx` | the amber/red warning |
