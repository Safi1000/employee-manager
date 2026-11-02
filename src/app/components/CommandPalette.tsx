import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { AlertTriangle, Building2, CalendarCheck, CornerDownLeft, FileText, HandCoins, KeyRound, LayoutList, ListTodo, Loader2, LogOut, Moon, PhoneCall, Pin, Plus, Receipt, Search, Smartphone, Star, Clock, Truck, UserCircle, UserPlus, type LucideIcon } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useMode } from "../lib/mode";
import { togglePin, usePinned, useRecent } from "../lib/navPrefs";

/**
 * COMMAND PALETTE (2026-10-20) — ⌘K / Ctrl+K from anywhere, or the search
 * button on the rail. One box that reaches every page the user is allowed, and
 * any client, guard or invoice by name or code. Empty, it shows pinned and
 * recent pages, so the two places you go most are one keystroke away.
 *
 * Opened by the shortcut or by a "palette:open" window event (the rail and the
 * mobile menu send it), the same decoupling the mobile drawer uses.
 */

export type PaletteLink = { to: string; label: string; icon: LucideIcon; section: string };

type Item = {
  key: string;
  group: string;
  title: string;
  meta?: string;
  icon: LucideIcon;
  run: () => void;
  pinPath?: string;
};

const pageStateKey = (path: string, name: string) => `pageState:${path}:${name}`;

/**
 * A destination inside a page (2 Nov 2026): the sidebar lists pages, not their
 * tabs, so the Receivables, WHT certificates, Attendance Report … screens were
 * unreachable from search. `page` gates it (offered only when the user can open
 * that page); `state` presets the page's remembered tab before arriving —
 * most pages keep their tab in page state, not the URL; `to` carries a ?tab=
 * for the pages that do read the URL.
 */
