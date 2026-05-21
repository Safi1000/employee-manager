import { useEffect, useMemo, useState } from "react";
import { Plus, Shield, Users as UsersIcon, MapPin, AlertCircle, Loader2, X, Trash2, Package, Building2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import {
  supabase,
  type InventoryItem,
  type InventoryKind,
  type Issuance,
  type Location,
  type Employee,
  type Client,
  type ReturnCondition,
  type Branch,
} from "../../lib/supabase";

type ItemRow = InventoryItem & {
  location_name: string | null;
  issued_to_name: string | null;
  active_issuance_id: string | null;
  active_issuance_count: number;
};

type IssuanceRow = Issuance & {
  target_kind: "employee" | "client";
  target_name: string;
  target_code: string;
  employee_shift: "day" | "night" | null;
  item_type: string;
  item_kind: InventoryKind;
  serial_number: string | null;
  size: string | null;
  location_name: string | null;
};

type AddItemForm = {
  kind: InventoryKind;
  item_type: string;
  serial_number: string;
  size: string;
  quantity: string;
  location_id: string;
  branch_id: string;
  license_expiry: string;
  notes: string;
};

const emptyAddItem: AddItemForm = {
  kind: "weapon",
  item_type: "",
  serial_number: "",
  size: "",
  quantity: "1",
  location_id: "",
  branch_id: "",
  license_expiry: "",
  notes: "",
};

type IssueForm = {
  kind: InventoryKind;
  item_id: string;
  target: "employee" | "client";
  employee_id: string;
  client_id: string;
  branch_id: string;
  issue_date: string;
  notes: string;
};

const today = () => new Date().toISOString().split("T")[0];

const emptyIssueForm = (): IssueForm => ({
  kind: "weapon",
  item_id: "",
  target: "employee",
  employee_id: "",
  client_id: "",
  branch_id: "",
  issue_date: today(),
  notes: "",
});

type ReturnForm = {
  return_date: string;
  condition: ReturnCondition;
  notes: string;
};

const emptyReturnForm = (): ReturnForm => ({
  return_date: today(),
  condition: "Good",
  notes: "",
});

const LOW_STOCK_THRESHOLD = 10;

const uniformStockStatus = (qty: number) =>
  qty === 0 ? "Out of Stock" : qty <= LOW_STOCK_THRESHOLD ? "Low Stock" : "In Stock";

type FilterState = {
  location_id: string;
  branch_id: string;
  date_from: string;
  date_to: string;
  client_id: string;
  shift: "" | "day" | "night";
};

const emptyFilters: FilterState = {
  location_id: "",
  branch_id: "",
  date_from: "",
  date_to: "",
  client_id: "",
  shift: "",
};

export default function Inventory() {
  const [activeTab, setActiveTab] = useState<"weapons" | "uniforms" | "issuance">("weapons");

  const [locations, setLocations] = useState<Location[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [employees, setEmployees] = useState<(Employee & { branch_id: string | null })[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [issuances, setIssuances] = useState<IssuanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<FilterState>(emptyFilters);

  const [isAddItemOpen, setIsAddItemOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddItemForm>(emptyAddItem);
  const [addSubmitting, setAddSubmitting] = useState(false);

  const [isIssueOpen, setIsIssueOpen] = useState(false);
  const [issueForm, setIssueForm] = useState<IssueForm>(emptyIssueForm());
  const [issueSubmitting, setIssueSubmitting] = useState(false);

  const [viewWeapon, setViewWeapon] = useState<ItemRow | null>(null);
  const [stockItem, setStockItem] = useState<ItemRow | null>(null);
  const [stockQty, setStockQty] = useState("0");
  const [stockSubmitting, setStockSubmitting] = useState(false);

  const [returnIssuance, setReturnIssuance] = useState<IssuanceRow | null>(null);
  const [returnForm, setReturnForm] = useState<ReturnForm>(emptyReturnForm());
  const [returnSubmitting, setReturnSubmitting] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [locRes, empRes, cliRes, brRes, itemsRes, issRes] = await Promise.all([
      supabase.from("locations").select("*").order("name"),
      supabase.from("employees").select("id, full_name, employee_code, shift, branch_id, client_id").order("full_name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
      supabase
        .from("inventory_items")
        .select("*, location:location_id(name)")
        .order("created_at", { ascending: false }),
      supabase
        .from("issuances")
        .select(
          "*, employee:employee_id(full_name, employee_code, shift), client:client_id(name, client_code), item:item_id(item_type, kind, serial_number, size), location:location_id(name)"
        )
        .order("issue_date", { ascending: false }),
    ]);

    if (locRes.error) setError(locRes.error.message);
    if (empRes.error) setError(empRes.error.message);
    if (cliRes.error) setError(cliRes.error.message);
    if (itemsRes.error) setError(itemsRes.error.message);
    if (issRes.error) setError(issRes.error.message);

    const activeByItem = new Map<string, { name: string; issuance_id: string; count: number }>();
    for (const raw of issRes.data ?? []) {
      const r = raw as any;
      if (!r.return_date) {
        const existing = activeByItem.get(r.item_id);
        const name = r.employee?.full_name ?? r.client?.name ?? "â€”";
        if (existing) {
          activeByItem.set(r.item_id, {
            name: existing.count === 0 ? name : `${existing.name}, ${name}`,
            issuance_id: existing.issuance_id,
            count: existing.count + 1,
          });
        } else {
          activeByItem.set(r.item_id, { name, issuance_id: r.id, count: 1 });
        }
      }
    }

    setLocations(locRes.data ?? []);
    setEmployees((empRes.data ?? []) as (Employee & { branch_id: string | null })[]);
    setClients((cliRes.data ?? []) as Client[]);
    setBranches((brRes.data ?? []) as Branch[]);
    setItems(
      ((itemsRes.data ?? []) as any[]).map((r) => {
        const active = activeByItem.get(r.id);
        return {
          ...r,
          location_name: r.location?.name ?? null,
          issued_to_name: active?.name ?? null,
          active_issuance_id: active?.issuance_id ?? null,
          active_issuance_count: active?.count ?? 0,
        } as ItemRow;
      })
    );
    setIssuances(
      ((issRes.data ?? []) as any[]).map((r) => {
        const isClient = !!r.client_id;
        return {
          ...r,
          target_kind: (isClient ? "client" : "employee") as "employee" | "client",
          target_name: isClient ? r.client?.name ?? "â€”" : r.employee?.full_name ?? "â€”",
          target_code: isClient ? r.client?.client_code ?? "" : r.employee?.employee_code ?? "",
          employee_shift: (r.employee?.shift ?? null) as "day" | "night" | null,
          item_type: r.item?.item_type ?? "â€”",
          item_kind: (r.item?.kind ?? "weapon") as InventoryKind,
          serial_number: r.item?.serial_number ?? null,
          size: r.item?.size ?? null,
          location_name: r.location?.name ?? null,
        };
      })
    );
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const matchesFilters = (iss: IssuanceRow): boolean => {
    if (filters.location_id && iss.location_id !== filters.location_id) return false;
    if (filters.branch_id && iss.branch_id !== filters.branch_id) return false;
    if (filters.date_from && iss.issue_date < filters.date_from) return false;
    if (filters.date_to && iss.issue_date > filters.date_to) return false;
    if (filters.client_id && iss.client_id !== filters.client_id) return false;
    if (filters.shift) {
      if (iss.target_kind !== "employee") return false;
      if (iss.employee_shift !== filters.shift) return false;
    }
    return true;
  };

  const filteredIssuances = useMemo(() => issuances.filter(matchesFilters), [issuances, filters]);

  const issuedItemIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of filteredIssuances) {
      if (!r.return_date) ids.add(r.item_id);
    }
    return ids;
  }, [filteredIssuances]);

  const filteredItems = useMemo(() => {
    return items.filter((i) => {
      if (filters.location_id && i.location_id !== filters.location_id) return false;
      if (filters.branch_id && i.branch_id !== filters.branch_id) return false;
      return true;
    });
  }, [items, filters.location_id, filters.branch_id]);

  const weapons = useMemo(() => filteredItems.filter((i) => i.kind === "weapon"), [filteredItems]);
  const uniforms = useMemo(() => filteredItems.filter((i) => i.kind === "uniform"), [filteredItems]);

  const filtersActive =
    !!(filters.location_id || filters.branch_id || filters.date_from || filters.date_to || filters.client_id || filters.shift);

  const weaponsSummary = useMemo(() => {
    let issuedEmp = 0;
    let issuedClient = 0;
    for (const r of filteredIssuances) {
      if (r.item_kind !== "weapon" || r.return_date) continue;
      if (r.target_kind === "client") issuedClient += 1;
      else issuedEmp += 1;
    }
    const total = filtersActive ? issuedEmp + issuedClient : weapons.length;
    const inOffice = filtersActive
      ? 0
      : weapons.filter((w) => w.status !== "Issued").length;
    return { total, issuedEmp, issuedClient, inOffice };
  }, [filteredIssuances, weapons, filtersActive]);

  const uniformsSummary = useMemo(() => {
    let issuedEmp = 0;
    let issuedClient = 0;
    for (const r of filteredIssuances) {
      if (r.item_kind !== "uniform" || r.return_date) continue;
      if (r.target_kind === "client") issuedClient += 1;
      else issuedEmp += 1;
    }
    const inStock = filtersActive
      ? 0
      : uniforms.reduce((sum, u) => sum + (u.quantity || 0), 0);
    const total = filtersActive ? issuedEmp + issuedClient : inStock + issuedEmp + issuedClient;
    return { total, issuedEmp, issuedClient, inOffice: inStock };
  }, [filteredIssuances, uniforms, filtersActive]);

  const issuableItems = useMemo(
    () =>
      filteredItems.filter((i) =>
        issueForm.kind === "weapon"
          ? i.kind === "weapon" && (i.active_issuance_count ?? 0) < 2
          : i.kind === "uniform" && i.quantity > 0
      ),
    [filteredItems, issueForm.kind]
  );

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.item_type.trim()) return;
    setAddSubmitting(true);
    setError(null);
    try {
      const payload = {
        kind: addForm.kind,
        item_type: addForm.item_type.trim(),
        serial_number: addForm.kind === "weapon" ? addForm.serial_number.trim() || null : null,
        size: addForm.kind === "uniform" ? addForm.size.trim() || null : null,
        quantity: addForm.kind === "uniform" ? Math.max(0, Number(addForm.quantity) || 0) : 1,
        location_id: addForm.location_id || null,
        branch_id: addForm.branch_id || null,
        license_expiry: addForm.kind === "weapon" && addForm.license_expiry ? addForm.license_expiry : null,
        notes: addForm.notes.trim() || null,
        status: "Available" as const,
      };
      const { error: insErr } = await supabase.from("inventory_items").insert(payload);
      if (insErr) throw insErr;
      setAddForm(emptyAddItem);
      setIsAddItemOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleDeleteItem = async (item: ItemRow) => {
    const label =
      item.kind === "weapon"
        ? `${item.item_type}${item.serial_number ? ` (${item.serial_number})` : ""}`
        : `${item.item_type}${item.size ? ` â€” ${item.size}` : ""}`;
    if (!window.confirm(`Delete ${label}? All related issuance records will also be removed.`)) return;
    setError(null);
    const { error: delErr } = await supabase.from("inventory_items").delete().eq("id", item.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const openIssueModal = () => {
    setIssueForm(emptyIssueForm());
    setIsIssueOpen(true);
  };

  const handleIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!issueForm.item_id) return;
    if (issueForm.target === "employee" && !issueForm.employee_id) return;
    if (issueForm.target === "client" && !issueForm.client_id) return;
    setIssueSubmitting(true);
    setError(null);
    try {
      const item = items.find((i) => i.id === issueForm.item_id);
      if (!item) throw new Error("Selected item not found");

      if (item.kind === "weapon") {
        const { data: activeRaw, error: actErr } = await supabase
          .from("issuances")
          .select("id, employee_id, client_id, employee:employee_id(shift)")
          .eq("item_id", item.id)
          .is("return_date", null);
        if (actErr) throw actErr;
        const active = (activeRaw ?? []) as any[];
        if (active.length >= 2) {
          throw new Error("This weapon already has 2 active issuances. Mark one as returned first.");
        }
        if (issueForm.target === "employee") {
          const emp = employees.find((e) => e.id === issueForm.employee_id);
          const thisShift = emp?.shift ?? null;
          for (const a of active) {
            if (a.employee_id) {
              const otherShift = a.employee?.shift ?? null;
              if (otherShift && thisShift && otherShift === thisShift) {
                throw new Error(
                  `This weapon is already issued to an employee on the ${thisShift} shift. Alternate shifts are required.`
                );
              }
            }
          }
        }
      }

      // Branch resolution: user-picked override > employee branch > client branch > item branch.
      let branchId: string | null = issueForm.branch_id || null;
      if (!branchId) {
        if (issueForm.target === "employee") {
          const emp = employees.find((e) => e.id === issueForm.employee_id);
          branchId = emp?.branch_id ?? null;
        } else {
          const cli = clients.find((c) => c.id === issueForm.client_id);
          branchId = cli?.branch_id ?? null;
        }
        if (!branchId) branchId = item.branch_id ?? null;
      }
      const { error: insErr } = await supabase.from("issuances").insert({
        item_id: item.id,
        employee_id: issueForm.target === "employee" ? issueForm.employee_id : null,
        client_id: issueForm.target === "client" ? issueForm.client_id : null,
        location_id: item.location_id,
        branch_id: branchId,
        issue_date: issueForm.issue_date,
        notes: issueForm.notes.trim() || null,
      });
      if (insErr) throw insErr;

      if (item.kind === "weapon") {
        const { error: upErr } = await supabase
          .from("inventory_items")
          .update({ status: "Issued", updated_at: new Date().toISOString() })
          .eq("id", item.id);
        if (upErr) throw upErr;
      } else {
        const { error: upErr } = await supabase
          .from("inventory_items")
          .update({ quantity: item.quantity - 1, updated_at: new Date().toISOString() })
          .eq("id", item.id);
        if (upErr) throw upErr;
      }

      setIsIssueOpen(false);
      setIssueForm(emptyIssueForm());
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setIssueSubmitting(false);
    }
  };

  const openReturn = (iss: IssuanceRow) => {
    setReturnIssuance(iss);
    setReturnForm(emptyReturnForm());
  };

  const handleReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnIssuance) return;
    setReturnSubmitting(true);
    setError(null);
    try {
      const { error: upIssErr } = await supabase
        .from("issuances")
        .update({
          return_date: returnForm.return_date,
          condition: returnForm.condition,
          notes: returnForm.notes.trim() || null,
        })
        .eq("id", returnIssuance.id);
      if (upIssErr) throw upIssErr;

      const item = items.find((i) => i.id === returnIssuance.item_id);
      if (item) {
        if (item.kind === "weapon") {
          const remaining = Math.max(0, (item.active_issuance_count ?? 0) - 1);
          await supabase
            .from("inventory_items")
            .update({
              status: remaining > 0 ? "Issued" : "Available",
              updated_at: new Date().toISOString(),
            })
            .eq("id", item.id);
        } else {
          await supabase
            .from("inventory_items")
            .update({ quantity: item.quantity + 1, updated_at: new Date().toISOString() })
            .eq("id", item.id);
        }
      }

      setReturnIssuance(null);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setReturnSubmitting(false);
    }
  };

  const openStock = (item: ItemRow) => {
    setStockItem(item);
    setStockQty(String(item.quantity));
  };

  const handleStockUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stockItem) return;
    const next = Math.max(0, Number(stockQty) || 0);
    setStockSubmitting(true);
    setError(null);
    const { error: upErr } = await supabase
      .from("inventory_items")
      .update({ quantity: next, updated_at: new Date().toISOString() })
      .eq("id", stockItem.id);
    setStockSubmitting(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setStockItem(null);
    await loadAll();
  };

  const resetFilters = () => setFilters(emptyFilters);

  return (
    <>
      <Header
        title="Inventory & Asset Logistics"
        actions={
          <>
            <Button variant="secondary" size="md" onClick={() => setIsAddItemOpen(true)}>
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Add Item
            </Button>
            <Button variant="primary" size="md" onClick={openIssueModal}>
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Issue Item
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Shield className="w-4 h-4 text-danger-600" strokeWidth={1.5} />
              <h3 className="text-sm text-slate-900">Weapons</h3>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <SummaryCell label="Total" value={weaponsSummary.total} />
              <SummaryCell label="To Employees" value={weaponsSummary.issuedEmp} accent="blue" />
              <SummaryCell label="To Clients" value={weaponsSummary.issuedClient} accent="purple" />
              <SummaryCell label="In Office" value={weaponsSummary.inOffice} accent="green" />
            </div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Package className="w-4 h-4 text-brand-600" strokeWidth={1.5} />
              <h3 className="text-sm text-slate-900">Uniforms &amp; Gear</h3>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <SummaryCell label="Total" value={uniformsSummary.total} />
              <SummaryCell label="To Employees" value={uniformsSummary.issuedEmp} accent="blue" />
              <SummaryCell label="To Clients" value={uniformsSummary.issuedClient} accent="purple" />
              <SummaryCell label="In Office" value={uniformsSummary.inOffice} accent="green" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-7 gap-3 items-end">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Location</label>
              <select
                value={filters.location_id}
                onChange={(e) => setFilters({ ...filters, location_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">All</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Branch</label>
              <select
                value={filters.branch_id}
                onChange={(e) => setFilters({ ...filters, branch_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">All</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">From</label>
              <input
                type="date"
                value={filters.date_from}
                onChange={(e) => setFilters({ ...filters, date_from: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">To</label>
              <input
                type="date"
                value={filters.date_to}
                onChange={(e) => setFilters({ ...filters, date_to: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Client</label>
              <ClientFilterSelect
                clients={clients}
                value={filters.client_id}
                onChange={(v) => setFilters({ ...filters, client_id: v })}
                allLabel="All"
                filterFn={(c) => c.client_type === "security_services"}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Shift</label>
              <select
                value={filters.shift}
                onChange={(e) => setFilters({ ...filters, shift: e.target.value as FilterState["shift"] })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">All</option>
                <option value="day">Day</option>
                <option value="night">Night</option>
              </select>
            </div>
            <div>
              <Button variant="secondary" size="md" className="w-full" onClick={resetFilters}>
                Reset
              </Button>
            </div>
          </div>
          {filtersActive && (
            <p className="text-xs text-slate-500 mt-2">
              Filters active. Summary cards and tables reflect matching issuance records.
            </p>
          )}
        </div>

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex gap-2">
              {(
                [
                  { key: "weapons", label: "Weapons Inventory" },
                  { key: "uniforms", label: "Uniforms & Gear" },
                  { key: "issuance", label: "Issuance Tracking" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${
                    activeTab === tab.key
                      ? "bg-brand-600 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {activeTab === "weapons" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Serial Number</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Issued To</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">License Expiry</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {loading && (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500">
                        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loadingâ€¦
                      </td>
                    </tr>
                  )}
                  {!loading && weapons.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No weapons match current filters.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    weapons
                      .filter((w) => (filtersActive ? issuedItemIds.has(w.id) : true))
                      .map((weapon) => (
                        <tr key={weapon.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <Shield className="w-4 h-4 text-danger-600" strokeWidth={1.5} />
                              <span className="text-sm text-slate-900">{weapon.item_type}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600 font-mono">
                            {weapon.serial_number ?? "â€”"}
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                                weapon.status === "Issued"
                                  ? "bg-brand-50 text-brand-700"
                                  : weapon.status === "Available"
                                  ? "bg-success-50 text-success-700"
                                  : "bg-warning-50 text-warning-700"
                              }`}
                            >
                              {weapon.status}
                              {weapon.active_issuance_count > 1 && ` Â· ${weapon.active_issuance_count}x`}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">{weapon.location_name ?? "â€”"}</td>
                          <td className="px-6 py-4 text-sm text-slate-900">
                            {weapon.issued_to_name ?? "â€”"}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {weapon.license_expiry ?? "â€”"}
                          </td>
                          <td className="px-6 py-4 flex gap-1">
                            <Button variant="ghost" size="sm" onClick={() => setViewWeapon(weapon)}>
                              View
                            </Button>
                            <button
                              type="button"
                              onClick={() => handleDeleteItem(weapon)}
                              className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-danger-700 hover:bg-danger-50"
                              title="Delete weapon"
                            >
                              <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                            </button>
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "uniforms" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Item Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Size</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Quantity</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {loading && (
                    <tr>
                      <td colSpan={6} className="px-6 py-10 text-center text-slate-500">
                        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loadingâ€¦
                      </td>
                    </tr>
                  )}
                  {!loading && uniforms.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No uniforms match current filters.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    uniforms
                      .filter((u) => (filtersActive ? issuedItemIds.has(u.id) : true))
                      .map((u) => {
                        const stat = uniformStockStatus(u.quantity);
                        return (
                          <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2">
                                <UsersIcon className="w-4 h-4 text-brand-600" strokeWidth={1.5} />
                                <span className="text-sm text-slate-900">{u.item_type}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-sm text-slate-600">{u.size ?? "â€”"}</td>
                            <td className="px-6 py-4 text-sm text-slate-900">{u.quantity}</td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2">
                                <MapPin className="w-4 h-4 text-slate-400" strokeWidth={1.5} />
                                <span className="text-sm text-slate-600">{u.location_name ?? "â€”"}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span
                                className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                                  stat === "In Stock"
                                    ? "bg-success-50 text-success-700"
                                    : stat === "Low Stock"
                                    ? "bg-warning-50 text-warning-700"
                                    : "bg-danger-50 text-danger-700"
                                }`}
                              >
                                {stat}
                              </span>
                            </td>
                            <td className="px-6 py-4 flex gap-1">
                              <Button variant="ghost" size="sm" onClick={() => openStock(u)}>
                                Manage Stock
                              </Button>
                              <button
                                type="button"
                                onClick={() => handleDeleteItem(u)}
                                className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-danger-700 hover:bg-danger-50"
                                title="Delete item"
                              >
                                <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "issuance" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Issued To</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Item</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Issued Date</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Return Date</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Condition</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {loading && (
                    <tr>
                      <td colSpan={8} className="px-6 py-10 text-center text-slate-500">
                        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loadingâ€¦
                      </td>
                    </tr>
                  )}
                  {!loading && filteredIssuances.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No issuances match current filters.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    filteredIssuances.map((r) => {
                      const detail =
                        r.item_kind === "weapon"
                          ? r.serial_number ?? "â€”"
                          : r.size ?? "â€”";
                      return (
                        <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-4 text-sm text-slate-900">
                            <div className="flex items-center gap-2">
                              {r.target_kind === "client" ? (
                                <Building2 className="w-3.5 h-3.5 text-purple-600" strokeWidth={1.5} />
                              ) : (
                                <UsersIcon className="w-3.5 h-3.5 text-brand-600" strokeWidth={1.5} />
                              )}
                              <span>{r.target_name}</span>
                            </div>
                            <div className="text-xs text-slate-500 font-mono ml-5">{r.target_code}</div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {r.item_type} <span className="text-slate-400">({detail})</span>
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs capitalize ${
                                r.item_kind === "weapon"
                                  ? "bg-danger-50 text-danger-700"
                                  : "bg-brand-50 text-brand-700"
                              }`}
                            >
                              {r.item_kind}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {r.location_name ?? "â€”"}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">{r.issue_date}</td>
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {r.return_date ?? "â€”"}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {r.condition ? (
                              <span
                                className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                                  r.condition === "Good"
                                    ? "bg-success-50 text-success-700"
                                    : r.condition === "Fair"
                                    ? "bg-warning-50 text-warning-700"
                                    : "bg-danger-50 text-danger-700"
                                }`}
                              >
                                {r.condition}
                              </span>
                            ) : (
                              "â€”"
                            )}
                          </td>
                          <td className="px-6 py-4">
                            {r.return_date ? (
                              <span className="text-xs text-slate-400">Returned</span>
                            ) : (
                              <Button variant="ghost" size="sm" onClick={() => openReturn(r)}>
                                Mark Returned
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={isAddItemOpen}
        onClose={() => {
          setIsAddItemOpen(false);
          setAddForm(emptyAddItem);
        }}
        title="Add Inventory Item"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleAddItem}>
          <div>
            <label className="block text-sm text-slate-700 mb-2">Kind *</label>
            <div className="flex gap-3">
              {(["weapon", "uniform"] as const).map((k) => (
                <label
                  key={k}
                  className={`flex-1 flex items-center gap-2 px-4 py-2 border rounded-md cursor-pointer text-sm capitalize ${
                    addForm.kind === k
                      ? "border-slate-900 bg-slate-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="add-kind"
                    value={k}
                    checked={addForm.kind === k}
                    onChange={() => setAddForm({ ...addForm, kind: k })}
                  />
                  <span>{k}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Item Type *</label>
            <input
              required
              type="text"
              value={addForm.item_type}
              onChange={(e) => setAddForm({ ...addForm, item_type: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder={addForm.kind === "weapon" ? "e.g., Glock 17" : "e.g., Security Guard Uniform"}
            />
          </div>

          {addForm.kind === "weapon" ? (
            <>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Serial Number</label>
                <input
                  type="text"
                  value={addForm.serial_number}
                  onChange={(e) => setAddForm({ ...addForm, serial_number: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="GL-001-2024"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">License Expiry</label>
                <input
                  type="date"
                  value={addForm.license_expiry}
                  onChange={(e) => setAddForm({ ...addForm, license_expiry: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Size</label>
                  <input
                    type="text"
                    value={addForm.size}
                    onChange={(e) => setAddForm({ ...addForm, size: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                    placeholder="S / M / L / 42"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Quantity *</label>
                  <input
                    required
                    type="number"
                    min="0"
                    value={addForm.quantity}
                    onChange={(e) => setAddForm({ ...addForm, quantity: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                </div>
              </div>
            </>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Location</label>
              <select
                value={addForm.location_id}
                onChange={(e) => setAddForm({ ...addForm, location_id: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">Select location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              {locations.length === 0 && (
                <p className="text-xs text-slate-500 mt-1">
                  No locations yet. Add them from Settings â†’ Location Management.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Branch</label>
              <select
                value={addForm.branch_id}
                onChange={(e) => setAddForm({ ...addForm, branch_id: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">Head Office (default)</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea
              value={addForm.notes}
              onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
              rows={2}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="Optional notes"
            />
          </div>

          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={addSubmitting}>
              {addSubmitting ? "Savingâ€¦" : "Add Item"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsAddItemOpen(false);
                setAddForm(emptyAddItem);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isIssueOpen}
        onClose={() => {
          setIsIssueOpen(false);
          setIssueForm(emptyIssueForm());
        }}
        title="Issue Item"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleIssue}>
          <div>
            <label className="block text-sm text-slate-700 mb-2">Item Type *</label>
            <div className="flex gap-3">
              {(["weapon", "uniform"] as const).map((k) => (
                <label
                  key={k}
                  className={`flex-1 flex items-center gap-2 px-4 py-2 border rounded-md cursor-pointer text-sm capitalize ${
                    issueForm.kind === k
                      ? "border-slate-900 bg-slate-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="issue-kind"
                    value={k}
                    checked={issueForm.kind === k}
                    onChange={() => setIssueForm({ ...issueForm, kind: k, item_id: "" })}
                  />
                  <span>{k}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Select Item *</label>
            <select
              required
              value={issueForm.item_id}
              onChange={(e) => setIssueForm({ ...issueForm, item_id: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            >
              <option value="">Select item</option>
              {issuableItems.map((i) => {
                const activeNote =
                  i.kind === "weapon" && (i.active_issuance_count ?? 0) === 1 ? " Â· 1 active" : "";
                const label =
                  i.kind === "weapon"
                    ? `${i.item_type}${i.serial_number ? ` (${i.serial_number})` : ""}${i.location_name ? ` Â· ${i.location_name}` : ""}${activeNote}`
                    : `${i.item_type}${i.size ? ` (${i.size})` : ""} Â· ${i.quantity} in stock${i.location_name ? ` Â· ${i.location_name}` : ""}`;
                return (
                  <option key={i.id} value={i.id}>
                    {label}
                  </option>
                );
              })}
            </select>
            {issuableItems.length === 0 && (
              <p className="text-xs text-slate-500 mt-1">
                No {issueForm.kind === "weapon" ? "issuable weapons" : "uniforms in stock"}.
              </p>
            )}
            {issueForm.kind === "weapon" && (
              <p className="text-xs text-slate-500 mt-1">
                Weapons can be issued to at most 2 employees, and those employees must be on alternate shifts.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-2">Issue To *</label>
            <div className="flex gap-3">
              {(["employee", "client"] as const).map((t) => (
                <label
                  key={t}
                  className={`flex-1 flex items-center gap-2 px-4 py-2 border rounded-md cursor-pointer text-sm capitalize ${
                    issueForm.target === t
                      ? "border-slate-900 bg-slate-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="issue-target"
                    value={t}
                    checked={issueForm.target === t}
                    onChange={() =>
                      setIssueForm({ ...issueForm, target: t, employee_id: "", client_id: "" })
                    }
                  />
                  <span>{t}</span>
                </label>
              ))}
            </div>
          </div>

          {issueForm.target === "employee" ? (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Employee *</label>
              <select
                required
                value={issueForm.employee_id}
                onChange={(e) => {
                  const id = e.target.value;
                  const emp = employees.find((x) => x.id === id);
                  setIssueForm({
                    ...issueForm,
                    employee_id: id,
                    branch_id: emp?.branch_id ?? issueForm.branch_id,
                  });
                }}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">Select employee</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.full_name} ({e.employee_code}) Â· {e.shift}
                  </option>
                ))}
              </select>
              {employees.length === 0 && (
                <p className="text-xs text-slate-500 mt-1">
                  No employees yet. Add them from Employees.
                </p>
              )}
            </div>
          ) : (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Client *</label>
              <select
                required
                value={issueForm.client_id}
                onChange={(e) => {
                  const id = e.target.value;
                  const cli = clients.find((c) => c.id === id);
                  setIssueForm({
                    ...issueForm,
                    client_id: id,
                    branch_id: cli?.branch_id ?? issueForm.branch_id,
                  });
                }}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">Select client</option>
                {clients
                  .filter((c) => c.client_type === "security_services")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.client_code})
                    </option>
                  ))}
              </select>
              {clients.filter((c) => c.client_type === "security_services").length === 0 && (
                <p className="text-xs text-slate-500 mt-1">
                  No Security Services clients yet. Add them from Settings.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm text-slate-700 mb-1">Branch</label>
            <select
              value={issueForm.branch_id}
              onChange={(e) => setIssueForm({ ...issueForm, branch_id: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            >
              <option value="">Auto (from {issueForm.target})</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1">
              Defaults to the {issueForm.target}'s branch. Override here if needed.
            </p>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Issue Date *</label>
            <input
              required
              type="date"
              value={issueForm.issue_date}
              onChange={(e) => setIssueForm({ ...issueForm, issue_date: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea
              value={issueForm.notes}
              onChange={(e) => setIssueForm({ ...issueForm, notes: e.target.value })}
              rows={2}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="Optional notes about this issuance"
            />
          </div>

          <div className="flex items-center gap-3 pt-4">
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              disabled={
                issueSubmitting ||
                issuableItems.length === 0 ||
                (issueForm.target === "employee" && employees.length === 0) ||
                (issueForm.target === "client" && clients.filter((c) => c.client_type === "security_services").length === 0)
              }
            >
              {issueSubmitting ? "Issuingâ€¦" : "Issue Item"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsIssueOpen(false);
                setIssueForm(emptyIssueForm());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={viewWeapon !== null}
        onClose={() => setViewWeapon(null)}
        title="Weapon Details"
        size="md"
      >
        {viewWeapon && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-slate-500 mb-1">Type</p>
                <p className="text-slate-900">{viewWeapon.item_type}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Serial Number</p>
                <p className="text-slate-900 font-mono">{viewWeapon.serial_number ?? "â€”"}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Status</p>
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                    viewWeapon.status === "Issued"
                      ? "bg-brand-50 text-brand-700"
                      : viewWeapon.status === "Available"
                      ? "bg-success-50 text-success-700"
                      : "bg-warning-50 text-warning-700"
                  }`}
                >
                  {viewWeapon.status}
                </span>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Location</p>
                <p className="text-slate-900">{viewWeapon.location_name ?? "â€”"}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Issued To</p>
                <p className="text-slate-900">{viewWeapon.issued_to_name ?? "â€”"}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">License Expiry</p>
                <p className="text-slate-900">{viewWeapon.license_expiry ?? "â€”"}</p>
              </div>
              <div className="col-span-2">
                <p className="text-slate-500 mb-1">Notes</p>
                <p className="text-slate-900">{viewWeapon.notes ?? "â€”"}</p>
              </div>
            </div>
            <div className="pt-4 border-t border-slate-200">
              <Button variant="secondary" size="md" className="w-full" onClick={() => setViewWeapon(null)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={stockItem !== null}
        onClose={() => setStockItem(null)}
        title="Manage Stock"
        size="md"
      >
        {stockItem && (
          <form className="space-y-4" onSubmit={handleStockUpdate}>
            <p className="text-sm text-slate-900">
              {stockItem.item_type}
              {stockItem.size ? ` â€” Size ${stockItem.size}` : ""}
            </p>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Quantity</label>
              <input
                type="number"
                min="0"
                value={stockQty}
                onChange={(e) => setStockQty(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
              <p className="text-xs text-slate-500 mt-1">
                Low stock threshold: {LOW_STOCK_THRESHOLD}. Issuing decrements, returning increments automatically.
              </p>
            </div>
            <div className="flex items-center gap-3 pt-4">
              <Button variant="primary" size="md" className="flex-1" disabled={stockSubmitting}>
                {stockSubmitting ? "Savingâ€¦" : "Update Stock"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setStockItem(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        isOpen={returnIssuance !== null}
        onClose={() => setReturnIssuance(null)}
        title="Mark Item as Returned"
        size="md"
      >
        {returnIssuance && (
          <form className="space-y-4" onSubmit={handleReturn}>
            <div>
              <p className="text-sm text-slate-900 mb-1">
                {returnIssuance.target_kind === "client" ? "Client" : "Employee"}: {returnIssuance.target_name}
              </p>
              <p className="text-sm text-slate-600">
                Item: {returnIssuance.item_type}
                {returnIssuance.item_kind === "weapon" && returnIssuance.serial_number
                  ? ` (${returnIssuance.serial_number})`
                  : returnIssuance.size
                  ? ` (${returnIssuance.size})`
                  : ""}
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Return Date *</label>
              <input
                required
                type="date"
                value={returnForm.return_date}
                onChange={(e) => setReturnForm({ ...returnForm, return_date: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Condition *</label>
              <select
                value={returnForm.condition}
                onChange={(e) =>
                  setReturnForm({ ...returnForm, condition: e.target.value as ReturnCondition })
                }
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="Good">Good</option>
                <option value="Fair">Fair</option>
                <option value="Damaged">Damaged</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Notes</label>
              <textarea
                value={returnForm.notes}
                onChange={(e) => setReturnForm({ ...returnForm, notes: e.target.value })}
                rows={3}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                placeholder="Any notes about the return"
              />
            </div>
            <div className="flex items-center gap-3 pt-4">
              <Button variant="primary" size="md" className="flex-1" disabled={returnSubmitting}>
                {returnSubmitting ? "Savingâ€¦" : "Mark as Returned"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setReturnIssuance(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

function SummaryCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "blue" | "purple" | "green";
}) {
  const colour =
    accent === "blue"
      ? "text-brand-700"
      : accent === "purple"
      ? "text-purple-700"
      : accent === "green"
      ? "text-success-700"
      : "text-slate-900";
  return (
    <div className="text-center flex flex-col items-center">
      <p className="text-xs text-slate-500 mb-1 min-h-[2rem] leading-4 flex items-end justify-center">
        {label}
      </p>
      <p className={`text-2xl ${colour}`}>{value}</p>
    </div>
  );
}
