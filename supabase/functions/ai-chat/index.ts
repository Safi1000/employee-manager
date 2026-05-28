// Edge function: ai-chat
// Read-only AI assistant for the Employee Manager CRM.
//
// Architecture (Scenario A — see chat with user):
//   - The browser sends the user's message + chat history + the user's JWT.
//   - We create a Supabase client *with that JWT* (NOT the service role key) so
//     every query naturally inherits the user's RLS scope. That gives us free
//     multi-tenant isolation: company A's user can never see company B's rows.
//   - The model gets a fixed catalogue of read-only tools. tool_choice="auto"
//     lets it small-talk ("thanks") but the system prompt explicitly forbids
//     answering anything not backed by a tool.
//   - Per-tool permission gates mirror the frontend's `hasPermission()`:
//     accounting tools need `accounting.view`, etc. super_admin /
//     super_super_admin bypass all checks, matching auth.tsx behaviour.
//
// Why a hand-written tool list instead of letting the model write SQL:
//   - Predictable cost — each tool has a known query plan.
//   - No SQL-injection / prompt-injection surface.
//   - Easy to log which tool ran (for cost analysis + future Scenario B).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// gpt-5-mini per user's choice. Strong on tool calling, cheap, fast.
const MODEL = "gpt-5-mini";
// Hard ceiling on tool-call iterations per request, in case the model gets
// stuck in a loop. Five is enough for "compare X to Y" multi-step questions.
const MAX_TOOL_ITERATIONS = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

type CallerProfile = {
  user_id: string;
  company_id: string | null;
  role: string;
  permissions: string[];
};

async function resolveCaller(jwt: string): Promise<CallerProfile | null> {
  // Service-role client just for the auth lookup. After this, all data reads
  // go through `userClient` so RLS does the company scoping.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) return null;
  const { data: p } = await admin
    .from("profiles")
    .select("company_id, role, permissions, view_as_company")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!p) return null;
  return {
    user_id: data.user.id,
    // SSA users get scoped to whichever company they're "viewing as" — same
    // semantics as the frontend auth context.
    company_id: (p.view_as_company as string | null) ?? (p.company_id as string | null),
    role: p.role as string,
    permissions: (p.permissions as string[]) ?? [],
  };
}

function hasPermission(caller: CallerProfile, perm: string): boolean {
  if (caller.role === "super_super_admin") return true;
  if (caller.role === "super_admin") return true;
  return caller.permissions.includes(perm);
}

function hasAny(caller: CallerProfile, perms: string[]): boolean {
  return perms.some((p) => hasPermission(caller, p));
}