type Dest = { title: string; meta: string; icon: LucideIcon; page: string; to?: string; state?: [string, unknown][] };
const RECEIVABLES: [string, unknown][] = [["Invoices.tab", "receivables"]];
const SCREENS: Dest[] = [
  { title: "Client receivables", meta: "Finance · Invoices", icon: HandCoins, page: "/app/invoices", state: [...RECEIVABLES, ["ClientReceivables.view", "balances"]] },
  { title: "Write-offs", meta: "Finance · Invoices · Receivables", icon: HandCoins, page: "/app/invoices", state: [...RECEIVABLES, ["ClientReceivables.view", "writeoffs"]] },
  { title: "WHT certificates", meta: "Finance · Invoices", icon: FileText, page: "/app/invoices", state: [["Invoices.tab", "wht"]] },
  { title: "Invoice ledger", meta: "Finance · Invoices", icon: FileText, page: "/app/invoices", state: [["Invoices.tab", "ledger"]] },
  { title: "Generate invoices", meta: "Finance · Invoices", icon: FileText, page: "/app/invoices", state: [["Invoices.tab", "generate"]] },
  { title: "Attendance Report", meta: "Operations · Daily Reports", icon: CalendarCheck, page: "/app/daily-reports", state: [["FieldOps.tab", "attendance"]] },
  { title: "Fixed expenses", meta: "Finance · Expenses", icon: Receipt, page: "/app/expenses", to: "/app/expenses?tab=fixed" },
  { title: "Advances", meta: "Finance · Expenses", icon: HandCoins, page: "/app/expenses", to: "/app/expenses?tab=advances" },
  { title: "Payables", meta: "Finance · Expenses", icon: Receipt, page: "/app/expenses", to: "/app/expenses?tab=payables" },
  { title: "Statutory payments", meta: "Finance · Expenses", icon: Receipt, page: "/app/expenses", to: "/app/expenses?tab=statutory" },
  { title: "Fuel bills", meta: "Finance · Expenses", icon: Receipt, page: "/app/expenses", to: "/app/expenses?tab=fuel" },
  { title: "Deferred (prepaid) expenses", meta: "Finance · Expenses", icon: Receipt, page: "/app/expenses", to: "/app/expenses?tab=deferred" },
  { title: "Cash custody", meta: "Finance · Bank & Ledgers", icon: HandCoins, page: "/app/accounting", to: "/app/accounting?tab=cash-custody" },
  { title: "Chart of Accounts", meta: "Finance · Accounting Core", icon: LayoutList, page: "/app/accounting-core", to: "/app/accounting-core?tab=coa" },
  { title: "Trial Balance", meta: "Finance · Accounting Core", icon: LayoutList, page: "/app/accounting-core", to: "/app/accounting-core?tab=tb" },
  { title: "Journal", meta: "Finance · Accounting Core", icon: LayoutList, page: "/app/accounting-core", to: "/app/accounting-core?tab=journal" },
  { title: "Opening Balances", meta: "Finance · Accounting Core", icon: LayoutList, page: "/app/accounting-core", to: "/app/accounting-core?tab=opening" },
  { title: "Profit & loss", meta: "Finance · Financial Reports", icon: FileText, page: "/app/reports", state: [["Reports.view", "pl"]] },
  { title: "Client profit", meta: "Finance · Financial Reports", icon: FileText, page: "/app/reports", state: [["Reports.view", "clients"]] },
  { title: "Head office costs", meta: "Finance · Financial Reports", icon: FileText, page: "/app/reports", state: [["Reports.view", "ho"]] },
  { title: "Ledger checks", meta: "Finance · Accountant", icon: LayoutList, page: "/app/accountant", state: [["Accountant.section", "checks"]] },
  { title: "Cash plan and budget", meta: "Finance · Accountant", icon: LayoutList, page: "/app/accountant", state: [["Accountant.section", "planning"]] },
  { title: "Account ledgers", meta: "Finance · Accountant", icon: LayoutList, page: "/app/accountant", state: [["Accountant.section", "ledgers"]] },
  { title: "Contracted vs deployed", meta: "Finance · Accountant", icon: LayoutList, page: "/app/accountant", state: [["Accountant.section", "cover"]] },
  { title: "Licences & renewals", meta: "Admin · Compliance Calendar", icon: CalendarCheck, page: "/app/compliance", to: "/app/compliance?tab=licences" },
  { title: "Contract renewals", meta: "Admin · Compliance Calendar", icon: CalendarCheck, page: "/app/compliance", to: "/app/compliance?tab=renewals" },
  { title: "Client complaints", meta: "Operations · Incidents", icon: AlertTriangle, page: "/app/incidents", to: "/app/incidents?tab=complaints" },
  { title: "Store", meta: "Operations · Assets & Issuance", icon: LayoutList, page: "/app/assets-issuance", to: "/app/assets-issuance?tab=store" },
  { title: "Kit issuance", meta: "Operations · Assets & Issuance", icon: LayoutList, page: "/app/assets-issuance", to: "/app/assets-issuance?tab=issuance" },
  { title: "Clearance", meta: "Operations · Assets & Issuance", icon: LayoutList, page: "/app/assets-issuance", to: "/app/assets-issuance?tab=clearance" },
  { title: "Asset register", meta: "Operations · Assets & Issuance", icon: LayoutList, page: "/app/assets-issuance", to: "/app/assets-issuance?tab=register" },
  { title: "CEO · Daily Operations", meta: "Overview · CEO Dashboard", icon: FileText, page: "/app/ceo", state: [["CeoDashboard.tab4", "daily"]] },
  { title: "CEO · Attendance", meta: "Overview · CEO Dashboard", icon: CalendarCheck, page: "/app/ceo", state: [["CeoDashboard.tab4", "attendance"]] },
  { title: "CEO · Finance", meta: "Overview · CEO Dashboard", icon: FileText, page: "/app/ceo", state: [["CeoDashboard.tab4", "finance"]] },
  { title: "CEO · People (who did what)", meta: "Overview · CEO Dashboard", icon: UserCircle, page: "/app/ceo", state: [["CeoDashboard.tab4", "people"]] },
];

