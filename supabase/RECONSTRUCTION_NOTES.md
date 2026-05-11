# Database reconstruction notes

This folder rebuilds the Supabase project from scratch using only the frontend
code as the source of truth (`src/app/lib/supabase.ts` + insert/update sites in
all super-admin pages).

## How to apply

1. Create a new Supabase project (or use the recovered one).
2. Open the SQL Editor and paste **`migrations/0001_init.sql`**. Run it.
3. Verify:
   - 21 tables in `public` (Database → Tables).
   - 3 storage buckets: `employee-documents`, `expense-receipts`, `invoice-attachments`.
   - `expense_categories` has 11 seeded rows.
4. Create `.env.local` at the project root:

   ```
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon-key>
   ```

5. `npm run dev` and try adding a Client / Location / Employee. Codes (`CLI-0001`, `EMP-0001`) should auto-generate.

## What this migration covers (high confidence)

- All 21 tables with column types, FKs, CHECK constraints, and NOT NULLs derived from `supabase.ts`.
- Unique constraints confirmed in code:
  - `attendance_records (employee_id, attendance_date)` — from upsert `onConflict`.
  - `payslips (employee_id, period_month)` — from upsert `onConflict`.
  - `invoices (client_id, invoice_number)` — added because invoice numbers are per-client human input.
- Auto-generated codes via triggers:
  - `clients.client_code` → `CLI-0001`, `CLI-0002`, …
  - `employees.employee_code` → `EMP-0001`, …
- `updated_at` triggers on every table that has the column in `supabase.ts`.
- Storage buckets created (private by default).
- 11 hardcoded expense categories seeded (matches `HARDCODED_EXPENSE_CATEGORIES`).

## What you must decide manually

### 1. Auto-code format
The migration uses `CLI-0001` / `EMP-0001` (4-digit zero-padded). If your old
project used a different format (3 digits, different prefix, year suffix),
update `gen_client_code` / `gen_employee_code` in the migration.

If you have any old screenshots or exports showing real codes, share them and
I'll match the exact format.

### 2. Invoice numbering
Invoices currently require the user to type `invoice_number` manually (see
`Invoices.tsx`). If the old DB auto-generated these too, tell me the format and
I'll add a trigger.

### 3. RLS (Row Level Security)
**Currently disabled.** The app works against the anon key with full read/write
access. Before going to production:

- Decide on auth: Supabase Auth, custom JWT, or admin-only?
- Add policies. A reasonable starting point once auth is wired:
  ```sql
  alter table public.<table> enable row level security;
  create policy "auth read"  on public.<table> for select using (auth.role() = 'authenticated');
  create policy "auth write" on public.<table> for all    using (auth.role() = 'authenticated');
  ```

### 4. Storage bucket policies
Buckets are created **private**. To allow uploads/downloads from the app, add
policies in Dashboard → Storage → each bucket → Policies. Minimum for testing:
allow `authenticated` (or `anon` if no auth yet) full access to each bucket.

### 5. Defaults I guessed
These weren't in the code but seemed sensible:

| Column | Default I chose | Confidence |
|---|---|---|
| `clients.allowed_leaves_per_month` | 0 | high (insert site passes 0) |
| `clients.opening_balance` | 0 | medium (insert omits, must have a default) |
| `employees.shift` | `'day'` | medium |
| `employees.status` | `'Active'` | high (insert omits, status enum starts with Active) |
| `inventory_items.quantity` | 1 | medium |
| `inventory_items.status` | `'Available'` | high |
| `invoices.status` | `'Pending'` | high |
| `payslips.payment_mode` | `'Cash'` | medium |
| `payslips.status` | `'Pending'` | high |
| `important_dates.advance_notice_days` | 7 | low (pure guess) |
| `recurring_alerts.advance_notice_days` | 7 | low |
| `recurring_alerts.active` | `true` | high |

Override any of these by editing the migration before running, or with `alter table`.

### 6. Things not in the migration

- **Realtime subscriptions** — none used in the code.
- **Edge functions** — none in the code.
- **Database functions/RPCs** — no `.rpc()` calls anywhere in the frontend.
- **Indexes beyond FKs + common filters** — add more if you see slow queries.

## If you recover the old project later

Don't run this migration on the recovered project — it will conflict. Use this
only when starting fresh.
