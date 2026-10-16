import { useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { supabase } from "../../../lib/supabase";
import { formatDate } from "../../../lib/date";
import { money, monthEnd, monthStart, useCompanyId, useDrill, type DrillTarget } from "./kit";

/**
 * One search bar that reaches every entity — client, guard, invoice, journal
 * entry, expense, payslip — and lands on it in the detail tab. Each kind is a
 * plain read-only query; nothing is computed.
 */

type Hit = { kind: string; key: string; title: string; meta: string; open: DrillTarget };

const KINDS = ["Client", "Guard", "Invoice", "Journal entry", "Expense", "Payslip"] as const;

export default function EntitySearch({ period }: { period: string }) {
  const companyId = useCompanyId();
  const drill = useDrill();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!companyId || term.length < 2) { setHits([]); return; }
    let cancelled = false;
    const h = setTimeout(() => {
      void (async () => {
        setBusy(true);
        // PostgREST .or() values: strip the characters that would break the filter.
        const like = `%${term.replace(/[%,()*]/g, " ")}%`;
        const start = monthStart(period).slice(0, 4) + "-01-01";
        const [cl, em, inv, je, ex, ps] = await Promise.all([
          supabase.from("clients").select("id, name, client_code").eq("company_id", companyId).or(`name.ilike.${like},client_code.ilike.${like}`).limit(6),
          supabase.from("employees").select("id, full_name, guard_code, employee_code").eq("company_id", companyId).or(`full_name.ilike.${like},guard_code.ilike.${like},employee_code.ilike.${like}`).limit(6),
          supabase.from("invoices").select("id, invoice_number, invoice_amount, service_month, client:client_id(name)").eq("company_id", companyId).ilike("invoice_number", like).limit(6),
          supabase.from("journal_entries").select("id, entry_date, description, source_table").eq("company_id", companyId).ilike("description", like).order("entry_date", { ascending: false }).limit(6),
          supabase.from("expenses").select("id, expense_date, amount, description").eq("company_id", companyId).ilike("description", like).order("expense_date", { ascending: false }).limit(6),
          supabase.from("payslips").select("id, period_month, net_salary, employee:employee_id!inner(full_name)").eq("company_id", companyId).ilike("employee.full_name", like).gte("period_month", start).order("period_month", { ascending: false }).limit(6),
        ]);
        if (cancelled) return;
        const out: Hit[] = [];
        for (const r of (cl.data ?? []) as { id: string; name: string; client_code: string | null }[])
          out.push({ kind: "Client", key: `c${r.id}`, title: r.name, meta: r.client_code ?? "",
            open: { type: "ledger", kind: "client", subjectId: r.id, title: `Client ledger — ${r.name}`, start: `${period.slice(0, 4)}-01-01`, end: monthEnd(period) } });
        for (const r of (em.data ?? []) as { id: string; full_name: string; guard_code: string | null; employee_code: string | null }[])
          out.push({ kind: "Guard", key: `e${r.id}`, title: r.full_name, meta: r.guard_code ?? r.employee_code ?? "",
            open: { type: "ledger", kind: "guard", subjectId: r.id, title: `Guard ledger — ${r.full_name}`, start: `${period.slice(0, 4)}-01-01`, end: monthEnd(period) } });
        for (const r of (inv.data ?? []) as unknown as { id: string; invoice_number: string; invoice_amount: number; service_month: string; client: { name: string } | null }[])
          out.push({ kind: "Invoice", key: `i${r.id}`, title: r.invoice_number, meta: `${r.client?.name ?? ""} · ${formatDate(r.service_month)} · ${money(r.invoice_amount)}`,
            open: { type: "source", table: "invoices", id: r.id } });
        for (const r of (je.data ?? []) as { id: string; entry_date: string; description: string; source_table: string | null }[])
          out.push({ kind: "Journal entry", key: `j${r.id}`, title: r.description, meta: `${formatDate(r.entry_date)} · ${r.source_table?.replace(/_/g, " ") ?? "manual"}`,
            open: { type: "entry", id: r.id } });
        for (const r of (ex.data ?? []) as { id: string; expense_date: string; amount: number; description: string | null }[])
          out.push({ kind: "Expense", key: `x${r.id}`, title: r.description ?? "Expense", meta: `${formatDate(r.expense_date)} · ${money(r.amount)}`,
            open: { type: "source", table: "expenses", id: r.id } });
        for (const r of (ps.data ?? []) as unknown as { id: string; period_month: string; net_salary: number; employee: { full_name: string } | null }[])
          out.push({ kind: "Payslip", key: `p${r.id}`, title: r.employee?.full_name ?? "Payslip", meta: `${formatDate(r.period_month)} · net ${money(r.net_salary)}`,
            open: { type: "source", table: "payslips", id: r.id } });
        setHits(out);
        setBusy(false);
        setOpen(true);
      })();
    }, 250);
    return () => { cancelled = true; clearTimeout(h); };
  }, [q, companyId, period]);

  return (
    <div ref={boxRef} className="relative w-full">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => hits.length && setOpen(true)}
          placeholder="Search clients, guards, invoices, journal entries, expenses, payslips…"
          className="w-full pl-9 pr-9 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        />
        {busy && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />}
      </div>
      {open && q.trim().length >= 2 && (
        <div className="absolute z-30 mt-1 w-full max-h-[26rem] overflow-y-auto bg-card border border-border rounded-lg shadow-lg">
          {hits.length === 0 && !busy && <div className="px-3 py-3 text-sm text-muted-foreground">Nothing matches.</div>}
          {KINDS.map((k) => {
            const group = hits.filter((h) => h.kind === k);
            if (group.length === 0) return null;
            return (
              <div key={k}>
                <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{k}</div>
                {group.map((h) => (
                  <button key={h.key} type="button" onClick={() => { setOpen(false); drill(h.open); }}
                    className="w-full text-left px-3 py-2 hover:bg-muted/40">
                    <div className="text-sm text-foreground truncate">{h.title}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{h.meta}</div>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