export default function CommandPalette({ links, onChangePassword }: { links: PaletteLink[]; onChangePassword: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, company, signOut } = useAuth();
  const { toggle: toggleMode } = useMode();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
  const pinned = usePinned();
  const recent = useRecent();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => { if (o) { setQ(""); setHits([]); } return !o; }); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("palette:open", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("palette:open", onOpen); };
  }, []);

  // Cleared on the way out, not on the way in: a reset on open would race
  // the first keystrokes typed straight after ⌘K and swallow them.
  const close = () => { setOpen(false); setQ(""); setActive(0); setHits([]); };
  const go = (to: string) => { close(); navigate(to); };
  const byPath = useMemo(() => new Map(links.map((l) => [l.to, l])), [links]);
  /** Preset the page's remembered tab, then arrive. Already on that page, a
   *  reload is what makes it read the new tab (page state is read on mount). */
  const goDest = (d: { page: string; to?: string; state?: [string, unknown][] }) => {
    try { for (const [k, v] of d.state ?? []) sessionStorage.setItem(pageStateKey(d.page, k), JSON.stringify(v)); } catch { /* lands on its last tab */ }
    const to = d.to ?? d.page;
    if (d.state?.length && location.pathname === d.page) { close(); window.location.assign(to); return; }
    go(to);
  };

  // NEEDS YOU (2 Nov 2026): what is waiting, offered as the first thing to do
  // when the box is empty. Head-only counts, read on open; one the login cannot
  // read simply returns nothing and is not offered.
  const [needs, setNeeds] = useState<Item[]>([]);
  useEffect(() => {
    if (!open || !companyId) return;
    let cancelled = false;
    void (async () => {
      const now = new Date();
      const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastKey = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-01`;
      const thisKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const head = { count: "exact" as const, head: true };
      const [ps, fx, fr, wo, steps, inv] = await Promise.all([
        byPath.has("/app/payroll") ? supabase.from("payslips").select("id", head).eq("company_id", companyId).eq("period_month", lastKey).eq("disbursed", false).gt("net_salary", 0) : null,
        byPath.has("/app/expenses") ? supabase.from("fixed_expense_instances").select("id", head).eq("company_id", companyId).eq("period_month", thisKey).eq("status", "pending") : null,
        byPath.has("/app/field-review") ? supabase.from("field_money_requests").select("id", head).eq("company_id", companyId).eq("status", "pending") : null,
        byPath.has("/app/invoices") ? supabase.from("client_write_offs").select("id", head).eq("company_id", companyId).eq("status", "pending") : null,
        byPath.has("/app/payment-follow-up") ? supabase.from("client_followups").select("id", head).eq("company_id", companyId).not("next_step", "is", null).is("next_step_done_at", null).lte("next_follow_up", today) : null,
        byPath.has("/app/invoices") ? supabase.rpc("client_followup_invoices") : null,
      ]);
      if (cancelled) return;
      const monthName = last.toLocaleDateString("en-GB", { month: "long" });
      const out: Item[] = [];
      const add = (n: number | null | undefined, key: string, title: string, meta: string, icon: LucideIcon, d: Dest | { page: string; to?: string; state?: [string, unknown][] }) => {
        if (n && n > 0) out.push({ key: `need:${key}`, group: "Needs you", title, meta, icon, run: () => goDest(d) });
      };
      const invRows = ((inv && !inv.error ? inv.data : []) ?? []) as { missing: boolean; delivered_on: string | null }[];
      const undelivered = invRows.filter((r) => !r.missing && !r.delivered_on).length;
      const missing = invRows.filter((r) => r.missing).length;
      add(undelivered, "undelivered", `${undelivered} ${monthName} invoice${undelivered === 1 ? "" : "s"} not marked delivered`, "Finance · Invoices", Truck, { page: "/app/invoices", state: [["Invoices.tab", "ledger"]] });
      add(missing, "missing", `${missing} client${missing === 1 ? "" : "s"} with no ${monthName} invoice`, "Finance · Invoices · Generate", FileText, { page: "/app/invoices", state: [["Invoices.tab", "generate"]] });
      add(steps && !steps.error ? steps.count : 0, "steps", `${steps?.count} follow-up step${steps?.count === 1 ? "" : "s"} due`, "Finance · Payment Follow-up", PhoneCall, { page: "/app/payment-follow-up", state: [["PaymentFollowUp.show", "mine"]] });
      add(fr && !fr.error ? fr.count : 0, "field", `${fr?.count} field-app money request${fr?.count === 1 ? "" : "s"} waiting`, "Field App · Field Review", Smartphone, { page: "/app/field-review" });
      add(wo && !wo.error ? wo.count : 0, "wo", `${wo?.count} write-off${wo?.count === 1 ? "" : "s"} waiting for approval`, "Finance · Receivables", HandCoins, { page: "/app/invoices", state: [...RECEIVABLES, ["ClientReceivables.view", "writeoffs"]] });
      add(ps && !ps.error ? ps.count : 0, "pay", `${ps?.count} ${monthName} payslip${ps?.count === 1 ? "" : "s"} not yet paid`, "Finance · Payroll", HandCoins, { page: "/app/payroll" });
      add(fx && !fx.error ? fx.count : 0, "fixed", `${fx?.count} fixed expense${fx?.count === 1 ? "" : "s"} waiting for a decision`, "Finance · Expenses", Receipt, { page: "/app/expenses", to: "/app/expenses?tab=fixed" });
      setNeeds(out);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, companyId, byPath]);

  // Records: a short debounce, three plain reads, nothing computed.
  useEffect(() => {
    const term = q.trim();
    if (!open || !companyId || term.length < 2) { setHits([]); setBusy(false); return; }
    let cancelled = false;
    setBusy(true);
    const h = setTimeout(() => {
      void (async () => {
        const like = `%${term.replace(/[%,()*]/g, " ")}%`;
        const [cl, em, inv] = await Promise.all([
          supabase.from("clients").select("id, name, client_code").eq("company_id", companyId).or(`name.ilike.${like},client_code.ilike.${like}`).limit(5),
          supabase.from("employees").select("id, full_name, guard_code, employee_code, lifecycle_state").eq("company_id", companyId).or(`full_name.ilike.${like},guard_code.ilike.${like},employee_code.ilike.${like}`).limit(6),
          supabase.from("invoices").select("id, invoice_number, client:client_id(name)").eq("company_id", companyId).ilike("invoice_number", like).limit(5),
        ]);
        if (cancelled) return;
        const out: Item[] = [];
        // Clients and guards open their list already searched for them — the
        // page's own search box, through the page state it remembers.
        const searchThen = (path: string, name: string, value: string) => () => {
          try { sessionStorage.setItem(pageStateKey(path, name), JSON.stringify(value)); } catch { /* fine: lands unfiltered */ }
          go(path);
        };
        for (const r of (cl.data ?? []) as { id: string; name: string; client_code: string | null }[])
          out.push({ key: `c${r.id}`, group: "Clients", title: r.name, meta: r.client_code ?? undefined, icon: Building2, run: searchThen("/app/clients", "Clients.search", r.name) });
        for (const r of (em.data ?? []) as { id: string; full_name: string; guard_code: string | null; employee_code: string | null; lifecycle_state: string | null }[])
          out.push({ key: `e${r.id}`, group: "Guards & staff", title: r.full_name, meta: [r.guard_code ?? r.employee_code, r.lifecycle_state && r.lifecycle_state !== "active" ? r.lifecycle_state.replace(/_/g, " ") : null].filter(Boolean).join(" · "), icon: UserCircle, run: searchThen("/app/employees", "EmployeeManagement.search", r.full_name) });
        for (const r of (inv.data ?? []) as unknown as { id: string; invoice_number: string; client: { name: string } | null }[])
          out.push({ key: `i${r.id}`, group: "Invoices", title: r.invoice_number, meta: r.client?.name, icon: FileText, run: () => go(`/app/invoices?focus=${r.id}&focusType=invoices`) });
        setHits(out);
        setBusy(false);
      })();
    }, 200);
    return () => { cancelled = true; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, companyId]);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const pageItem = (l: PaletteLink, group: string): Item => ({ key: `${group}:${l.to}`, group, title: l.label, meta: l.section, icon: l.icon, run: () => go(l.to), pinPath: l.to });
    // Things to DO (2026-10-21): each opens the form on its page, and is only
    // offered when the page itself is one this user can open.
    const doIt: Item[] = ([
      { key: "do:expense", title: "New expense", meta: "Expenses & Advances", icon: Receipt, page: "/app/expenses", to: "/app/expenses?new=expense" },
      { key: "do:advance", title: "New advance to a guard", meta: "Expenses & Advances", icon: HandCoins, page: "/app/expenses", to: "/app/expenses?new=advance" },
      { key: "do:invoice", title: "New invoice", meta: "Invoices", icon: Plus, page: "/app/invoices", to: "/app/invoices?new=invoice" },
      { key: "do:receipt", title: "Record a receipt from a client", meta: "Invoices · Receivables", icon: HandCoins, page: "/app/invoices", state: [...RECEIVABLES, ["ClientReceivables.view", "balances"]] },
      { key: "do:generate", title: "Generate this month's invoices", meta: "Invoices · Generate", icon: FileText, page: "/app/invoices", state: [["Invoices.tab", "generate"]] },
      { key: "do:deliver", title: "Mark invoices delivered", meta: "Invoices", icon: Truck, page: "/app/invoices", state: [["Invoices.tab", "ledger"]] },
      { key: "do:followup", title: "Log a payment follow-up call", meta: "Payment Follow-up", icon: PhoneCall, page: "/app/payment-follow-up" },
      { key: "do:wht", title: "Record a WHT certificate", meta: "Invoices · WHT certificates", icon: FileText, page: "/app/invoices", state: [["Invoices.tab", "wht"]] },
      { key: "do:daily", title: "Write today's daily report", meta: "Daily Reports", icon: FileText, page: "/app/daily-reports", state: [["FieldOps.tab", "reports"]] },
      { key: "do:attreport", title: "Export the attendance report", meta: "Daily Reports · Attendance Report", icon: CalendarCheck, page: "/app/daily-reports", state: [["FieldOps.tab", "attendance"]] },
      { key: "do:finreport", title: "Export the finance report", meta: "Finance Report", icon: FileText, page: "/app/finance-report" },
      { key: "do:fieldreview", title: "Review field app requests", meta: "Field App · Field Review", icon: Smartphone, page: "/app/field-review" },
      { key: "do:attrun", title: "Verify attendance (Attendance Run)", meta: "Attendance Run", icon: CalendarCheck, page: "/app/attendance-run" },
      { key: "do:payroll", title: "Disburse salaries", meta: "Payroll", icon: HandCoins, page: "/app/payroll" },
      { key: "do:incident", title: "Report an incident", meta: "Incidents", icon: AlertTriangle, page: "/app/incidents" },
      { key: "do:task", title: "New task", meta: "Task Board", icon: ListTodo, page: "/app/tasks", to: "/app/tasks?new=task" },
      { key: "do:attendance", title: "Mark attendance", meta: "Attendance", icon: CalendarCheck, page: "/app/attendance", to: "/app/attendance" },
      { key: "do:employee", title: "Add an employee", meta: "Employees", icon: UserPlus, page: "/app/employees", to: "/app/employees" },
    ] as (Omit<Item, "group" | "run"> & { page: string; to?: string; state?: [string, unknown][] })[])
      .filter((a) => byPath.has(a.page))
      .map((a) => ({ key: a.key, group: "Do", title: a.title, meta: a.meta, icon: a.icon, run: () => goDest(a) }));
    const screens: Item[] = SCREENS.filter((d) => byPath.has(d.page))
      .map((d) => ({ key: `scr:${d.title}`, group: "Screens", title: d.title, meta: d.meta, icon: d.icon, run: () => goDest(d) }));
    const actions: Item[] = [
      { key: "a:mode", group: "Actions", title: "Switch light / dark", icon: Moon, run: () => { toggleMode(); close(); } },
      { key: "a:pw", group: "Actions", title: "Change password", icon: KeyRound, run: () => { close(); onChangePassword(); } },
      { key: "a:out", group: "Actions", title: "Sign out", icon: LogOut, run: () => { close(); void signOut(); } },
    ];
    if (!term) {
      const pins = pinned.map((p) => byPath.get(p)).filter((l): l is PaletteLink => !!l).map((l) => pageItem(l, "Pinned"));
      const rec = recent.filter((p) => !pinned.includes(p)).map((p) => byPath.get(p)).filter((l): l is PaletteLink => !!l).slice(0, 5).map((l) => pageItem(l, "Recent"));
      return [...needs, ...pins, ...rec, ...(pins.length + rec.length ? [] : links.slice(0, 8).map((l) => pageItem(l, "Pages"))), ...doIt.slice(0, needs.length ? 4 : 6), ...actions];
    }
    // Every word must appear in the label or the section: "pay run" finds
    // Payroll Run, "fin rep" finds Financial Reports.
    const words = term.split(/\s+/);
    const match = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    const pages = links.filter((l) => match(`${l.label} ${l.section}`)).map((l) => pageItem(l, "Pages"));
    return [...needs.filter((a) => match(`${a.title} ${a.meta}`)), ...doIt.filter((a) => match(`${a.title} ${a.meta}`)), ...pages, ...screens.filter((a) => match(`${a.title} ${a.meta}`)), ...hits, ...actions.filter((a) => match(a.title))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, links, hits, pinned, recent, byPath, needs]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[active]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  const groups: string[] = [];
  for (const it of items) if (!groups.includes(it.group)) groups.push(it.group);
  let idx = -1;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-3 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Go to anything">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={close} />
      <div className="relative w-full max-w-xl bg-card border border-border rounded-[20px] shadow-2xl overflow-hidden" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <Search className="w-[18px] h-[18px] text-muted-foreground flex-shrink-0" strokeWidth={1.75} />
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Go to a page or screen, do something, or find a client, guard or invoice…"
            className="flex-1 bg-transparent py-4 text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none"
            aria-label="Search"
          />
          {busy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          <kbd className="hidden sm:inline text-[11px] text-muted-foreground border border-border rounded-md px-1.5 py-0.5">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-2">
          {items.length === 0 && !busy && (
            <p className="px-5 py-6 text-sm text-muted-foreground">Nothing matches “{q.trim()}”. Try a client's name, a guard code or an invoice number.</p>
          )}
          {groups.map((g) => (
            <div key={g} className="pb-1">
              <p className="lbl px-5 pt-2 pb-1 flex items-center gap-1.5">
                {g === "Needs you" && <AlertTriangle className="w-3 h-3" />}{g === "Pinned" && <Star className="w-3 h-3" />}{g === "Recent" && <Clock className="w-3 h-3" />}{g}
              </p>
              {items.filter((it) => it.group === g).map((it) => {
                idx += 1;
                const i = idx;
                const isActive = i === active;
                const Icon = it.icon;
                const isPinned = it.pinPath ? pinned.includes(it.pinPath) : false;
                return (
                  <div
                    key={it.key}
                    data-idx={i}
                    onMouseMove={() => setActive(i)}
                    className={`group mx-2 flex items-center gap-3 rounded-xl px-3 py-2 cursor-pointer ${isActive ? "bg-muted" : ""}`}
                    onClick={it.run}
                  >
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isActive ? "bg-brand-500 text-on-brand" : "bg-muted text-muted-foreground"}`}>
                      <Icon className="w-4 h-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground truncate">{it.title}</span>
                      {it.meta && <span className="block text-xs text-muted-foreground truncate">{it.meta}</span>}
                    </span>
                    {it.pinPath && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); togglePin(it.pinPath!); }}
                        title={isPinned ? "Unpin from the rail" : "Pin to the rail"}
                        className={`p-1.5 rounded-md ${isPinned ? "text-brand-500" : "text-muted-foreground opacity-0 group-hover:opacity-100"} hover:bg-card`}
                      >
                        <Pin className="w-3.5 h-3.5" fill={isPinned ? "currentColor" : "none"} />
                      </button>
                    )}
                    {isActive && <CornerDownLeft className="w-3.5 h-3.5 text-muted-foreground" />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="border-t border-border bg-muted/50 px-4 py-2 flex items-center gap-4 text-[11px] text-muted-foreground">
          <span><kbd className="font-sans">↑↓</kbd> move</span>
          <span><kbd className="font-sans">↵</kbd> open</span>
          <span className="flex items-center gap-1"><Pin className="w-3 h-3" /> pins a page to the rail</span>
          <span className="ml-auto">⌘K anywhere</span>
        </div>
      </div>
    </div>
  );
}
