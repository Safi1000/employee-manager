// Shift Management — a deliberately minimal sibling of Assignments & Pay.
//
// It answers ONE question: "who is on what shift, and change it." So it shows a
// client list, each expandable to Code / Name / Department / Shift, with a single
// "Shift Change" action per row. Everything Assignments & Pay carries that is NOT
// about shifts — summary cards, mismatch filters, warnings, Base/Per-day/Allowance
// /Joined columns, Fire/Assign/Edit-rules, bulk-select — is intentionally absent.
// This is a distinct component, not the big page with sections hidden, because a
// clean purpose-built screen is cheaper to keep correct than a prop-riddled one.
//
// It reuses the real machinery where it matters: the ChangeShiftModal (dated
// change_guard_shift RPC) and the guardDisplayCode helper, so it can never drift
// from how a shift change actually works. Department is derived the same way
// Assignments & Pay derives it (contract-line label, else the client's sole
// personnel category), carried here as two small pure memos.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, ChevronDown, ChevronRight, Loader2, Search } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { supabase, type Employee, type Client, type Contract, type ContractLine, type ContractLineCategory, CONTRACT_LINE_CATEGORY_LABEL, isPersonnelCategory } from "../../lib/supabase";
import { useRegion, withRegion } from "../../lib/region";
import { isSeparatedState } from "../../lib/employmentWindow";
import { hasPermission, useAuth } from "../../lib/auth";
import { guardDisplayCode } from "../../lib/guardCode";
import { ChangeShiftModal, type EmployeeRow } from "./EmployeeManagement";
import ContractEditorModal from "../../components/ContractEditorModal";
import { SlidersHorizontal } from "lucide-react";

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function ShiftManagement() {
  const { profile } = useAuth();
  const { regionId } = useRegion();
  // Shift change is an HR action (not Base Salary / Joining Date, which are
  // Accounts). Mirror the existing Assignments & Pay gate exactly: canHr guards
  // the button; the change_guard_shift RPC enforces employees.edit at the DB.
  const canHr = hasPermission(profile, "assignments.hr") || hasPermission(profile, "employees.edit");

  const [clients, setClients] = useState<Client[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [contractLines, setContractLines] = useState<ContractLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [shiftTarget, setShiftTarget] = useState<EmployeeRow | null>(null);
  // "Edit rules" opens the real ContractEditorModal (contract_lines is the
  // authority for committed counts / shift detail, and drives Assignments & Pay's
  // Contracted/variance). We edit the client's active guard-deployment contract,
  // the newest if several. No parallel editor — same data the Contracts page edits.
  const [rulesClient, setRulesClient] = useState<Client | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [cliRes, empRes, conRes, clRes] = await Promise.all([
      regionId
        ? supabase.from("clients").select("*").or(`branch_id.eq.${regionId},branch_id.is.null`).order("name")
        : supabase.from("clients").select("*").order("name"),
      withRegion(
        supabase.from("employees").select("*, client:client_id(name)").order("full_name"),
        regionId,
      ),
      supabase.from("contracts").select("*"),
      supabase.from("contract_lines").select("*"),
    ]);
    const firstErr = [cliRes, empRes, conRes, clRes].find((r) => r.error)?.error;
    if (firstErr) setError(firstErr.message);
    setClients((cliRes.data ?? []) as Client[]);
    setContracts((conRes.data ?? []) as Contract[]);
    setContractLines((clRes.data ?? []) as ContractLine[]);
    setEmployees(
      (empRes.data ?? []).map((e: any) => ({
        ...e,
        client_name: e.client?.name ?? null,
        location_name: null,
        branch_name: null,
        additional_branch_ids: [],
        doc_count: 0,
      })) as EmployeeRow[],
    );
    setLoading(false);
  }, [regionId]);

  useEffect(() => { loadData(); }, [loadData]);

  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);

  // The active guard-deployment contract per client (newest start_date wins) —
  // the one "Edit rules" opens. A client with none has no shift structure to edit.
  const activeContractByClient = useMemo(() => {
    const m = new Map<string, Contract>();
    for (const k of contracts) {
      if (k.status !== "active" || k.contract_type !== "guard_deployment") continue;
      const prev = m.get(k.client_id);
      if (!prev || (k.start_date ?? "") > (prev.start_date ?? "")) m.set(k.client_id, k);
    }
    return m;
  }, [contracts]);

  // Department derivation — identical rule to Assignments & Pay.
  const lineLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of contractLines) m.set(l.id, (l.label ?? "").trim() || CONTRACT_LINE_CATEGORY_LABEL[l.category]);
    return m;
  }, [contractLines]);
  const soleCategoryByClient = useMemo(() => {
    const byClient = new Map<string, ContractLineCategory | null>();
    const linesByContract = new Map<string, ContractLine[]>();
    for (const l of contractLines) {
      const arr = linesByContract.get(l.contract_id) ?? [];
      arr.push(l);
      linesByContract.set(l.contract_id, arr);
    }
    for (const k of contracts) {
      if (k.status !== "active") continue;
      const cats = new Set<ContractLineCategory>();
      for (const l of linesByContract.get(k.id) ?? []) if (isPersonnelCategory(l.category)) cats.add(l.category);
      if (cats.size === 0) continue;
      const prev = byClient.get(k.client_id);
      const only = cats.size === 1 ? [...cats][0] : null;
      byClient.set(k.client_id, prev === undefined ? only : prev === only ? only : null);
    }
    return byClient;
  }, [contracts, contractLines]);
  const departmentOf = useCallback(
    (e: EmployeeRow) => {
      if (e.contract_line_id) return lineLabelById.get(e.contract_line_id) ?? null;
      if (!e.client_id) return null;
      const sole = soleCategoryByClient.get(e.client_id);
      return sole ? CONTRACT_LINE_CATEGORY_LABEL[sole] : null;
    },
    [lineLabelById, soleCategoryByClient],
  );

  // Active client-posted guards, grouped by client. Office staff / relievers /
  // separated / unposted are out of scope: shift is a client-posting property.
  const rowsByClient = useMemo(() => {
    const m = new Map<string, EmployeeRow[]>();
    for (const e of employees) {
      if (isSeparatedState(e.lifecycle_state)) continue;
      if ((e.category ?? "client") !== "client" || !e.client_id) continue;
      const arr = m.get(e.client_id) ?? [];
      arr.push(e);
      m.set(e.client_id, arr);
    }
    return m;
  }, [employees]);

  // Client list: only those with people to manage, name-filtered by the search.
  const visibleClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients
      .filter((c) => (rowsByClient.get(c.id)?.length ?? 0) > 0)
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, rowsByClient, search]);

  const toggle = (id: string) =>
    setOpen((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <>
      <Header title="Shift Management" subtitle="View and change each guard's shift, by client" />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4">
        {error && (
          <div className="p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">{error}</div>
        )}

        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients…"
            className="w-full pl-9 pr-3 py-2 border border-border bg-card rounded-md text-sm text-foreground"
          />
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : visibleClients.length === 0 ? (
          <div className="text-center text-muted-foreground text-sm py-8">No clients with posted guards.</div>
        ) : (
          <div className="space-y-2">
            {visibleClients.map((c) => {
              const rows = (rowsByClient.get(c.id) ?? []).slice().sort((a, b) => a.full_name.localeCompare(b.full_name));
              const isOpen = open.has(c.id);
              return (
                <div key={c.id} className="bg-card border border-border rounded-lg overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors">
                    <button
                      type="button"
                      onClick={() => toggle(c.id)}
                      className="flex items-center gap-3 text-left flex-1 min-w-0"
                    >
                      {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                      <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="font-medium text-foreground truncate">{c.name}</span>
                      <span className="text-xs text-muted-foreground">{rows.length} on roster</span>
                    </button>
                    {canHr && activeContractByClient.has(c.id) && (
                      <Button size="sm" variant="secondary" onClick={() => setRulesClient(c)}>
                        <SlidersHorizontal className="w-3.5 h-3.5 mr-1" /> Edit rules
                      </Button>
                    )}
                  </div>

                  {isOpen && (
                    <div className="overflow-x-auto border-t border-border">
                      <table className="w-full">
                        <thead>
                          <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide bg-muted/30">
                            <th className="px-4 py-2 font-medium">Code</th>
                            <th className="px-4 py-2 font-medium">Name</th>
                            <th className="px-4 py-2 font-medium">Department</th>
                            <th className="px-4 py-2 font-medium">Shift</th>
                            <th className="px-4 py-2" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {rows.map((e) => (
                            <tr key={e.id} className="hover:bg-accent/40 transition-colors">
                              <td className="px-4 py-2 text-sm font-mono text-muted-foreground whitespace-nowrap">
                                {guardDisplayCode(e, clientById.get(e.client_id ?? "")?.employee_id_prefix)}
                              </td>
                              <td className="px-4 py-2 text-sm text-foreground">{e.full_name}</td>
                              <td className="px-4 py-2 text-sm text-muted-foreground">{departmentOf(e) ?? "—"}</td>
                              <td className="px-4 py-2 text-sm text-muted-foreground capitalize whitespace-nowrap">{e.shift}</td>
                              <td className="px-4 py-2 text-right whitespace-nowrap">
                                {canHr && ["active", "on_leave"].includes(e.lifecycle_state ?? "") && (
                                  <Button size="sm" variant="secondary" onClick={() => setShiftTarget(e)}>Shift Change</Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {shiftTarget && (
        <ChangeShiftModal
          guard={shiftTarget}
          displayCode={guardDisplayCode(shiftTarget, clientById.get(shiftTarget.client_id ?? "")?.employee_id_prefix)}
          onClose={() => setShiftTarget(null)}
          onDone={async () => { setShiftTarget(null); await loadData(); }}
          onError={setError}
        />
      )}

      {rulesClient && activeContractByClient.get(rulesClient.id) && (
        <ContractEditorModal
          isOpen
          linesOnly
          clientId={rulesClient.id}
          clientName={rulesClient.name}
          contract={activeContractByClient.get(rulesClient.id)!}
          onClose={() => setRulesClient(null)}
          onSaved={() => { setRulesClient(null); loadData(); }}
        />
      )}
    </>
  );
}