// ---------------------------------------------------------------------------
// Tool catalogue — JSON Schema definitions sent to OpenAI
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_cashflow_summary",
      description:
        "Returns cash inflow, outflow and net change for a given month. Sums cash and bank deltas from bank_transactions.",
      parameters: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description:
              "Month to summarise in YYYY-MM format. Use the current month if the user says 'this month'.",
          },
        },
        required: ["month"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_payroll_summary",
      description:
        "Returns total salary disbursed (net), count of payslips, and breakdown by status (pending / approved / disbursed) for a month.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM" },
        },
        required: ["month"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_top_employees_by_salary",
      description:
        "Returns the top N employees ordered by base salary, descending. Only includes active employees.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 5 },
        },
        required: ["limit"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_today_attendance",
      description:
        "Returns today's attendance counts: how many marked Present / Absent / Leave so far.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_outstanding_invoices",
      description:
        "Returns total outstanding receivables across all invoices, plus a list of the top N unpaid invoices.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_expenses_summary",
      description:
        "Returns total expenses for a month, with an optional breakdown by category.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM" },
          group_by_category: { type: "boolean", default: true },
        },
        required: ["month"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pending_cheques",
      description:
        "Returns total amount and list of cheques still in pending status (not yet cleared).",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bank_balances",
      description:
        "Returns the current balance of every bank account, plus the total across accounts.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_contract_endings",
      description:
        "Returns clients whose contract is ending within the given number of days. Used for renewal planning.",
      parameters: {
        type: "object",
        properties: {
          within_days: { type: "integer", minimum: 1, maximum: 365, default: 60 },
        },
        required: ["within_days"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_employee",
      description:
        "Searches for an employee by name, employee code, or phone number. Returns the top matches with their key details.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, code, or phone" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_client",
      description:
        "Searches for a client by name or client code. Returns the top matches.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_employee_counts",
      description:
        "Returns counts of employees grouped by status (active / inactive) and by category (client / office / reliever).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },

  // ---------- Overview / dashboards ----------
  {
    type: "function",
    function: {
      name: "get_company_overview",
      description:
        "High-level snapshot of the business: active employee count, this-month payroll disbursed, total outstanding receivables, total bank + cash on hand, today's marked attendance count. One call answers 'how are we doing?'",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },

  // ---------- Cashflow / banking ----------
  {
    type: "function",
    function: {
      name: "get_cashflow_breakdown",
      description:
        "Breaks down cash movement for a month by what caused it (invoice payments, expenses, payroll, advances, transfers, other). Use this when the user asks WHY cashflow looks the way it does.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM" },
        },
        required: ["month"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cash_balance",
      description: "Returns the current cash-on-hand balance from the treasury.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_bank_transactions",
      description:
        "Returns the most recent bank/cash transactions across all accounts.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 365, default: 7 },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
        },
        required: [],
      },
    },
  },

  // ---------- Payroll ----------
  {
    type: "function",
    function: {
      name: "get_payroll_by_dimension",
      description:
        "Aggregates a month's payroll grouped by one dimension: 'branch', 'client', or 'location'. Use this when the user wants payroll broken down by group.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM" },
          dimension: { type: "string", enum: ["branch", "client", "location"] },
        },
        required: ["month", "dimension"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_undisbursed_payslips",
      description:
        "Returns payslips that have been generated but not yet disbursed for the given month, with their total amount.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM (defaults to current month)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_employee_payslip",
      description:
        "Returns the payslip details (base, bonus, deductions, advance, net, status) for one employee in a given month. Match the employee by name or code.",
      parameters: {
        type: "object",
        properties: {
          employee_query: { type: "string", description: "Name or employee code" },
          month: { type: "string", description: "YYYY-MM" },
        },
        required: ["employee_query", "month"],
      },
    },
  },

  // ---------- Employees ----------
  {
    type: "function",
    function: {
      name: "get_recent_hires",
      description:
        "Returns employees who joined within the last N days, with their join date and base salary.",
      parameters: {
        type: "object",
        properties: {
          within_days: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_average_salary",
      description:
        "Returns average base salary across active employees, optionally filtered by category (client / office_staff / reliever).",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["client", "office_staff", "reliever"],
            description: "Optional category filter",
          },
        },
        required: [],
      },
    },
  },

  // ---------- Attendance ----------
  {
    type: "function",
    function: {
      name: "get_attendance_summary",
      description:
        "Counts attendance statuses (Present / Absent / Leave) for an entire month, optionally narrowed to a specific employee.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM" },
          employee_query: {
            type: "string",
            description: "Optional: employee name or code to filter to one person",
          },
        },
        required: ["month"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_absent_today",
      description:
        "Returns the list of employees marked Absent today (with name and code).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },

  // ---------- Invoices / receivables ----------
  {
    type: "function",
    function: {
      name: "get_invoices_summary",
      description:
        "Returns totals for a month: how much was invoiced, how much was received (across all clients).",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM" },
        },
        required: ["month"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_invoice_aging",
      description:
        "Buckets outstanding invoice amounts by how overdue they are: 0-30 days, 31-60, 61-90, 90+ days. The classic aging report.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_top_clients_by_revenue",
      description:
        "Returns top N clients by amount actually received in a period. Period can be 'month' (current month) or 'year' (current year-to-date).",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["month", "year"], default: "year" },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_client_receivables",
      description:
        "Returns total outstanding amount and list of unpaid invoices for one client. Match the client by name or code.",
      parameters: {
        type: "object",
        properties: {
          client_query: { type: "string" },
        },
        required: ["client_query"],
      },
    },
  },

  // ---------- Expenses / advances ----------
  {
    type: "function",
    function: {
      name: "get_top_expense_categories",
      description:
        "Returns top N expense categories ranked by total spend over a period ('month' = current month, 'year' = year-to-date).",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["month", "year"], default: "month" },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_advances_summary",
      description:
        "Returns total advances given to employees in a month, count of advances, and breakdown by payment mode.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM (defaults to current month)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_advances_for_employee",
      description:
        "Returns all advances given to one employee, sorted by date desc, with running total.",
      parameters: {
        type: "object",
        properties: {
          employee_query: { type: "string", description: "Name or code" },
        },
        required: ["employee_query"],
      },
    },
  },

  // ---------- Cheques ----------
  {
    type: "function",
    function: {
      name: "get_cheques_summary",
      description:
        "Returns counts and totals of cheques for a month, split by status (pending / cleared) and type (payment / receipt).",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM" },
        },
        required: ["month"],
      },
    },
  },

  // ---------- Clients ----------
  {
    type: "function",
    function: {
      name: "get_clients_summary",
      description:
        "Returns a count of clients by type (security_services / guard_deployment) and how many have an active contract right now.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },

  // ---------- Compliance ----------
  {
    type: "function",
    function: {
      name: "get_upcoming_compliance_alerts",
      description:
        "Returns important_dates rows that are due within the next N days (licence renewals, audits, etc).",
      parameters: {
        type: "object",
        properties: {
          within_days: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        },
        required: [],
      },
    },
  },

  // ---------- Inventory ----------
  {
    type: "function",
    function: {
      name: "get_inventory_summary",
      description:
        "Returns total inventory items grouped by kind (weapons / uniforms / equipment) with available vs issued counts.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_low_stock_items",
      description:
        "Returns inventory items with quantity at or below the given threshold. Default threshold is 5.",
      parameters: {
        type: "object",
        properties: {
          threshold: { type: "integer", minimum: 0, maximum: 100, default: 5 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_issuances",
      description:
        "Returns inventory items issued to employees within the last N days.",
      parameters: {
        type: "object",
        properties: {
          within_days: { type: "integer", minimum: 1, maximum: 90, default: 7 },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        required: [],
      },
    },
  },

  // ---------- Tasks (Kanban) ----------
  {
    type: "function",
    function: {
      name: "get_my_tasks",
      description:
        "Returns tasks assigned to the calling user, optionally filtered by status (todo / in_progress / done).",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["todo", "in_progress", "done"],
            description: "Optional status filter",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_overdue_tasks",
      description:
        "Returns tasks whose due_date has passed and are not yet marked done. Super-admins see all; regular users see only their own.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  // ---- Sprint 1–5 additions ----
  {
    type: "function",
    function: {
      name: "get_contracts_summary",
      description:
        "Returns count of contracts broken down by status (active, expired, terminated, draft). Use for questions like 'how many active contracts do we have'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_contracts_ending_soon",
      description:
        "Returns contracts whose end_date is within the next N days. Use for renewal-watch / contract-ending questions.",
      parameters: {
        type: "object",
        properties: {
          days_ahead: { type: "integer", minimum: 1, maximum: 365, default: 60 },
        },
        required: ["days_ahead"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_contract",
      description:
        "Find a contract by client name or contract_code (e.g. CON-0001). Returns matching contracts with full detail.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Client name fragment or full contract code." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_incidents_summary",
      description:
        "Counts of incidents grouped by severity and status. Optionally filter to a date range. Use for safety/incident review questions.",
      parameters: {
        type: "object",
        properties: {
          days_back: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        },
        required: ["days_back"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_incidents",
      description:
        "Returns the most recent incidents with code, severity, category, status, and date. Use when the user asks about recent / latest incidents.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        required: ["limit"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_incidents_for_employee",
      description:
        "Returns all incidents linked to a specific guard, identified by employee_code (e.g. EMP-0001) or exact full name. Useful for disciplinary / review questions about a specific guard.",
      parameters: {
        type: "object",
        properties: {
          employee: { type: "string", description: "Employee code or full name." },
        },
        required: ["employee"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_roster_gaps",
      description:
        "Returns count of unassigned slots in the deployment roster for the next N days. Use for capacity / understaffing questions.",
      parameters: {
        type: "object",
        properties: {
          days_ahead: { type: "integer", minimum: 1, maximum: 60, default: 7 },
        },
        required: ["days_ahead"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_expiring_licences",
      description:
        "Aggregates expiring items across the system: weapon licences, guard service licences, medical fitness, probation ends, contract ends, and company compliance dates. Returns counts and the top expiring items sorted by days remaining.",
      parameters: {
        type: "object",
        properties: {
          days_ahead: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        },
        required: ["days_ahead"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_trial_balance",
      description:
        "Returns the Trial Balance from the double-entry journal for a date range: every account with non-zero debit/credit totals, plus the grand totals. Use for accounting/audit questions.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Start date YYYY-MM-DD. Default: start of current year." },
          to: { type: "string", description: "End date YYYY-MM-DD. Default: today." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_period_close_status",
      description:
        "Returns the list of closed accounting periods (months) and whether the current month is locked. Use to answer 'is May closed?' / 'which months are open?' questions.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_clients_with_expiring_contracts",
      description:
        "Lists clients with at least one master contract_end date within the next N days. Use for client retention / renewal questions.",
      parameters: {
        type: "object",
        properties: {
          days_ahead: { type: "integer", minimum: 1, maximum: 365, default: 60 },
        },
        required: ["days_ahead"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_employee_compliance",
      description:
        "Returns one employee's full compliance picture: CNIC, weapon licence + expiry, guard service licence + expiry, medical fitness expiry, EOBI registration, probation end. Identify by employee_code or full name.",
      parameters: {
        type: "object",
        properties: {
          employee: { type: "string", description: "Employee code or full name." },
        },
        required: ["employee"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function monthRange(month: string): { start: string; endExclusive: string } {
  // month = "YYYY-MM" → ["YYYY-MM-01", "YYYY-(MM+1)-01")
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) throw new Error(`Invalid month format: ${month} (expected YYYY-MM)`);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const endExclusive = `${ny}-${String(nm).padStart(2, "0")}-01`;
  return { start, endExclusive };
}

const todayUTC = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Tool executor — runs against the per-user Supabase client (RLS-scoped)
// ---------------------------------------------------------------------------

async function runTool(
  name: string,
  args: Record<string, unknown>,
  db: SupabaseClient,
  caller: CallerProfile,
): Promise<unknown> {
  // Permission gates. The error string flows back to the model so it can tell
  // the user politely, e.g. "You don't have access to payroll data."
  const denied = (perm: string) =>
    ({ error: `permission_denied`, required_permission: perm });

  switch (name) {
    case "get_cashflow_summary": {
      if (!hasPermission(caller, "cashflow.view")) return denied("cashflow.view");
      const { start, endExclusive } = monthRange(String(args.month));
      const { data, error } = await db
        .from("bank_transactions")
        .select("amount, cash_delta, account_delta, kind")
        .gte("created_at", start)
        .lt("created_at", endExclusive);
      if (error) throw new Error(error.message);
      let inflow = 0, outflow = 0;
      for (const t of data ?? []) {
        const delta = Number(t.cash_delta ?? 0) + Number(t.account_delta ?? 0);
        if (delta > 0) inflow += delta;
        else outflow += Math.abs(delta);
      }
      return {
        month: args.month,
        inflow_pkr: inflow,
        outflow_pkr: outflow,
        net_pkr: inflow - outflow,
        transaction_count: data?.length ?? 0,
      };
    }

    case "get_payroll_summary": {
      if (!hasPermission(caller, "payroll.view")) return denied("payroll.view");
      const month = String(args.month);
      const { start } = monthRange(month);
      const { data, error } = await db
        .from("payslips")
        .select("net_salary, status, disbursed")
        .eq("period_month", start);
      if (error) throw new Error(error.message);
      const byStatus: Record<string, { count: number; total: number }> = {};
      let totalDisbursed = 0, totalAll = 0;
      for (const p of data ?? []) {
        const net = Number(p.net_salary ?? 0);
        totalAll += net;
        const key = (p.status as string) ?? "unknown";
        if (!byStatus[key]) byStatus[key] = { count: 0, total: 0 };
        byStatus[key].count++;
        byStatus[key].total += net;
        if (p.disbursed) totalDisbursed += net;
      }
      // Help the assistant give a useful answer when the requested month is
      // empty / has stub-only rows: look up the most recent month that DOES
      // have real payslip data so the AI can offer it as a fallback.
      let mostRecentPopulated: string | null = null;
      if (totalAll === 0) {
        const { data: recent } = await db
          .from("payslips")
          .select("period_month")
          .gt("net_salary", 0)
          .lt("period_month", start)
          .order("period_month", { ascending: false })
          .limit(1);
        mostRecentPopulated = (recent?.[0] as { period_month?: string } | undefined)
          ?.period_month?.slice(0, 7) ?? null;
      }
      return {
        month,
        payslip_count: data?.length ?? 0,
        total_net_pkr: totalAll,
        total_disbursed_pkr: totalDisbursed,
        by_status: byStatus,
        most_recent_month_with_data: mostRecentPopulated,
      };
    }

    case "get_top_employees_by_salary": {
      if (!hasPermission(caller, "employees.view")) return denied("employees.view");
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 5));
      // Status is stored capitalized ("Active"), not lowercase — case-sensitive
      // .eq filter was returning zero rows.
      const { data, error } = await db
        .from("employees")
        .select("employee_code, full_name, base_salary, status, category")
        .eq("status", "Active")
        .order("base_salary", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return { employees: data ?? [] };
    }

    case "get_today_attendance": {
      if (!hasPermission(caller, "attendance.view")) return denied("attendance.view");
      const today = todayUTC();
      const { data, error } = await db
        .from("attendance_records")
        .select("status")
        .eq("attendance_date", today);
      if (error) throw new Error(error.message);
      const counts: Record<string, number> = {};
      for (const r of data ?? []) {
        const k = (r.status as string) ?? "unknown";
        counts[k] = (counts[k] ?? 0) + 1;
      }
      return { date: today, counts, total_marked: data?.length ?? 0 };
    }

    case "get_outstanding_invoices": {
      if (!hasPermission(caller, "invoices.view")) return denied("invoices.view");
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
      const { data, error } = await db
        .from("invoices")
        .select(
          "invoice_number, invoice_date, invoice_amount, withholding_tax, amount_received, status, client_id, clients(name)",
        )
        .order("invoice_date", { ascending: false });
      if (error) throw new Error(error.message);
      const unpaid = (data ?? [])
        .map((inv: any) => {
          const outstanding =
            Number(inv.invoice_amount ?? 0) -
            Number(inv.withholding_tax ?? 0) -
            Number(inv.amount_received ?? 0);
          return {
            invoice_number: inv.invoice_number,
            client_name: inv.clients?.name ?? null,
            invoice_date: inv.invoice_date,
            outstanding_pkr: outstanding,
          };
        })
        .filter((x) => x.outstanding_pkr > 0.01);
      const total = unpaid.reduce((acc, x) => acc + x.outstanding_pkr, 0);
      unpaid.sort((a, b) => b.outstanding_pkr - a.outstanding_pkr);
      return {
        total_outstanding_pkr: total,
        unpaid_count: unpaid.length,
        top_unpaid: unpaid.slice(0, limit),
      };
    }

    case "get_expenses_summary": {
      if (!hasPermission(caller, "expenses.view")) return denied("expenses.view");
      const { start, endExclusive } = monthRange(String(args.month));
      const { data, error } = await db
        .from("expenses")
        .select("amount, category_id, expense_categories(name)")
        .gte("expense_date", start)
        .lt("expense_date", endExclusive);
      if (error) throw new Error(error.message);
      let total = 0;
      const byCat: Record<string, number> = {};
      for (const e of (data ?? []) as any[]) {
        const amt = Number(e.amount ?? 0);
        total += amt;
        const cat = e.expense_categories?.name ?? "Uncategorized";
        byCat[cat] = (byCat[cat] ?? 0) + amt;
      }
      return {
        month: args.month,
        total_pkr: total,
        expense_count: data?.length ?? 0,
        by_category: args.group_by_category === false ? undefined : byCat,
      };
    }

    case "get_pending_cheques": {
      if (!hasPermission(caller, "accounting.view")) return denied("accounting.view");
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
      const { data, error } = await db
        .from("cheques")
        .select("cheque_number, amount, cheque_date, cheque_type, recipient")
        .eq("status", "pending")
        .order("cheque_date", { ascending: true });
      if (error) throw new Error(error.message);
      const total = (data ?? []).reduce((acc, c: any) => acc + Number(c.amount ?? 0), 0);
      return {
        total_pending_pkr: total,
        pending_count: data?.length ?? 0,
        cheques: (data ?? []).slice(0, limit),
      };
    }

    case "get_bank_balances": {
      if (!hasPermission(caller, "accounting.view")) return denied("accounting.view");
      const { data, error } = await db
        .from("bank_accounts")
        .select("bank_name, account_number, balance")
        .order("bank_name");
      if (error) throw new Error(error.message);
      const total = (data ?? []).reduce((acc, b: any) => acc + Number(b.balance ?? 0), 0);
      return { total_pkr: total, accounts: data ?? [] };
    }

    case "get_contract_endings": {
      if (!hasAny(caller, ["compliance.view", "settings.view"])) {
        return denied("compliance.view");
      }
      const days = Math.max(1, Math.min(365, Number(args.within_days) || 60));
      const today = todayUTC();
      const cutoff = addDays(days);
      const { data, error } = await db
        .from("clients")
        .select("client_code, name, contract_end")
        .not("contract_end", "is", null)
        .gte("contract_end", today)
        .lte("contract_end", cutoff)
        .order("contract_end", { ascending: true });
      if (error) throw new Error(error.message);
      return { window_days: days, ending_count: data?.length ?? 0, clients: data ?? [] };
    }

    case "lookup_employee": {
      if (!hasPermission(caller, "employees.view")) return denied("employees.view");
      const q = String(args.query ?? "").trim();
      if (!q) return { error: "query_required" };
      const { data, error } = await db
        .from("employees")
        .select("employee_code, full_name, phone, status, category, base_salary, department")
        .or(`full_name.ilike.%${q}%,employee_code.ilike.%${q}%,phone.ilike.%${q}%`)
        .limit(5);
      if (error) throw new Error(error.message);
      return { matches: data ?? [] };
    }

    case "lookup_client": {
      // No dedicated client permission; gate by any of the data perms that
      // imply you'd be looking clients up at all.
      if (!hasAny(caller, ["invoices.view", "settings.view", "accounting.view"])) {
        return denied("invoices.view");
      }
      const q = String(args.query ?? "").trim();
      if (!q) return { error: "query_required" };
      const { data, error } = await db
        .from("clients")
        .select("client_code, name, email, phone, contract_start, contract_end")
        .or(`name.ilike.%${q}%,client_code.ilike.%${q}%`)
        .limit(5);
      if (error) throw new Error(error.message);
      return { matches: data ?? [] };
    }

    case "get_employee_counts": {
      if (!hasPermission(caller, "employees.view")) return denied("employees.view");
      const { data, error } = await db
        .from("employees")
        .select("status, category");
      if (error) throw new Error(error.message);
      const byStatus: Record<string, number> = {};
      const byCategory: Record<string, number> = {};
      for (const e of data ?? []) {
        const s = (e.status as string) ?? "unknown";
        const c = (e.category as string) ?? "unknown";
        byStatus[s] = (byStatus[s] ?? 0) + 1;
        byCategory[c] = (byCategory[c] ?? 0) + 1;
      }
      return { total: data?.length ?? 0, by_status: byStatus, by_category: byCategory };
    }

    // ---------- Overview ----------
    case "get_company_overview": {
      // Each sub-query is gated by its own permission; we silently skip pieces
      // the user can't see so the AI gets back a partial-but-valid overview
      // rather than a hard failure.
      const out: Record<string, unknown> = {};
      const month = todayUTC().slice(0, 7);
      const { start } = monthRange(month);
      if (hasPermission(caller, "employees.view")) {
        const { count } = await db
          .from("employees")
          .select("*", { count: "exact", head: true })
          .eq("status", "Active");
        out.active_employees = count ?? 0;
      }
      if (hasPermission(caller, "payroll.view")) {
        const { data: ps } = await db
          .from("payslips")
          .select("net_salary, disbursed")
          .eq("period_month", start);
        let disbursed = 0;
        for (const p of ps ?? []) if (p.disbursed) disbursed += Number(p.net_salary ?? 0);
        out.payroll_disbursed_this_month_pkr = disbursed;
      }
      if (hasPermission(caller, "invoices.view")) {
        const { data: inv } = await db
          .from("invoices")
          .select("invoice_amount, withholding_tax, amount_received");
        let outstanding = 0;
        for (const i of inv ?? []) {
          outstanding +=
            Number(i.invoice_amount ?? 0) -
            Number(i.withholding_tax ?? 0) -
            Number(i.amount_received ?? 0);
        }
        out.outstanding_receivables_pkr = Math.max(0, outstanding);
      }
      if (hasPermission(caller, "accounting.view")) {
        const { data: banks } = await db.from("bank_accounts").select("balance");
        const bankTotal = (banks ?? []).reduce((a, b: any) => a + Number(b.balance ?? 0), 0);
        const { data: treas } = await db
          .from("treasury")
          .select("cash_balance")
          .limit(1)
          .maybeSingle();
        out.bank_total_pkr = bankTotal;
        out.cash_on_hand_pkr = Number((treas as any)?.cash_balance ?? 0);
      }
      if (hasPermission(caller, "attendance.view")) {
        const today = todayUTC();
        const { count } = await db
          .from("attendance_records")
          .select("*", { count: "exact", head: true })
          .eq("attendance_date", today);
        out.attendance_marked_today = count ?? 0;
      }
      return out;
    }

    // ---------- Cashflow / banking ----------
    case "get_cashflow_breakdown": {
      if (!hasPermission(caller, "cashflow.view")) return denied("cashflow.view");
      const { start, endExclusive } = monthRange(String(args.month));
      const { data, error } = await db
        .from("bank_transactions")
        .select("kind, cash_delta, account_delta")
        .gte("created_at", start)
        .lt("created_at", endExclusive);
      if (error) throw new Error(error.message);
      const buckets: Record<string, { inflow: number; outflow: number }> = {};
      for (const t of data ?? []) {
        const kind = (t.kind as string) ?? "other";
        const delta = Number(t.cash_delta ?? 0) + Number(t.account_delta ?? 0);
        if (!buckets[kind]) buckets[kind] = { inflow: 0, outflow: 0 };
        if (delta > 0) buckets[kind].inflow += delta;
        else buckets[kind].outflow += Math.abs(delta);
      }
      return { month: args.month, breakdown_by_kind: buckets };
    }
    case "get_cash_balance": {
      if (!hasPermission(caller, "accounting.view")) return denied("accounting.view");
      const { data } = await db.from("treasury").select("cash_balance").limit(1).maybeSingle();
      return { cash_balance_pkr: Number((data as any)?.cash_balance ?? 0) };
    }
    case "get_recent_bank_transactions": {
      if (!hasPermission(caller, "accounting.view")) return denied("accounting.view");
      const days = Math.max(1, Math.min(365, Number(args.days) || 7));
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - days);
      const { data, error } = await db
        .from("bank_transactions")
        .select("created_at, kind, description, amount, cash_delta, account_delta")
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return { days, count: data?.length ?? 0, transactions: data ?? [] };
    }

    // ---------- Payroll ----------
    case "get_payroll_by_dimension": {
      if (!hasPermission(caller, "payroll.view")) return denied("payroll.view");
      const dim = String(args.dimension) as "branch" | "client" | "location";
      const { start } = monthRange(String(args.month));
      // Join out the employee's grouping column. PostgREST can't disambiguate
      // employees→branches on its own because the `employee_branches` junction
      // table creates a second relationship; force the direct FK explicitly.
      const { data, error } = await db
        .from("payslips")
        .select(
          "net_salary, disbursed, employees(branch_id, client_id, location_id, " +
            "branches!employees_branch_id_fkey(name), " +
            "clients(name), locations(name))",
        )
        .eq("period_month", start);
      if (error) throw new Error(error.message);
      const groups: Record<string, { count: number; total: number; disbursed: number }> = {};
      for (const p of (data ?? []) as any[]) {
        const emp = p.employees;
        let key = "Unassigned";
        if (dim === "branch") key = emp?.branches?.name ?? "Unassigned";
        else if (dim === "client") key = emp?.clients?.name ?? "Office / no client";
        else if (dim === "location") key = emp?.locations?.name ?? "Unassigned";
        if (!groups[key]) groups[key] = { count: 0, total: 0, disbursed: 0 };
        const net = Number(p.net_salary ?? 0);
        groups[key].count++;
        groups[key].total += net;
        if (p.disbursed) groups[key].disbursed += net;
      }
      return { month: args.month, dimension: dim, groups };
    }
    case "get_undisbursed_payslips": {
      if (!hasPermission(caller, "payroll.view")) return denied("payroll.view");
      const month = (args.month as string | undefined) ?? todayUTC().slice(0, 7);
      const { start } = monthRange(month);
      const { data, error } = await db
        .from("payslips")
        .select("net_salary, status, employees(employee_code, full_name)")
        .eq("period_month", start)
        .eq("disbursed", false);
      if (error) throw new Error(error.message);
      const total = (data ?? []).reduce((a, p: any) => a + Number(p.net_salary ?? 0), 0);
      return {
        month,
        undisbursed_count: data?.length ?? 0,
        undisbursed_total_pkr: total,
        payslips: (data ?? []).map((p: any) => ({
          employee_code: p.employees?.employee_code,
          full_name: p.employees?.full_name,
          net_salary: Number(p.net_salary ?? 0),
          status: p.status,
        })),
      };
    }
    case "get_employee_payslip": {
      if (!hasPermission(caller, "payroll.view")) return denied("payroll.view");
      const q = String(args.employee_query ?? "").trim();
      if (!q) return { error: "employee_query_required" };
      const { start } = monthRange(String(args.month));
      const { data: emp } = await db
        .from("employees")
        .select("id, employee_code, full_name")
        .or(`full_name.ilike.%${q}%,employee_code.ilike.%${q}%`)
        .limit(1)
        .maybeSingle();
      if (!emp) return { error: "employee_not_found", query: q };
      const { data: ps, error } = await db
        .from("payslips")
        .select("base_salary, per_day_salary, working_days, present_days, absent_days, leave_days, bonus, deductions, advance, income_tax, eobi, final_salary, net_salary, status, disbursed, disbursed_at")
        .eq("employee_id", (emp as any).id)
        .eq("period_month", start)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return {
        employee: emp,
        month: args.month,
        payslip: ps ?? null,
      };
    }

    // ---------- Employees ----------
    case "get_recent_hires": {
      if (!hasPermission(caller, "employees.view")) return denied("employees.view");
      const days = Math.max(1, Math.min(365, Number(args.within_days) || 30));
      const since = addDays(-days);
      const { data, error } = await db
        .from("employees")
        .select("employee_code, full_name, join_date, base_salary, category")
        .gte("join_date", since)
        .order("join_date", { ascending: false });
      if (error) throw new Error(error.message);
      return { window_days: days, count: data?.length ?? 0, employees: data ?? [] };
    }
    case "get_average_salary": {
      if (!hasPermission(caller, "employees.view")) return denied("employees.view");
      let q = db
        .from("employees")
        .select("base_salary")
        .eq("status", "Active");
      if (args.category) q = q.eq("category", String(args.category));
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const salaries = (data ?? []).map((e: any) => Number(e.base_salary ?? 0)).filter((n) => n > 0);
      if (salaries.length === 0) {
        return { count: 0, average_pkr: 0, category: args.category ?? "all" };
      }
      const avg = salaries.reduce((a, b) => a + b, 0) / salaries.length;
      return {
        count: salaries.length,
        average_pkr: Math.round(avg),
        category: args.category ?? "all",
      };
    }

    // ---------- Attendance ----------
    case "get_attendance_summary": {
      if (!hasPermission(caller, "attendance.view")) return denied("attendance.view");
      const { start, endExclusive } = monthRange(String(args.month));
      const q = String(args.employee_query ?? "").trim();
      let employeeId: string | null = null;
      let employeeInfo: unknown = null;
      if (q) {
        const { data: emp } = await db
          .from("employees")
          .select("id, employee_code, full_name")
          .or(`full_name.ilike.%${q}%,employee_code.ilike.%${q}%`)
          .limit(1)
          .maybeSingle();
        if (!emp) return { error: "employee_not_found", query: q };
        employeeId = (emp as any).id;
        employeeInfo = emp;
      }
      let query = db
        .from("attendance_records")
        .select("status")
        .gte("attendance_date", start)
        .lt("attendance_date", endExclusive);
      if (employeeId) query = query.eq("employee_id", employeeId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const counts: Record<string, number> = {};
      for (const r of data ?? []) {
        const k = (r.status as string) ?? "unknown";
        counts[k] = (counts[k] ?? 0) + 1;
      }
      return {
        month: args.month,
        employee: employeeInfo,
        total_records: data?.length ?? 0,
        counts,
      };
    }
    case "get_absent_today": {
      if (!hasPermission(caller, "attendance.view")) return denied("attendance.view");
      const today = todayUTC();
      const { data, error } = await db
        .from("attendance_records")
        .select("employees(employee_code, full_name)")
        .eq("attendance_date", today)
        .eq("status", "Absent");
      if (error) throw new Error(error.message);
      return {
        date: today,
        absent_count: data?.length ?? 0,
        employees: (data ?? []).map((r: any) => r.employees).filter(Boolean),
      };
    }

    // ---------- Invoices / receivables ----------
    case "get_invoices_summary": {
      if (!hasPermission(caller, "invoices.view")) return denied("invoices.view");
      const { start, endExclusive } = monthRange(String(args.month));
      const { data: inv, error } = await db
        .from("invoices")
        .select("invoice_amount, withholding_tax, amount_received, status")
        .gte("invoice_date", start)
        .lt("invoice_date", endExclusive);
      if (error) throw new Error(error.message);
      let invoiced = 0, received = 0, withheld = 0;
      for (const i of inv ?? []) {
        invoiced += Number(i.invoice_amount ?? 0);
        withheld += Number(i.withholding_tax ?? 0);
        received += Number(i.amount_received ?? 0);
      }
      // Receipts can also relate to invoices issued earlier — also surface
      // the cash that landed THIS month regardless of issue month.
      const { data: pays } = await db
        .from("invoice_payments")
        .select("amount")
        .gte("payment_date", start)
        .lt("payment_date", endExclusive);
      const receivedThisMonth = (pays ?? []).reduce(
        (a, p: any) => a + Number(p.amount ?? 0),
        0,
      );
      return {
        month: args.month,
        invoices_issued: inv?.length ?? 0,
        total_invoiced_pkr: invoiced,
        withholding_tax_pkr: withheld,
        total_received_against_these_invoices_pkr: received,
        total_payments_received_this_month_pkr: receivedThisMonth,
      };
    }
    case "get_invoice_aging": {
      if (!hasPermission(caller, "invoices.view")) return denied("invoices.view");
      const { data, error } = await db
        .from("invoices")
        .select("invoice_date, invoice_amount, withholding_tax, amount_received, clients(name)");
      if (error) throw new Error(error.message);
      const buckets = {
        "0_30_days": { count: 0, total_pkr: 0 },
        "31_60_days": { count: 0, total_pkr: 0 },
        "61_90_days": { count: 0, total_pkr: 0 },
        "over_90_days": { count: 0, total_pkr: 0 },
      };
      const now = new Date(todayUTC()).getTime();
      for (const i of (data ?? []) as any[]) {
        const outstanding =
          Number(i.invoice_amount ?? 0) -
          Number(i.withholding_tax ?? 0) -
          Number(i.amount_received ?? 0);
        if (outstanding <= 0.01) continue;
        const days = Math.floor((now - new Date(i.invoice_date).getTime()) / 86_400_000);
        const b =
          days <= 30 ? buckets["0_30_days"]
          : days <= 60 ? buckets["31_60_days"]
          : days <= 90 ? buckets["61_90_days"]
          : buckets["over_90_days"];
        b.count++;
        b.total_pkr += outstanding;
      }
      return { aging_buckets: buckets };
    }
    case "get_top_clients_by_revenue": {
      if (!hasPermission(caller, "invoices.view")) return denied("invoices.view");
      const period = (args.period as string) ?? "year";
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
      const today = todayUTC();
      const start =
        period === "month"
          ? `${today.slice(0, 7)}-01`
          : `${today.slice(0, 4)}-01-01`;
      // invoice_payments.client_id is null in practice — the canonical client
      // lives on the parent invoice. Embed invoices(client_id) and group via
      // that, falling back to a direct client_id if it ever IS populated.
      const { data, error } = await db
        .from("invoice_payments")
        .select(
          "amount, client_id, payment_date, " +
            "invoices(client_id, clients(name, client_code))",
        )
        .gte("payment_date", start);
      if (error) throw new Error(error.message);
      const byClient: Record<string, { name: string; code: string; total: number }> = {};
      for (const p of (data ?? []) as any[]) {
        const inv = p.invoices;
        const cid = p.client_id ?? inv?.client_id;
        if (!cid) continue;
        if (!byClient[cid]) {
          byClient[cid] = {
            name: inv?.clients?.name ?? "(unknown)",
            code: inv?.clients?.client_code ?? "",
            total: 0,
          };
        }
        byClient[cid].total += Number(p.amount ?? 0);
      }
      const ranked = Object.values(byClient)
        .sort((a, b) => b.total - a.total)
        .slice(0, limit);
      return {
        period,
        period_start: start,
        total_payments_considered: data?.length ?? 0,
        top_clients: ranked,
      };
    }
    case "get_client_receivables": {
      if (!hasPermission(caller, "invoices.view")) return denied("invoices.view");
      const q = String(args.client_query ?? "").trim();
      if (!q) return { error: "client_query_required" };
      const { data: client } = await db
        .from("clients")
        .select("id, client_code, name")
        .or(`name.ilike.%${q}%,client_code.ilike.%${q}%`)
        .limit(1)
        .maybeSingle();
      if (!client) return { error: "client_not_found", query: q };
      const { data: inv, error } = await db
        .from("invoices")
        .select("invoice_number, invoice_date, invoice_amount, withholding_tax, amount_received")
        .eq("client_id", (client as any).id)
        .order("invoice_date", { ascending: false });
      if (error) throw new Error(error.message);
      const unpaid = (inv ?? [])
        .map((i: any) => ({
          invoice_number: i.invoice_number,
          invoice_date: i.invoice_date,
          outstanding_pkr:
            Number(i.invoice_amount ?? 0) -
            Number(i.withholding_tax ?? 0) -
            Number(i.amount_received ?? 0),
        }))
        .filter((x) => x.outstanding_pkr > 0.01);
      const total = unpaid.reduce((a, x) => a + x.outstanding_pkr, 0);
      return { client, total_outstanding_pkr: total, unpaid_invoices: unpaid };
    }

    // ---------- Expenses / advances ----------
    case "get_top_expense_categories": {
      if (!hasPermission(caller, "expenses.view")) return denied("expenses.view");
      const period = (args.period as string) ?? "month";
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
      const today = todayUTC();
      const start =
        period === "month"
          ? `${today.slice(0, 7)}-01`
          : `${today.slice(0, 4)}-01-01`;
      const { data, error } = await db
        .from("expenses")
        .select("amount, expense_categories(name)")
        .gte("expense_date", start);
      if (error) throw new Error(error.message);
      const byCat: Record<string, number> = {};
      for (const e of (data ?? []) as any[]) {
        const name = e.expense_categories?.name ?? "Uncategorized";
        byCat[name] = (byCat[name] ?? 0) + Number(e.amount ?? 0);
      }
      const ranked = Object.entries(byCat)
        .map(([category, total]) => ({ category, total_pkr: total }))
        .sort((a, b) => b.total_pkr - a.total_pkr)
        .slice(0, limit);
      return { period, top_categories: ranked };
    }
    case "get_advances_summary": {
      if (!hasPermission(caller, "expenses.view")) return denied("expenses.view");
      const month = (args.month as string | undefined) ?? todayUTC().slice(0, 7);
      const { start, endExclusive } = monthRange(month);
      const { data, error } = await db
        .from("advances")
        .select("amount, payment_mode")
        .gte("advance_date", start)
        .lt("advance_date", endExclusive);
      if (error) throw new Error(error.message);
      const total = (data ?? []).reduce((a, x: any) => a + Number(x.amount ?? 0), 0);
      const byMode: Record<string, number> = {};
      for (const a of (data ?? []) as any[]) {
        const m = a.payment_mode ?? "Unknown";
        byMode[m] = (byMode[m] ?? 0) + Number(a.amount ?? 0);
      }
      // If the requested month is empty, surface the most recent month with
      // advances so the assistant can offer it as a fallback.
      let mostRecentPopulated: string | null = null;
      if ((data?.length ?? 0) === 0) {
        const { data: recent } = await db
          .from("advances")
          .select("advance_date")
          .lt("advance_date", start)
          .order("advance_date", { ascending: false })
          .limit(1);
        mostRecentPopulated = (recent?.[0] as { advance_date?: string } | undefined)
          ?.advance_date?.slice(0, 7) ?? null;
      }
      return {
        month,
        count: data?.length ?? 0,
        total_pkr: total,
        by_payment_mode: byMode,
        most_recent_month_with_data: mostRecentPopulated,
      };
    }
    case "get_advances_for_employee": {
      if (!hasPermission(caller, "expenses.view")) return denied("expenses.view");
      const q = String(args.employee_query ?? "").trim();
      if (!q) return { error: "employee_query_required" };
      const { data: emp } = await db
        .from("employees")
        .select("id, employee_code, full_name")
        .or(`full_name.ilike.%${q}%,employee_code.ilike.%${q}%`)
        .limit(1)
        .maybeSingle();
      if (!emp) return { error: "employee_not_found", query: q };
      const { data, error } = await db
        .from("advances")
        .select("advance_date, amount, payment_mode, notes")
        .eq("employee_id", (emp as any).id)
        .order("advance_date", { ascending: false });
      if (error) throw new Error(error.message);
      const total = (data ?? []).reduce((a, x: any) => a + Number(x.amount ?? 0), 0);
      return { employee: emp, total_pkr: total, advances: data ?? [] };
    }

    // ---------- Cheques ----------
    case "get_cheques_summary": {
      if (!hasPermission(caller, "accounting.view")) return denied("accounting.view");
      const { start, endExclusive } = monthRange(String(args.month));
      const { data, error } = await db
        .from("cheques")
        .select("amount, status, cheque_type")
        .gte("cheque_date", start)
        .lt("cheque_date", endExclusive);
      if (error) throw new Error(error.message);
      const out = {
        issued_count: 0,
        issued_total_pkr: 0,
        pending_count: 0,
        pending_total_pkr: 0,
        cleared_count: 0,
        cleared_total_pkr: 0,
        by_type: {} as Record<string, { count: number; total: number }>,
      };
      for (const c of (data ?? []) as any[]) {
        const amt = Number(c.amount ?? 0);
        out.issued_count++;
        out.issued_total_pkr += amt;
        if (c.status === "pending") {
          out.pending_count++;
          out.pending_total_pkr += amt;
        } else if (c.status === "cleared") {
          out.cleared_count++;
          out.cleared_total_pkr += amt;
        }
        const t = c.cheque_type ?? "unknown";
        if (!out.by_type[t]) out.by_type[t] = { count: 0, total: 0 };
        out.by_type[t].count++;
        out.by_type[t].total += amt;
      }
      return { month: args.month, ...out };
    }

    // ---------- Clients ----------
    case "get_clients_summary": {
      if (!hasAny(caller, ["invoices.view", "settings.view", "accounting.view"])) {
        return denied("invoices.view");
      }
      const today = todayUTC();
      const { data, error } = await db
        .from("clients")
        .select("client_type, contract_start, contract_end");
      if (error) throw new Error(error.message);
      const byType: Record<string, number> = {};
      let activeContracts = 0;
      for (const c of (data ?? []) as any[]) {
        const t = c.client_type ?? "unknown";
        byType[t] = (byType[t] ?? 0) + 1;
        const startOk = !c.contract_start || c.contract_start <= today;
        const endOk = !c.contract_end || c.contract_end >= today;
        if (startOk && endOk) activeContracts++;
      }
      return {
        total: data?.length ?? 0,
        by_type: byType,
        active_contracts: activeContracts,
      };
    }

    // ---------- Compliance ----------
    case "get_upcoming_compliance_alerts": {
      if (!hasPermission(caller, "compliance.view")) return denied("compliance.view");
      const days = Math.max(1, Math.min(365, Number(args.within_days) || 30));
      const today = todayUTC();
      const cutoff = addDays(days);
      const { data, error } = await db
        .from("important_dates")
        .select("title, due_date, category, priority, advance_notice_days")
        .gte("due_date", today)
        .lte("due_date", cutoff)
        .order("due_date", { ascending: true });
      if (error) throw new Error(error.message);
      return { window_days: days, count: data?.length ?? 0, alerts: data ?? [] };
    }

    // ---------- Inventory ----------
    case "get_inventory_summary": {
      if (!hasPermission(caller, "inventory.view")) return denied("inventory.view");
      const { data, error } = await db
        .from("inventory_items")
        .select("kind, status, quantity");
      if (error) throw new Error(error.message);
      const byKind: Record<string, { items: number; total_quantity: number; available: number; issued: number }> = {};
      for (const i of (data ?? []) as any[]) {
        const k = i.kind ?? "unknown";
        if (!byKind[k]) byKind[k] = { items: 0, total_quantity: 0, available: 0, issued: 0 };
        byKind[k].items++;
        const q = Number(i.quantity ?? 1);
        byKind[k].total_quantity += q;
        if (i.status === "issued") byKind[k].issued += q;
        else byKind[k].available += q;
      }
      return { by_kind: byKind };
    }
    case "get_low_stock_items": {
      if (!hasPermission(caller, "inventory.view")) return denied("inventory.view");
      const threshold = Math.max(0, Math.min(100, Number(args.threshold) ?? 5));
      const { data, error } = await db
        .from("inventory_items")
        .select("kind, item_type, serial_number, size, quantity, status")
        .lte("quantity", threshold)
        .neq("status", "issued")
        .order("quantity", { ascending: true });
      if (error) throw new Error(error.message);
      return { threshold, count: data?.length ?? 0, items: data ?? [] };
    }
    case "get_recent_issuances": {
      if (!hasPermission(caller, "inventory.view")) return denied("inventory.view");
      const days = Math.max(1, Math.min(90, Number(args.within_days) || 7));
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      const since = addDays(-days);
      const { data, error } = await db
        .from("issuances")
        .select(
          "issue_date, condition, inventory_items(kind, item_type, serial_number), employees(employee_code, full_name)",
        )
        .gte("issue_date", since)
        .order("issue_date", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return { window_days: days, count: data?.length ?? 0, issuances: data ?? [] };
    }

    // ---------- Tasks ----------
    case "get_my_tasks": {
      // Tasks always visible — they're scoped to the user via assignee_id and
      // the tasks RLS already enforces that regular users see only their own.
      let q = db
        .from("tasks")
        .select("title, status, due_date, description")
        .eq("assignee_id", caller.user_id)
        .order("position", { ascending: true });
      if (args.status) q = q.eq("status", String(args.status));
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return { count: data?.length ?? 0, tasks: data ?? [] };
    }
    case "get_overdue_tasks": {
      const today = todayUTC();
      let q = db
        .from("tasks")
        .select("title, status, due_date, assignee_id, profiles!tasks_assignee_id_fkey(full_name)")
        .neq("status", "done")
        .lt("due_date", today)
        .order("due_date", { ascending: true });
      // Non-admins only see their own overdue items, mirroring the Kanban UI.
      if (caller.role !== "super_admin" && caller.role !== "super_super_admin") {
        q = q.eq("assignee_id", caller.user_id);
      }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return { count: data?.length ?? 0, tasks: data ?? [] };
    }

    // ---- Sprint 1–5 additions ----
    case "get_contracts_summary": {
      if (!hasAny(caller, ["contracts.view", "contracts.edit"])) return denied("contracts.view");
      const { data, error } = await db.from("contracts").select("status");
      if (error) throw new Error(error.message);
      const counts: Record<string, number> = { active: 0, expired: 0, terminated: 0, draft: 0 };
      for (const r of (data ?? []) as { status: string }[]) {
        counts[r.status] = (counts[r.status] ?? 0) + 1;
      }
      return { total: (data ?? []).length, by_status: counts };
    }

    case "get_contracts_ending_soon": {
      if (!hasAny(caller, ["contracts.view", "contracts.edit"])) return denied("contracts.view");
      const daysAhead = Number(args.days_ahead ?? 60);
      const today = todayUTC();
      const end = addDays(daysAhead);
      const { data, error } = await db
        .from("contracts")
        .select("id, contract_code, client_id, end_date, contract_type, number_of_guards, rate_per_guard_per_month, clients(name, client_code)")
        .eq("status", "active")
        .not("end_date", "is", null)
        .gte("end_date", today)
        .lte("end_date", end)
        .order("end_date", { ascending: true });
      if (error) throw new Error(error.message);
      const rows = (data ?? []).map((r: any) => {
        const daysLeft = Math.round((new Date(r.end_date).getTime() - new Date(today).getTime()) / 86400000);
        return {
          contract_code: r.contract_code,
          client: r.clients?.name ?? null,
          client_code: r.clients?.client_code ?? null,
          contract_type: r.contract_type,
          number_of_guards: r.number_of_guards,
          rate_per_guard_per_month: Number(r.rate_per_guard_per_month),
          end_date: r.end_date,
          days_left: daysLeft,
        };
      });
      return { count: rows.length, days_ahead: daysAhead, contracts: rows };
    }

    case "lookup_contract": {
      if (!hasAny(caller, ["contracts.view", "contracts.edit"])) return denied("contracts.view");
      const query = String(args.query ?? "").trim();
      if (!query) return { count: 0, contracts: [], note: "empty_query" };
      // Try contract_code first; fall back to client name fragment.
      const codeMatch = await db
        .from("contracts")
        .select("id, contract_code, contract_type, start_date, end_date, status, number_of_guards, rate_per_guard_per_month, clients(name, client_code)")
        .ilike("contract_code", `%${query}%`)
        .limit(10);
      if (codeMatch.data && codeMatch.data.length > 0) {
        return {
          count: codeMatch.data.length,
          contracts: codeMatch.data.map((r: any) => ({
            contract_code: r.contract_code,
            client: r.clients?.name ?? null,
            contract_type: r.contract_type,
            start_date: r.start_date,
            end_date: r.end_date,
            status: r.status,
            number_of_guards: r.number_of_guards,
            rate_per_guard_per_month: Number(r.rate_per_guard_per_month),
          })),
        };
      }
      // Fall back to joining via client name
      const { data: clientRows } = await db
        .from("clients")
        .select("id")
        .ilike("name", `%${query}%`)
        .limit(5);
      const ids = ((clientRows ?? []) as { id: string }[]).map((c) => c.id);
      if (ids.length === 0) return { count: 0, contracts: [], note: "no_match" };
      const { data, error } = await db
        .from("contracts")
        .select("id, contract_code, contract_type, start_date, end_date, status, number_of_guards, rate_per_guard_per_month, clients(name, client_code)")
        .in("client_id", ids)
        .order("start_date", { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message);
      return {
        count: (data ?? []).length,
        contracts: (data ?? []).map((r: any) => ({
          contract_code: r.contract_code,
          client: r.clients?.name ?? null,
          contract_type: r.contract_type,
          start_date: r.start_date,
          end_date: r.end_date,
          status: r.status,
          number_of_guards: r.number_of_guards,
          rate_per_guard_per_month: Number(r.rate_per_guard_per_month),
        })),
      };
    }

    case "get_incidents_summary": {
      if (!hasAny(caller, ["incidents.view", "incidents.edit"])) return denied("incidents.view");
      const daysBack = Number(args.days_back ?? 30);
      const since = addDays(-daysBack);
      const { data, error } = await db
        .from("incidents")
        .select("severity, status")
        .gte("occurred_at", `${since}T00:00:00Z`);
      if (error) throw new Error(error.message);
      const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
      const byStatus: Record<string, number> = { open: 0, under_investigation: 0, resolved: 0, closed: 0 };
      for (const r of (data ?? []) as { severity: string; status: string }[]) {
        bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
        byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      }
      return { total: (data ?? []).length, period_days: daysBack, by_severity: bySeverity, by_status: byStatus };
    }

    case "get_recent_incidents": {
      if (!hasAny(caller, ["incidents.view", "incidents.edit"])) return denied("incidents.view");
      const limit = Number(args.limit ?? 10);
      const { data, error } = await db
        .from("incidents")
        .select("incident_code, severity, category, status, occurred_at, description, client_notified, clients(name)")
        .order("occurred_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return {
        count: (data ?? []).length,
        incidents: (data ?? []).map((r: any) => ({
          incident_code: r.incident_code,
          severity: r.severity,
          category: r.category,
          status: r.status,
          occurred_at: r.occurred_at,
          client: r.clients?.name ?? null,
          client_notified: r.client_notified,
          description: r.description,
        })),
      };
    }

    case "get_incidents_for_employee": {
      if (!hasAny(caller, ["incidents.view", "incidents.edit"])) return denied("incidents.view");
      const q = String(args.employee ?? "").trim();
      if (!q) return { count: 0, incidents: [], note: "empty_query" };
      const { data: empRows } = await db
        .from("employees")
        .select("id, full_name, employee_code")
        .or(`employee_code.ilike.%${q}%,full_name.ilike.%${q}%`)
        .limit(1);
      const emp = ((empRows ?? []) as { id: string; full_name: string; employee_code: string }[])[0];
      if (!emp) return { count: 0, incidents: [], note: "employee_not_found" };
      const { data: linkRows } = await db
        .from("incident_guards")
        .select("incident_id")
        .eq("employee_id", emp.id);
      const incIds = ((linkRows ?? []) as { incident_id: string }[]).map((r) => r.incident_id);
      if (incIds.length === 0) return { employee: emp, count: 0, incidents: [] };
      const { data, error } = await db
        .from("incidents")
        .select("incident_code, severity, category, status, occurred_at, description")
        .in("id", incIds)
        .order("occurred_at", { ascending: false });
      if (error) throw new Error(error.message);
      return { employee: emp, count: (data ?? []).length, incidents: data ?? [] };
    }

    case "get_roster_gaps": {
      if (!hasAny(caller, ["roster.view", "roster.edit"])) return denied("roster.view");
      const daysAhead = Number(args.days_ahead ?? 7);
      const today = todayUTC();
      const end = addDays(daysAhead);
      const [empsRes, slotsRes] = await Promise.all([
        db.from("employees").select("id", { count: "exact", head: true })
          .eq("status", "Active").in("category", ["client", "reliever"]),
        db.from("roster_assignments").select("employee_id, assignment_date, status")
          .gte("assignment_date", today).lte("assignment_date", end),
      ]);
      const empCount = empsRes.count ?? 0;
      const slots = (slotsRes.data ?? []) as { status: string }[];
      const totalSlots = empCount * daysAhead;
      const filled = slots.length;
      const relieverNeeded = slots.filter((s) => s.status === "reliever_needed").length;
      return {
        days_ahead: daysAhead,
        active_field_employees: empCount,
        total_required_slots: totalSlots,
        filled_slots: filled,
        unassigned_slots: Math.max(0, totalSlots - filled),
        reliever_needed: relieverNeeded,
      };
    }

    case "get_expiring_licences": {
      if (!hasAny(caller, ["compliance.view", "compliance.edit"])) return denied("compliance.view");
      const daysAhead = Number(args.days_ahead ?? 30);
      const today = todayUTC();
      const end = addDays(daysAhead);
      const [empRes, conRes, dateRes] = await Promise.all([
        db.from("employees")
          .select("id, full_name, employee_code, weapon_licence_expiry, guard_service_licence_expiry, medical_fitness_expiry, probation_end_date, status")
          .neq("status", "Inactive"),
        db.from("contracts")
          .select("contract_code, end_date, status, clients(name)")
          .eq("status", "active").not("end_date", "is", null)
          .gte("end_date", today).lte("end_date", end)
          .order("end_date", { ascending: true }),
        db.from("important_dates")
          .select("title, due_date, category, priority")
          .gte("due_date", today).lte("due_date", end)
          .order("due_date", { ascending: true }),
      ]);
      type Item = { kind: string; title: string; expiry: string; days_left: number };
      const items: Item[] = [];
      const dayDelta = (d: string) =>
        Math.round((new Date(d).getTime() - new Date(today).getTime()) / 86400000);
      for (const e of ((empRes.data ?? []) as any[])) {
        const checks: [string | null, string][] = [
          [e.weapon_licence_expiry, "Weapon licence"],
          [e.guard_service_licence_expiry, "Guard service licence"],
          [e.medical_fitness_expiry, "Medical fitness"],
          [e.probation_end_date, "Probation ends"],
        ];
        for (const [date, label] of checks) {
          if (date && date >= today && date <= end) {
            items.push({ kind: label, title: `${e.full_name} (${e.employee_code})`, expiry: date, days_left: dayDelta(date) });
          }
        }
      }
      for (const c of ((conRes.data ?? []) as any[])) {
        items.push({ kind: "Contract end", title: `${c.contract_code} — ${c.clients?.name ?? ""}`, expiry: c.end_date, days_left: dayDelta(c.end_date) });
      }
      for (const d of ((dateRes.data ?? []) as any[])) {
        items.push({ kind: `Company ${d.category}`, title: d.title, expiry: d.due_date, days_left: dayDelta(d.due_date) });
      }
      items.sort((a, b) => a.days_left - b.days_left);
      return {
        days_ahead: daysAhead,
        total: items.length,
        items: items.slice(0, 30),
        by_kind: items.reduce<Record<string, number>>((acc, i) => {
          acc[i.kind] = (acc[i.kind] ?? 0) + 1;
          return acc;
        }, {}),
      };
    }

    case "get_trial_balance": {
      if (!hasAny(caller, ["coa.view", "reports.view"])) return denied("coa.view");
      const today = todayUTC();
      const yearStart = `${today.slice(0, 4)}-01-01`;
      const from = String(args.from ?? yearStart);
      const to = String(args.to ?? today);
      const [coaRes, jlRes] = await Promise.all([
        db.from("chart_of_accounts").select("id, account_code, account_name, account_type, normal_side").eq("active", true),
        db.from("journal_lines")
          .select("account_id, debit, credit, journal_entry:journal_entry_id(entry_date)")
          .gte("journal_entry.entry_date", from)
          .lte("journal_entry.entry_date", to),
      ]);
      if (coaRes.error) throw new Error(coaRes.error.message);
      if (jlRes.error) throw new Error(jlRes.error.message);
      const balances = new Map<string, { debit: number; credit: number }>();
      for (const r of ((jlRes.data ?? []) as any[])) {
        if (!r.journal_entry) continue;
        const cur = balances.get(r.account_id) ?? { debit: 0, credit: 0 };
        cur.debit += Number(r.debit);
        cur.credit += Number(r.credit);
        balances.set(r.account_id, cur);
      }
      const rows = ((coaRes.data ?? []) as any[])
        .map((a) => {
          const b = balances.get(a.id) ?? { debit: 0, credit: 0 };
          return {
            account_code: a.account_code,
            account_name: a.account_name,
            account_type: a.account_type,
            debit: b.debit,
            credit: b.credit,
          };
        })
        .filter((r) => r.debit !== 0 || r.credit !== 0)
        .sort((a, b) => a.account_code.localeCompare(b.account_code));
      const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
      const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
      return {
        period: { from, to },
        accounts: rows,
        total_debit: totalDebit,
        total_credit: totalCredit,
        balanced: Math.abs(totalDebit - totalCredit) < 1,
      };
    }

    case "get_period_close_status": {
      if (!hasAny(caller, ["period_close.manage", "reports.view"])) return denied("period_close.manage");
      const today = todayUTC();
      const currentMonth = `${today.slice(0, 7)}-01`;
      const { data, error } = await db
        .from("accounting_periods")
        .select("period_month, closed_at, note")
        .order("period_month", { ascending: false })
        .limit(24);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { period_month: string; closed_at: string; note: string | null }[];
      const currentClosed = rows.some((r) => r.period_month.slice(0, 10) === currentMonth);
      return {
        current_month: currentMonth,
        current_month_closed: currentClosed,
        closed_periods: rows.map((r) => ({
          month: r.period_month.slice(0, 7),
          closed_at: r.closed_at,
          note: r.note,
        })),
      };
    }

    case "get_clients_with_expiring_contracts": {
      if (!hasAny(caller, ["clients.view", "clients.edit"])) return denied("clients.view");
      const daysAhead = Number(args.days_ahead ?? 60);
      const today = todayUTC();
      const end = addDays(daysAhead);
      const { data, error } = await db
        .from("clients")
        .select("name, client_code, contract_end, industry")
        .not("contract_end", "is", null)
        .gte("contract_end", today)
        .lte("contract_end", end)
        .order("contract_end", { ascending: true });
      if (error) throw new Error(error.message);
      const rows = (data ?? []).map((c: any) => ({
        name: c.name,
        client_code: c.client_code,
        industry: c.industry,
        contract_end: c.contract_end,
        days_left: Math.round((new Date(c.contract_end).getTime() - new Date(today).getTime()) / 86400000),
      }));
      return { days_ahead: daysAhead, count: rows.length, clients: rows };
    }

    case "get_employee_compliance": {
      if (!hasAny(caller, ["employees.view", "employees.edit", "compliance.view"]))
        return denied("employees.view");
      const q = String(args.employee ?? "").trim();
      if (!q) return { found: false, note: "empty_query" };
      const { data, error } = await db
        .from("employees")
        .select("employee_code, full_name, cnic_number, date_of_birth, weapon_licence_number, weapon_licence_expiry, guard_service_licence_number, guard_service_licence_expiry, medical_fitness_expiry, eobi_registration_number, employee_contract_type, probation_end_date, status")
        .or(`employee_code.ilike.%${q}%,full_name.ilike.%${q}%`)
        .limit(3);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) return { found: false, note: "not_found" };
      const today = todayUTC();
      const enrich = (row: any) => {
        const flags: string[] = [];
        const check = (label: string, date: string | null) => {
          if (!date) return;
          const days = Math.round((new Date(date).getTime() - new Date(today).getTime()) / 86400000);
          if (days < 0) flags.push(`${label} expired ${Math.abs(days)} days ago`);
          else if (days <= 30) flags.push(`${label} expires in ${days} days`);
        };
        check("Weapon licence", row.weapon_licence_expiry);
        check("Guard service licence", row.guard_service_licence_expiry);
        check("Medical fitness", row.medical_fitness_expiry);
        if (row.employee_contract_type === "probation") check("Probation", row.probation_end_date);
        return { ...row, alerts: flags };
      };
      return { found: true, count: data.length, employees: data.map(enrich) };
    }

    default:
      return { error: `unknown_tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// System prompt — strict scoping to the CRM
// ---------------------------------------------------------------------------

function buildSystemPrompt(caller: CallerProfile): string {
  const today = todayUTC();
  const currentMonth = today.slice(0, 7);
  return `You are the Employee Manager CRM assistant for a Pakistani security-services company. You answer questions ONLY about the user's CRM data:
- Workforce: employees (with HR fields: CNIC, DOB, addresses, emergency contact, weapon/guard-service/medical licences, EOBI registration, supervisor, contract type, probation), attendance (with half-day/late/overtime), payroll, relievers.
- Operations: deployment roster (guards × dates × shifts), posts (deployment sites), incidents (theft / altercations / no-shows / weapon discharges with severity + status).
- Clients & Contracts: clients (with NTN/STRN/filer status/withholding tax rate/billing address/signatory), contracts (one client can have many — each with rate per guard, shift pattern, end date, auto-invoice).
- Finance: invoices, payments, expenses (tagged Cost of Services vs Operating Expense), cashflow, cheques, banks (with IBAN/SWIFT/currency).
- Accounting-grade: Chart of Accounts, Trial Balance (from double-entry journal — always balanced), General Ledger, period close, audit log.
- Compliance: Licences & Renewals centre aggregating weapon/guard/medical licence expiries, contract endings, and company compliance dates.
- Other: inventory, documents, tasks.

# Hard rules
- Use the provided tools to fetch live data. NEVER make up numbers.
- Format money as "PKR " + comma-separated integer (e.g. PKR 1,250,000). Round to whole rupees.
- When showing lists, use compact markdown tables.
- Be concise. No filler phrases ("Sure!", "Here you go!", "Great question!").
- Do not apologize unnecessarily — explain the situation and offer the next useful step.

# How to handle "can't help" situations
There are four distinct cases. Use the matching template — do not improvise refusals.

## 1. Off-topic question (weather, jokes, general knowledge, coding help, opinions)
Respond exactly:
"That's outside what I can help with — I'm focused on your CRM data (employees, payroll, attendance, invoices, expenses, cashflow, clients, contracts, deployment roster, incidents, licences, accounting, inventory, tasks). Ask me about any of those and I'll dig in."

## 2. On-topic but no tool exists for it
Tell the user honestly what you CAN look up nearby and suggest the closest alternative. Format:
"I don't have a direct lookup for that. I can show you: [2-3 closest available queries phrased naturally]. Want one of those?"

## 3. Tool returned permission_denied
"You don't have access to [area]. Ask your admin to enable the '[permission]' permission on your account if you need it."
Do not try a different tool.

## 4. Tool ran fine but returned empty / zero data
Be specific about WHAT was empty and offer a concrete next step. Patterns:
- If the response contains "most_recent_month_with_data": offer that month as a fallback. Example: "No payslips have net amounts for May 2026 yet — payroll is usually generated at the end of the month. The most recent populated month is April 2026 — want me to show that?"
- If the response is empty for a query that depends on user input (employee/client search): ask for clarification. Example: "No matches for 'Ahmad'. Try a fuller name, the employee code, or the phone number."
- If the response is genuinely zero (e.g. zero unpaid invoices): state it plainly. Example: "All invoices are paid — no outstanding receivables."
- Never say "no data found" without context. Always say WHAT period / filter / threshold was used so the user can adjust it.

# Context
- Today is ${today}. Current month is ${currentMonth}.
- Signed-in user's role: "${caller.role}". Their company is automatically scoped to their account — they cannot see other companies' data.
- A new period (current month) often has no data yet because operations like payroll, payslip generation, and reconciliation happen at month-end. When asked about "this month" and the answer is zero, gently suggest the prior month.

# Tool selection cheatsheet (Sprint 1–5 modules)
- "active contracts / contracts ending / renewal" → get_contracts_summary, get_contracts_ending_soon
- "find contract CON-0001 / contracts for Tapal" → lookup_contract
- "incidents / how many open incidents / safety review" → get_incidents_summary, get_recent_incidents
- "incidents for Guard X / disciplinary history" → get_incidents_for_employee
- "deployment roster / unfilled slots / understaffing" → get_roster_gaps
- "what's expiring / licences / renewals / compliance" → get_expiring_licences
- "weapon licence / EOBI reg / probation for employee X" → get_employee_compliance
- "trial balance / debits credits / accounting balances" → get_trial_balance
- "is May closed / which months are locked" → get_period_close_status
- "clients with contract ending" → get_clients_with_expiring_contracts

# Calling conventions
- Tools that take \`days_ahead\` or \`days_back\` default to sensible windows; pick a window that matches the user's phrasing ("this week" → 7, "this month" → 30, "this quarter" → 90).
- For period parameters in get_trial_balance, default to year-to-date unless the user specifies a range.

# Scoping language for empty results
Every tool runs within the user's current company scope (super-admins see their own company; super-super-admins see whichever company they're currently "viewing as"). Never imply absolute / global statements when data is empty.

- ❌ Don't say: "There are no advances in the system."
- ❌ Don't say: "No payslips have ever been generated."
- ✅ Do say: "No advances are recorded for this company in May 2026."
- ✅ Do say: "This company has no payslips yet for May 2026."

When \`most_recent_month_with_data\` is null in a tool's response, it means there's no historical data **for this company** — not globally. Phrase it that way.`;
}

// ---------------------------------------------------------------------------
// OpenAI loop
// ---------------------------------------------------------------------------

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

async function callOpenAI(messages: ChatMessage[]): Promise<ChatMessage> {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI request failed (${resp.status}): ${text}`);
  }
  const body = await resp.json();
  return body.choices?.[0]?.message as ChatMessage;
}

// ---------------------------------------------------------------------------
// Persistence — writes the user/assistant turn to ai_chat_threads + messages.
// Failures are swallowed and logged: a saved-history bug should never break
// the chat itself.
// ---------------------------------------------------------------------------

async function persistTurn(
  db: SupabaseClient,
  caller: CallerProfile,
  existingThreadId: string | null,
  userContent: string | null,
  assistantContent: string,
): Promise<string | null> {
  try {
    let threadId = existingThreadId;
    if (!threadId) {
      // First turn of a new conversation. Seed the title from the user's
      // first message so the row is easy to find later.
      const title = userContent ? userContent.slice(0, 80) : "New conversation";
      const { data: thread, error: threadErr } = await db
        .from("ai_chat_threads")
        .insert({ user_id: caller.user_id, company_id: caller.company_id, title })
        .select("id")
        .single();
      if (threadErr) throw threadErr;
      threadId = (thread as { id: string }).id;
    } else {
      // Touch updated_at so threads list naturally sorts most-recent-first.
      await db
        .from("ai_chat_threads")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", threadId);
    }
    const rows: Array<{ thread_id: string; role: string; content: string }> = [];
    if (userContent) rows.push({ thread_id: threadId, role: "user", content: userContent });
    rows.push({ thread_id: threadId, role: "assistant", content: assistantContent });
    const { error: msgErr } = await db.from("ai_chat_messages").insert(rows);
    if (msgErr) throw msgErr;
    return threadId;
  } catch (e) {
    console.error("persistTurn failed (non-fatal):", e instanceof Error ? e.message : e);
    return existingThreadId;
  }
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!OPENAI_API_KEY) {
    return json(
      { error: "OPENAI_API_KEY secret is not set on the Edge Function." },
      500,
    );
  }

  const authHeader = req.headers.get("Authorization");
  const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return json({ error: "unauthorized" }, 401);

  const caller = await resolveCaller(jwt);
  if (!caller) return json({ error: "invalid_token" }, 401);

  let body: {
    messages?: Array<{ role: string; content: string }>;
    thread_id?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const inboundMessages = body.messages ?? [];
  if (!Array.isArray(inboundMessages) || inboundMessages.length === 0) {
    return json({ error: "messages_required" }, 400);
  }
  // Client-managed thread ID. Stays null on the very first message of a new
  // conversation — we create the thread row below and echo it back.
  let threadId = body.thread_id ?? null;

  // User-scoped Supabase client. Every tool query will inherit this JWT, so
  // RLS handles cross-company isolation and per-row visibility for us.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(caller) },
    ...inboundMessages.map((m) => ({
      role: m.role as ChatMessage["role"],
      content: m.content,
    })),
  ];

  // The most recent user message is the one we'll persist if the request
  // succeeds (avoids saving anything if OpenAI errors before we get a reply).
  const lastUserContent =
    [...inboundMessages].reverse().find((m) => m.role === "user")?.content ?? null;

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const assistant = await callOpenAI(messages);
      messages.push(assistant);

      const toolCalls = assistant.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // Plain text response — done. Persist the turn before returning so
        // the client never sees a reply that isn't in the DB.
        const replyText = assistant.content ?? "";
        threadId = await persistTurn(
          userClient,
          caller,
          threadId,
          lastUserContent,
          replyText,
        );
        return json({ reply: replyText, thread_id: threadId });
      }

      // Run every tool the model requested this turn. Results are appended in
      // matching order; OpenAI requires the tool message to reference the
      // tool_call_id from the assistant message.
      for (const call of toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(call.function.arguments || "{}");
        } catch {
          parsedArgs = {};
        }
        let result: unknown;
        try {
          result = await runTool(call.function.name, parsedArgs, userClient, caller);
        } catch (e) {
          result = { error: e instanceof Error ? e.message : String(e) };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(result),
        });
      }
    }
    // Hit the iteration cap without a final answer. Persist a placeholder so
    // the transcript still reflects what the user asked.
    const fallback =
      "I needed too many steps to answer that — could you ask it in a smaller piece?";
    threadId = await persistTurn(userClient, caller, threadId, lastUserContent, fallback);
    return json({ reply: fallback, thread_id: threadId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("ai-chat:", msg);
    return json({ error: msg }, 500);
  }
});
