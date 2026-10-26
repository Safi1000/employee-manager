import { createContext, useContext, type ReactNode } from "react";
import { Info } from "lucide-react";
import { supabase } from "../../../lib/supabase";
import { useAuth } from "../../../lib/auth";

/**
 * Shared pieces of the Financial Reports surface (Overview, Client profit,
 * Statements, Ledgers, Scenarios). Built on the app's own kit — Panel, Tabs,
 * StatCard, Badge, ResponsiveTable and the theme tokens — not a third style.
 *
 * The rule every screen here follows: THE LEDGER ANSWERS, THE SCREEN READS.
 * Figures come from database functions (client_statement_loaded,
 * trial_balance_for, ho_region_modes, ledger_statement, cash_accrual_bridge,
 * scenario_compare, …). The only arithmetic in the browser is a footer or a
 * group subtotal that is literally the sum of the rows displayed above it.
 */

// ── Formatting ────────────────────────────────────────────────────────────
export const money = (v: number | string | null | undefined) =>
  v == null || v === "" ? "—"
    : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const signed = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v) > 0 ? "+" : ""}${money(v)}`;

/** A right-aligned amount; negatives in danger, zero muted. */
export function Amount({ v, strong, onClick, title }: { v: number | string | null | undefined; strong?: boolean; onClick?: () => void; title?: string }) {
  const n = v == null || v === "" ? null : Number(v);
  const cls = n == null ? "text-muted-foreground" : n < 0 ? "text-danger-700 dark:text-danger-500" : n === 0 ? "text-muted-foreground" : "text-foreground";
  const body = <span className={`tabular-nums whitespace-nowrap ${strong ? "font-semibold" : ""} ${cls}`}>{money(n)}</span>;
  if (!onClick) return body;
  return (
    <button type="button" onClick={onClick} title={title ?? "Open what makes up this figure"}
      className="underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 hover:decoration-brand-500">
      {body}
    </button>
  );
}

// ── Months ────────────────────────────────────────────────────────────────
export const monthStart = (p: string) => `${p.slice(0, 7)}-01`;
export const monthEnd = (p: string) => {
  const [y, m] = p.slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
};
export const monthLabel = (p: string) =>
  new Date(`${p.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
export const previousMonthKey = () => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
export const recentMonths = (n = 15) => {
  const out: string[] = []; const d = new Date(); d.setDate(1);
  for (let i = 0; i < n; i++) { out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); d.setMonth(d.getMonth() - 1); }
  return out;
};

// ── Scope ─────────────────────────────────────────────────────────────────
export function useCompanyId(): string | null {
  const { profile, company } = useAuth();
  return profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
}

// ── RPC calls that know when a function is not there yet ──────────────────
export type RpcResult<T> = { data: T | null; error: string | null; missing: boolean };

/** A function proposed in 0516 and not yet applied answers PGRST202; say so
 *  instead of showing a raw error or an empty table that looks like "none". */
export async function callRpc<T>(name: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
  const { data, error } = await supabase.rpc(name, args);
  if (!error) return { data: data as T, error: null, missing: false };
  const missing = error.code === "PGRST202" || /could not find the function/i.test(error.message);
  return { data: null, error: error.message, missing };
}

export function ProposedNotice({ fn, what }: { fn: string; what: string }) {
  return (
    <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2.5">
      <Info className="w-4 h-4 shrink-0 mt-px" />
      <span>
        {what} reads <code className="text-[11px]">{fn}()</code>, proposed in migration 0516 and not yet applied.
        It lights up as soon as 0516 is authorised.
      </span>
    </div>
  );
}

// ── Drill-down ────────────────────────────────────────────────────────────
/** Everything a figure can open into. */
export type DrillTarget =
  | {
      type: "gl";
      title: string;
      /** Why these lines are the figure, or what they approximate. */
      note?: string;
      start: string;
      end: string;
      accountCodes?: string[];
      accountTypes?: ("revenue" | "expense")[];
      clientId?: string;
      branchId?: string;
      sourceTables?: string[];
      /** Expense lines whose source expense carries this client (GL expense lines carry no client). */
      expenseClientId?: string;
    }
  | { type: "entry"; id: string }
  | { type: "source"; table: string; id: string }
  | { type: "ledger"; kind: "client" | "guard" | "supplier" | "account"; subjectId: string; title: string; start: string; end: string }
  | { type: "composition"; title: string; explanation: string; rows: { label: string; value: number | null; drill?: DrillTarget }[] };

const DrillCtx = createContext<(t: DrillTarget) => void>(() => {});
export const DrillProvider = ({ open, children }: { open: (t: DrillTarget) => void; children: ReactNode }) =>
  <DrillCtx.Provider value={open}>{children}</DrillCtx.Provider>;
export const useDrill = () => useContext(DrillCtx);

/** Where a source document lives in the app. */
export const SOURCE_ROUTES: Record<string, { label: string; href: string }> = {
  invoices: { label: "Invoices", href: "/super-admin/invoices" },
  invoice_payments: { label: "Receivables", href: "/super-admin/invoices?tab=receivables" },
  expenses: { label: "Expenses", href: "/super-admin/expenses" },
  expenses_prepaid_release: { label: "Expenses", href: "/super-admin/expenses" },
  payable_payments: { label: "Payables", href: "/super-admin/expenses?tab=payables" },
  payslips: { label: "Payroll", href: "/super-admin/payroll" },
  payslips_disbursement: { label: "Payroll", href: "/super-admin/payroll" },
  payroll_adjustments: { label: "Payroll", href: "/super-admin/payroll" },
  advances: { label: "Expenses — advances", href: "/super-admin/expenses" },
  partner_account_entries: { label: "Partnership Report", href: "/super-admin/partnership?tab=statements" },
  custody_transfers: { label: "Cash custody", href: "/super-admin/accounting?tab=cash-custody" },
};

/** The table a journal entry's source_id points into. */
export const SOURCE_TABLE: Record<string, string> = {
  payslips_disbursement: "payslips",
  expenses_prepaid_release: "expenses",
  expense_settlements: "expenses",
  payroll_adjustment_settlement: "payroll_adjustments",
};
