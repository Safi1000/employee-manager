// ── Assignments & Pay ────────────────────────────────────────────────────────
// The single home for an employee's POSTING and PAY data — the fields that used
// to be buried in the Add/Edit Employee modals (location, branch, category,
// client, department, shift, salary, allowance, joining date).
//
// Why it exists: those fields are almost always changed for a whole client at
// once (a 10% raise across 50 guards, a branch move, a department rename), and
// doing that one modal at a time is the single most repetitive job in the app.
// So employees are grouped under their client — the same mental model as
// Attendance — and every field is editable for one guard or for the whole group.
//
// Absorbed the old Operations ▸ Deployment page: the contracted-vs-enrolled
// reconciliation belongs on the same screen as the guards it counts, so each
// client's card carries its own Sites / Contracted / Enrolled / Variance figures
// and the totals sit above the list.
//
// Salary is never overwritten in place: a change goes through set_employee_salary
// with an effective date + reason, which writes employee_salary_history and only
// touches the live row when the change is already in effect. Past months keep
// the pay they were actually run on.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Users,
  Search,
  Loader2,
  AlertCircle,
  X,
  ChevronRight,
  Building2,
  UserPlus,
  ArrowLeftRight,
  CheckCircle2,
  MapPin,
  AlertTriangle,
  SlidersHorizontal,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import { formatDate } from "../../lib/date";
import { useRegion, withRegion } from "../../lib/region";
import { isSeparatedState, lifecycleStatusLabel } from "../../lib/employmentWindow";
import { hasPermission, useAuth } from "../../lib/auth";
import {
  supabase,
  type Employee,
  type Client,
  type Branch,
  type Location,
  type Contract,
  type ContractLine,
  type ContractAddendum,
  type ContractLineCategory,
  type EmployeeCategory,
  CONTRACT_LINE_CATEGORY_LABEL,
  PERSONNEL_LINE_CATEGORIES,
  effectiveCommittedByCategory,
  effectiveCommittedForLine,
  activeCountByLine,
  isPersonnelCategory,
} from "../../lib/supabase";
import {
  ChangeClientModal,
  ChangeCategoryModal,
  ChangeShiftModal,
  SalaryHistoryPanel,
  type EmployeeRow,
} from "./EmployeeManagement";

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysInCurrentMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};
const perDayOf = (base: number | null | undefined) =>
  base == null ? null : Math.round(Number(base) / daysInCurrentMonth());
const money = (n: number | null | undefined) =>
  n == null ? "—" : `PKR ${Math.round(Number(n)).toLocaleString()}`;

const CATEGORY_LABEL: Record<EmployeeCategory, string> = {
  client: "Client",
  office_staff: "Office Staff",
  reliever: "Reliever",
};

/**
 * Per-client contracted-vs-enrolled snapshot, from v_client_strength_reconciliation.
 * Variance = contracted − enrolled(active): positive = understaffed (amber),
 * negative = over-enrolled (red), zero = on strength (green).
 */
type ReconRow = {
  client_id: string;
  client_name: string;
  site_count: number;
  contracted_billed_qty: number;
  required_on_ground: number;
  enrolled_active: number;
  enrolled_total: number;
  variance: number;
};

const varianceBadge = (v: number) => {
  if (v === 0) return "bg-success-50 text-success-700 dark:text-success-500 border-success-200";
  if (v < 0) return "bg-danger-50 text-danger-700 dark:text-danger-500 border-danger-200";
  return "bg-warning-50 text-warning-800 dark:text-warning-500 border-warning-200";
};

/**
 * Where an "Assign employees" click is sending people.
 *
 * A client posting always names a SITE. The button used to sit on the client
 * card, which meant the modal had to guess — it fell back to the client's
 * default site, so a guard hired for site B silently landed on site A. The
 * button now lives on the site row and carries the site with it.
 */
type AssignTarget =
  | { kind: "client"; id: string; name: string; siteId: string | null; siteName: string | null }
  /**
   * Office Staff and Relievers hold no client posting, so they name no site.
   * Office Staff do have a place, though — their REGION — and it is carried
   * here so posting someone to "Lahore" actually moves them there rather than
   * dropping them into the category with no location at all.
   */
  | {
      kind: "category";
      category: "office_staff" | "reliever";
      name: string;
      branchId?: string | null;
      branchName?: string | null;
    };

/** A group of employees shown as one collapsible card. */
type Group = {
  key: string;
  label: string;
  /** Set for a real client group; null for the category buckets. */
  clientId: string | null;
  /** Set for the Office Staff / Relievers buckets — what assigning here means. */
  categoryKey?: "office_staff" | "reliever";
  hint: string;
  rows: EmployeeRow[];
  /**
   * The client's sites, each with the people posted there. Present only for
   * clients that actually have sites — one without keeps the flat table.
   */
  siteBuckets?: SiteBucket[];
  /** Only set for client groups that appear in the reconciliation view. */
  recon?: ReconRow;
  /** What is missing on this client, if anything — drives the warning tag. */
  gap?: "contract" | "employees";
};

/** One site inside a client card, and who is posted to it. */
type SiteBucket = {
  /** Site id, or "" for people whose posting names no site. */
  id: string;
  name: string;
  rows: EmployeeRow[];
};

/** What an "Edit rules" click is editing: one site, or a whole siteless group. */
type RulesTarget = {
  /** The group the rows and the selection came from. */
  group: Group;
  /** Site id, "" for the No-site bucket, null when the group has no sites. */
  siteId: string | null;
  siteName: string | null;
  rows: EmployeeRow[];
};

// ── Edit rules shape ─────────────────────────────────────────────────────────
type PayMode = "none" | "percent" | "flat" | "set";
/** How pay is decided: one figure for a whole post, or person by person. */
type RulesMode = "fixed" | "variable";
/** The pay rule set against one post in Fixed mode. */
type PostRule = {
  baseMode: PayMode;
  baseValue: string;
  allowanceMode: PayMode;
  allowanceValue: string;
};
const emptyRule = (): PostRule => ({
  baseMode: "none",
  baseValue: "",
  allowanceMode: "none",
  allowanceValue: "",
});
type OtherState = {
  effectiveDate: string;
  reason: string;
  setLocation: boolean;
  locationId: string;
  setBranch: boolean;
  branchId: string;
  setJoinDate: boolean;
  joinDate: string;
};
const emptyOther = (): OtherState => ({
  effectiveDate: todayIso(),
  reason: "Increment",
  setLocation: false,
  locationId: "",
  setBranch: false,
  branchId: "",
  setJoinDate: false,
  joinDate: "",
});

/** Apply a pay mode to a current figure. Returns null when nothing changes. */
function applyPayMode(mode: PayMode, raw: string, current: number | null): number | null {
  if (mode === "none") return null;
  const v = Number(raw);
  if (raw === "" || isNaN(v)) return null;
  if (mode === "set") return Math.max(0, Math.round(v));
  const base = current ?? 0;
  if (mode === "percent") return Math.max(0, Math.round(base * (1 + v / 100)));
  return Math.max(0, Math.round(base + v));
}

export default function EmployeeAssignments() {
  const { profile } = useAuth();
  const { regionId } = useRegion();
  const canEdit = hasPermission(profile, "employees.edit");

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [contractLines, setContractLines] = useState<ContractLine[]>([]);
  const [addendums, setAddendums] = useState<ContractAddendum[]>([]);
  const [recon, setRecon] = useState<ReconRow[]>([]);
  const [sites, setSites] = useState<{ id: string; client_id: string; name: string }[]>([]);
  /** guard_id -> site_id of their open posting. The employee row does not know. */
  const [siteByGuard, setSiteByGuard] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  // Show separated staff instead of active ones. Off by default.
  const [showFired, setShowFired] = useState(false);
  const [onlyMismatch, setOnlyMismatch] = useState(false);
  const [showServicesClients, setShowServicesClients] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Expanded site rows inside a client card, keyed `${groupKey}|${siteId}`. */
  const [openSites, setOpenSites] = useState<Set<string>>(new Set());
  const toggleSite = (k: string) =>
    setOpenSites((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  /** Selected employee ids, keyed by group so a bulk edit can't leak across clients. */
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});

  const [rulesTarget, setRulesTarget] = useState<RulesTarget | null>(null);
  const [rowTarget, setRowTarget] = useState<EmployeeRow | null>(null);
  const [assignTo, setAssignTo] = useState<AssignTarget | null>(null);
  const [transferTarget, setTransferTarget] = useState<EmployeeRow | null>(null);
  const [changeClientTarget, setChangeClientTarget] = useState<EmployeeRow | null>(null);
  const [changeCategoryTarget, setChangeCategoryTarget] = useState<EmployeeRow | null>(null);
  const [changeShiftTarget, setChangeShiftTarget] = useState<EmployeeRow | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [locRes, cliRes, brRes, empRes, ebRes, conRes, clRes, adRes, recRes, siteRes, depRes] = await Promise.all([
      supabase.from("locations").select("*").order("name"),
      // Clients carry a branch, and a branch IS the region — so the region
      // selector has to narrow them too. Filtering only the employees below left
      // an out-of-region client rendering as a card with zero people, which reads
      // as "this client's guards have vanished" rather than "you are looking at
      // another region". A client with no branch set belongs to no region and
      // stays visible everywhere, so the filter can never hide it completely.
      regionId
        ? supabase
            .from("clients")
            .select("*")
            .or(`branch_id.eq.${regionId},branch_id.is.null`)
            .order("name")
        : supabase.from("clients").select("*").order("name"),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
      withRegion(
        supabase
          .from("employees")
          .select("*, location:location_id(name), client:client_id(name), branch:branch_id(name)")
          .order("full_name"),
        regionId,
      ),
      supabase.from("employee_branches").select("employee_id, branch_id"),
      supabase.from("contracts").select("*").order("start_date", { ascending: false }),
      supabase.from("contract_lines").select("*"),
      supabase.from("contract_addendums").select("*"),
      supabase.from("v_client_strength_reconciliation").select("*").order("client_name"),
      supabase.from("sites").select("id, client_id, name").order("name"),
      supabase
        .from("deployments")
        .select("guard_id, site_id")
        .is("end_date", null)
        .range(0, 9999),
    ]);
    const firstErr = [locRes, cliRes, brRes, empRes].find((r) => r.error)?.error;
    if (firstErr) setError(firstErr.message);
    setLocations(locRes.data ?? []);
    setClients(cliRes.data ?? []);
    setBranches(brRes.data ?? []);
    setContracts((conRes.data ?? []) as Contract[]);
    setContractLines((clRes.data ?? []) as ContractLine[]);
    setAddendums((adRes.data ?? []) as ContractAddendum[]);
    setRecon((recRes.data ?? []) as ReconRow[]);
    setSites((siteRes.data ?? []) as { id: string; client_id: string; name: string }[]);
    const guardSite = new Map<string, string>();
    for (const d of (depRes.data ?? []) as { guard_id: string; site_id: string | null }[]) {
      if (d.site_id) guardSite.set(d.guard_id, d.site_id);
    }
    setSiteByGuard(guardSite);
    const addl = new Map<string, string[]>();
    for (const r of (ebRes.data ?? []) as { employee_id: string; branch_id: string }[]) {
      const arr = addl.get(r.employee_id) ?? [];
      arr.push(r.branch_id);
      addl.set(r.employee_id, arr);
    }
    setEmployees(
      (empRes.data ?? []).map((e: any) => ({
        ...e,
        location_name: e.location?.name ?? null,
        client_name: e.client?.name ?? null,
        branch_name: e.branch?.name ?? null,
        additional_branch_ids: addl.get(e.id) ?? [],
        doc_count: 0,
      })) as EmployeeRow[],
    );
    setLoading(false);
  }, [regionId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Keep the row-edit modal pointed at fresh data after a save.
  useEffect(() => {
    if (!rowTarget) return;
    const fresh = employees.find((e) => e.id === rowTarget.id);
    if (fresh && fresh !== rowTarget) setRowTarget(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees]);

  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);

  // A "Services" contract bills for hardware (weapons / equipment), not people, so
  // a client whose contracts are ALL Services has no headcount to assign. They are
  // also junk in the strength reconciliation, which sums contract_lines.billed_qty
  // without caring whether the line counts guards or rifles — a 40-weapon contract
  // reads as "40 contracted, 0 enrolled, +40 short". Hidden from this page.
  // A client with no contracts at all stays visible: absence of evidence isn't
  // evidence that they have no guards.
  const servicesOnlyClientIds = useMemo(() => {
    const seen = new Map<string, boolean>();
    for (const c of contracts) {
      const isServices = c.contract_type === "services";
      seen.set(c.client_id, (seen.get(c.client_id) ?? true) && isServices);
    }
    return new Set([...seen].filter(([, only]) => only).map(([id]) => id));
  }, [contracts]);
  /**
   * Clients with at least one contract that is live TODAY. "Live" means status
   * active and the date window still open — an is_infinite contract never
   * expires, otherwise end_date must not be in the past. A client whose only
   * contract lapsed has nothing to staff against, which is why an expired
   * contract counts the same as no contract at all.
   */
  const clientsWithLiveContract = useMemo(() => {
    const today = todayIso();
    const out = new Set<string>();
    for (const k of contracts) {
      if (k.status !== "active") continue;
      if (k.start_date && k.start_date > today) continue;
      if (!k.is_infinite && k.end_date && k.end_date < today) continue;
      out.add(k.client_id);
    }
    return out;
  }, [contracts]);

  // A line's own label if it carries one, else its category name — the role the
  // employee is contracted as. This replaces the free-text department field.
  const lineLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of contractLines) {
      m.set(l.id, (l.label ?? "").trim() || CONTRACT_LINE_CATEGORY_LABEL[l.category]);
    }
    return m;
  }, [contractLines]);
  /**
   * The single personnel category a client's active contracts commit to, where
   * there is exactly one. Most guards are posted to a client without ever being
   * pinned to a contract line — 328 of 497 in one company — so the Department
   * column read blank for whole clients. When the contract commits to only one
   * kind of person, every unpinned guard on it is unambiguously that kind.
   * With two or more categories there is nothing to infer from, so it stays blank
   * rather than guessing.
   */
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
      for (const l of linesByContract.get(k.id) ?? []) {
        if (isPersonnelCategory(l.category)) cats.add(l.category);
      }
      if (cats.size === 0) continue;
      const prev = byClient.get(k.client_id);
      const only = cats.size === 1 ? [...cats][0] : null;
      // Another contract already disagreed, or this one is mixed -> ambiguous.
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

  const contractsForClient = useCallback(
    (clientId: string) => contracts.filter((c) => c.client_id === clientId),
    [contracts],
  );
  const linesForContract = useCallback(
    (contractId: string) => contractLines.filter((l) => l.contract_id === contractId),
    [contractLines],
  );
  /**
   * Is this line still a post anybody can be assigned to?
   *
   * A line can bill for a site without committing any headcount to it — AWT's
   * contract carries Guard(day) and Guard(night) at 0 committed alongside a
   * contract-wide Guard line at 4. Offering the two empty ones as choices asks
   * the user to post a guard into a slot the contract says does not exist.
   */
  const lineIsOpen = useCallback(
    (l: ContractLine, onDate: string) =>
      effectiveCommittedForLine(
        l,
        addendums.filter((a) => a.contract_id === l.contract_id),
        onDate,
      ) > 0,
    [addendums],
  );

  /**
   * Committed vs filled for THIS LINE — the post itself, not its category.
   *
   * It used to roll the whole contract's category together, which is meaningless
   * on a multi-site contract: Nova bills four sites off one contract, so every
   * Charsadda post quoted the group total. Charsadda's Supervisor (1 committed,
   * nobody pinned) read "35/3 filled" — 3 being every Nova site's supervisor
   * lines added up, 35 being every Nova employee sitting on any of them.
   *
   * A line already carries its own site and shift, so counting the line answers
   * the question the picker is actually asking: how many does this post want,
   * and how many stand in it.
   */
  const filledToday = useMemo(() => activeCountByLine(employees, todayIso()), [employees]);
  const slotForLine = useCallback(
    (line: ContractLine, onDate: string) => {
      const adds = addendums.filter((a) => a.contract_id === line.contract_id);
      const committed = effectiveCommittedForLine(line, adds, onDate);
      const filled =
        onDate === todayIso()
          ? filledToday.get(line.id) ?? 0
          : activeCountByLine(employees, onDate).get(line.id) ?? 0;
      return { committed, filled };
    },
    [addendums, employees, filledToday],
  );

  /**
   * The personnel posts a SITE is staffed with — what "Edit rules" reads to know
   * which roles to offer.
   *
   * A line that names this site obviously belongs to it. A line with no site is
   * contract-wide, so it belongs to every site of the client: most single-site
   * clients never bother setting site_id (30 of 77 personnel lines company-wide),
   * and dropping those would leave their only site showing no posts at all.
   * Scoping stays honest because the PEOPLE are always taken from the site
   * bucket — a contract-wide Supervisor line edited at site A only ever touches
   * the supervisors standing at site A.
   *
   * siteId "" is the "No site recorded" bucket: those postings name no site, so
   * they could belong to any line the client has.
   */
  const personnelLinesForSite = useCallback(
    (clientId: string, siteId: string) => {
      const activeIds = new Set(
        contracts.filter((c) => c.client_id === clientId && c.status === "active").map((c) => c.id),
      );
      return contractLines.filter(
        (l) =>
          activeIds.has(l.contract_id) &&
          isPersonnelCategory(l.category) &&
          (siteId === "" || l.site_id === siteId || l.site_id === null),
      );
    },
    [contracts, contractLines],
  );
  const displayCodeFor = useCallback(
    (e: Pick<Employee, "client_id" | "display_number" | "guard_code" | "employee_code">) => {
      const fallback = e.guard_code ?? e.employee_code;
      if (e.display_number == null || !e.client_id) return fallback;
      const prefix = clientById.get(e.client_id)?.employee_id_prefix;
      return prefix ? `${prefix}-${String(e.display_number).padStart(3, "0")}` : fallback;
    },
    [clientById],
  );

  // Committed PERSONNEL headcount per client, across their active contracts.
  const committedPersonnelByClient = useMemo(() => {
    const byClient = new Map<string, number>();
    const linesByContract = new Map<string, ContractLine[]>();
    for (const l of contractLines) {
      const arr = linesByContract.get(l.contract_id) ?? [];
      arr.push(l);
      linesByContract.set(l.contract_id, arr);
    }
    for (const k of contracts) {
      if (k.status !== "active" || k.contract_type !== "guard_deployment") continue;
      const lines = linesByContract.get(k.id) ?? [];
      if (lines.length === 0) continue;
      const adds = addendums.filter((a) => a.contract_id === k.id);
      const committed = effectiveCommittedByCategory(lines, adds, todayIso());
      let total = 0;
      for (const [cat, n] of committed) if (isPersonnelCategory(cat)) total += n;
      byClient.set(k.client_id, (byClient.get(k.client_id) ?? 0) + total);
    }
    return byClient;
  }, [contracts, contractLines, addendums]);

  // Committed personnel headcount per SITE — the "required" side of each site
  // row's assigned/required badge. Mirrors committedPersonnelByClient but scoped
  // to the lines that name the site (a line with no site_id is contract-wide and
  // belongs to no single site, so it is not counted here).
  const requiredBySite = useMemo(() => {
    const bySite = new Map<string, number>();
    const activeIds = new Set(
      contracts
        .filter((c) => c.status === "active" && c.contract_type === "guard_deployment")
        .map((c) => c.id),
    );
    for (const l of contractLines) {
      if (!l.site_id || !activeIds.has(l.contract_id) || !isPersonnelCategory(l.category)) continue;
      const adds = addendums.filter((a) => a.contract_id === l.contract_id);
      bySite.set(l.site_id, (bySite.get(l.site_id) ?? 0) + effectiveCommittedForLine(l, adds, todayIso()));
    }
    return bySite;
  }, [contracts, contractLines, addendums]);

  // ── Grouping: one card per client, then the category / unassigned buckets ──
  const groups = useMemo<Group[]>(() => {
    // Search narrows the CLIENT list, not the people inside it — this page is
    // organised by client, so filtering rows away left half-empty cards that
    // misrepresented a client's headcount.
    const q = search.trim().toLowerCase();
    // Separated staff are off this page by default — it is a deployment screen,
    // and a fired guard holds no post. The Fired toggle swaps to showing ONLY
    // them, still grouped under the client and site they left from, so "who did
    // we lose at this site, and when" is answerable without leaving the page.
    const visible = employees.filter((e) =>
      showFired
        ? isSeparatedState(e.lifecycle_state)
        : !isSeparatedState(e.lifecycle_state),
    );

    const byClient = new Map<string, EmployeeRow[]>();
    const office: EmployeeRow[] = [];
    const relievers: EmployeeRow[] = [];
    for (const e of visible) {
      const cat = (e.category ?? "client") as EmployeeCategory;
      if (cat === "office_staff") office.push(e);
      else if (cat === "reliever") relievers.push(e);
      else if (e.client_id) {
        const arr = byClient.get(e.client_id) ?? [];
        arr.push(e);
        byClient.set(e.client_id, arr);
      }
      // Employees with no client posting aren't a group — they're the candidate
      // pool behind each client's "Assign employees" button.
    }

    // EVERY client gets a card, staffed or not. Building the list from employees
    // alone was a chicken-and-egg trap: "Assign employees" lives on a client card,
    // so a client nobody is posted to yet never rendered one and could never be
    // staffed — a brand-new org showed a completely empty page.
    // v_client_strength_reconciliation derives "contracted" by joining
    // contract_lines through SITES and summing billed_qty. Lines that carry no
    // site_id — or no billed_qty — contribute nothing, so a fully staffed client
    // read 70 enrolled against 0 contracted and a variance of -70. Recompute
    // committed from the contract lines themselves (personnel only, addendums
    // applied), which is the same arithmetic the Contracts page uses.
    const reconByClient = new Map(
      recon.map((r) => {
        const committed = committedPersonnelByClient.get(r.client_id) ?? 0;
        if (committed === 0) return [r.client_id, r] as const;
        return [
          r.client_id,
          {
            ...r,
            contracted_billed_qty: committed,
            required_on_ground: r.required_on_ground || committed,
            variance: committed - r.enrolled_active,
          },
        ] as const;
      }),
    );
    const sitesByClient = new Map<string, { id: string; name: string }[]>();
    for (const st of sites) {
      const arr = sitesByClient.get(st.client_id) ?? [];
      arr.push({ id: st.id, name: st.name });
      sitesByClient.set(st.client_id, arr);
    }

    const out: Group[] = clients.map((c) => {
      const rows = byClient.get(c.id) ?? [];
      const clientSites = sitesByClient.get(c.id) ?? [];
      let siteBuckets: SiteBucket[] | undefined;
      if (clientSites.length > 0) {
        const bySite = new Map<string, EmployeeRow[]>();
        for (const e of rows) {
          const sid = siteByGuard.get(e.id) ?? "";
          const arr = bySite.get(sid) ?? [];
          arr.push(e);
          bySite.set(sid, arr);
        }
        siteBuckets = clientSites.map((st) => ({
          id: st.id,
          name: st.name,
          rows: bySite.get(st.id) ?? [],
        }));
        // Anyone whose posting names no site would otherwise vanish from the card.
        const orphans = bySite.get("") ?? [];
        if (orphans.length) siteBuckets.push({ id: "", name: "No site recorded", rows: orphans });
      }
      // A client is worth a card when it has a live contract, people on it, or
      // both. Missing exactly one of the two is a problem to fix, so the card
      // stays and says which. Missing BOTH means there is nothing here at all —
      // no obligation and nobody to pay — so it is dropped below.
      const hasContract = clientsWithLiveContract.has(c.id);
      const hasPeople = rows.length > 0;
      return {
        key: `client:${c.id}`,
        label: c.name,
        clientId: c.id,
        hint: c.employee_id_prefix ? `Prefix ${c.employee_id_prefix}` : "",
        rows,
        siteBuckets,
        recon: reconByClient.get(c.id),
        gap: hasContract && hasPeople ? undefined : hasContract ? "employees" : "contract",
      };
    });
    out.sort((a, b) => a.label.localeCompare(b.label));

    // Always present, empty or not: they are assignment targets in their own
    // right, so hiding them when nobody is in them would leave no way to put the
    // first person there.
    // Office Staff get a site level too, and their site is the REGION. They
    // hold no client posting, so there is no deployment row to read a site off
    // — employees.branch_id is the place they actually sit, and migration 0175
    // guarantees it is populated (head office by default). The bucket list is
    // built from every region, not just the occupied ones, so "Assign
    // employees" is reachable for a region nobody is in yet.
    let officeBuckets: SiteBucket[] | undefined;
    if (branches.length > 0) {
      const byBranch = new Map<string, EmployeeRow[]>();
      for (const e of office) {
        const bid = e.branch_id ?? "";
        const arr = byBranch.get(bid) ?? [];
        arr.push(e);
        byBranch.set(bid, arr);
      }
      officeBuckets = branches.map((b) => ({
        id: b.id,
        name: b.name,
        rows: byBranch.get(b.id) ?? [],
      }));
      const unplaced = byBranch.get("") ?? [];
      if (unplaced.length) officeBuckets.push({ id: "", name: "No region recorded", rows: unplaced });
    }
    out.push({
      key: "office", label: "Office Staff", clientId: null, categoryKey: "office_staff",
      hint: "By region", rows: office, siteBuckets: officeBuckets,
    });
    out.push({
      key: "relievers", label: "Relievers", clientId: null, categoryKey: "reliever",
      hint: "Relief pool", rows: relievers,
    });
    let visibleGroups = showServicesClients
      ? out
      : out.filter((g) => !(g.clientId && servicesOnlyClientIds.has(g.clientId)));
    // Dormant clients — no live contract AND nobody posted — are dropped. There
    // is nothing to do to them here. This is safe precisely because it needs
    // BOTH to be missing: a new client whose contract is entered but not yet
    // staffed still gets a card, so "Assign employees" is always reachable.
    visibleGroups = visibleGroups.filter(
      (g) => !g.clientId || !(g.gap === "contract" && g.rows.length === 0),
    );
    if (q) visibleGroups = visibleGroups.filter((g) => g.label.toLowerCase().includes(q));
    if (onlyMismatch) return visibleGroups.filter((g) => g.recon != null && g.recon.variance !== 0);
    return visibleGroups;
  }, [employees, clients, sites, branches, siteByGuard, search, recon, onlyMismatch, servicesOnlyClientIds, showServicesClients, committedPersonnelByClient, clientsWithLiveContract]);

  // Hiding a client must never make its guards unreachable — this page is the only
  // place their posting and pay can be edited. If a Services-only client somehow
  // has people on it, say so and offer a way back in.
  const strandedOnServices = useMemo(
    () =>
      showServicesClients
        ? 0
        : employees.filter(
            (e) =>
              e.client_id &&
              servicesOnlyClientIds.has(e.client_id) &&
              !isSeparatedState(e.lifecycle_state),
          ).length,
    [employees, servicesOnlyClientIds, showServicesClients],
  );

  // Company-wide strength totals — the old Deployment page's stat row.
  const totals = useMemo(
    () =>
      recon
        .filter((r) => showServicesClients || !servicesOnlyClientIds.has(r.client_id))
        .reduce(
        (acc, r) => {
          acc.contracted += r.contracted_billed_qty;
          acc.enrolled += r.enrolled_active;
          acc.sites += r.site_count;
          if (r.variance !== 0) acc.mismatched += 1;
          return acc;
        },
        { contracted: 0, enrolled: 0, sites: 0, mismatched: 0 },
      ),
    [recon, servicesOnlyClientIds, showServicesClients],
  );

  // Genuinely unplaced people only. Office staff and relievers already sit in
  // their own group — they are assigned, just not to a client — so offering them
  // here read as if they were spare. To move one onto a client, change their
  // category first; they then land in this pool.
  const assignable = useMemo(
    () =>
      employees.filter(
        (e) =>
          (e.category ?? "client") === "client" &&
          !e.client_id &&
          !isSeparatedState(e.lifecycle_state),
      ),
    [employees],
  );

  const toggleGroup = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const selectionFor = (key: string) => selected[key] ?? new Set<string>();
  const toggleRow = (key: string, id: string) =>
    setSelected((prev) => {
      const next = new Set(prev[key] ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, [key]: next };
    });
  /**
   * Select/clear the rows currently on screen. Selection stays keyed on the
   * CLIENT group even when the rows come from a single site, so Bulk edit keeps
   * spanning the whole card.
   */
  const toggleRows = (groupKey: string, rows: EmployeeRow[]) =>
    setSelected((prev) => {
      const cur = new Set(prev[groupKey] ?? []);
      const allOn = rows.length > 0 && rows.every((r) => cur.has(r.id));
      for (const r of rows) {
        if (allOn) cur.delete(r.id);
        else cur.add(r.id);
      }
      return { ...prev, [groupKey]: cur };
    });

  /**
   * One employee table, shared by the flat client view and by each site row so
   * the two can never drift apart. `rowsToShow` is the slice being rendered.
   */
  const renderEmployeeTable = (g: Group, rowsToShow: EmployeeRow[]) => {
    const sel = selectionFor(g.key);
    return (
                  <div className="overflow-x-auto border-t border-border">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border bg-slate-50">
                          <th className="px-3 py-2 w-9">
                            <input
                              type="checkbox"
                              checked={rowsToShow.length > 0 && rowsToShow.every((r) => sel.has(r.id))}
                              onChange={() => toggleRows(g.key, rowsToShow)}
                              aria-label={`Select all in ${g.label}`}
                            />
                          </th>
                          {["Code", "Name", "Department", "Shift", "Base", "Per day", "Allowance", showFired ? "Left on" : "Joined"].map((h) => (
                            <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground whitespace-nowrap">
                              {h}
                            </th>
                          ))}
                          <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sticky right-0 z-10 bg-slate-50 border-l border-border">
                            Edit
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rowsToShow.length === 0 && (
                          <tr>
                            <td colSpan={10} className="px-4 py-8 text-center text-sm text-muted-foreground">
                              Nobody is posted here yet — use “Assign employees” above.
                            </td>
                          </tr>
                        )}
                        {rowsToShow.map((e) => (
                          <tr key={e.id} className="group border-b border-border last:border-0 transition-colors hover:bg-accent">
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={sel.has(e.id)}
                                onChange={() => toggleRow(g.key, e.id)}
                                aria-label={`Select ${e.full_name}`}
                              />
                            </td>
                            <td className="px-3 py-2 text-sm font-mono text-foreground whitespace-nowrap">{displayCodeFor(e)}</td>
                            <td className="px-3 py-2 text-sm text-foreground whitespace-nowrap">
                              {e.full_name}
                              {isSeparatedState(e.lifecycle_state) && (
                                <span className="ml-2 text-[10px] uppercase tracking-wide text-danger-700 dark:text-danger-500">
                                  {lifecycleStatusLabel(e)}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">
                              {departmentOf(e) ?? (
                                <span title="Not assigned to a contract line">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-sm text-muted-foreground capitalize whitespace-nowrap">{e.shift}</td>
                            <td className="px-3 py-2 text-sm text-foreground tabular-nums whitespace-nowrap">{money(e.base_salary)}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground tabular-nums whitespace-nowrap">{money(perDayOf(e.base_salary))}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground tabular-nums whitespace-nowrap">{money(e.allowance)}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">
                              {/* In Fired mode this column carries the date they
                                  LEFT, which is the thing being looked up. The
                                  termination date is the day the separation took
                                  effect; last_working_day covers older records
                                  that only ever carried that one. */}
                              {showFired
                                ? formatDate(e.termination_date ?? e.last_working_day ?? e.exit_date) || "—"
                                : e.join_date ? formatDate(e.join_date) : "—"}
                            </td>
                            {/* Sticky column: opaque in every state, or the columns
                                underneath show through while scrolling sideways. */}
                            <td className="px-3 py-2 sticky right-0 z-10 border-l border-border bg-card group-hover:bg-accent transition-colors">
                              <div className="flex gap-1">
                                <Button variant="ghost" size="sm" onClick={() => setRowTarget(e)}>
                                  {canEdit ? "Edit" : "View"}
                                </Button>
                                {canEdit && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    title="Move to another client, or to office staff / relievers"
                                    onClick={() => setTransferTarget(e)}
                                  >
                                    <ArrowLeftRight className="w-3.5 h-3.5 mr-1" strokeWidth={1.75} />
                                    Transfer
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
    );
  };

  const handleExport = () =>
    exportTable({
      fileName: "assignments-and-pay",
      sheetName: "Assignments",
      headers: [
        "Group", "Sites", "Contracted", "On-ground req.", "Enrolled (active)", "Variance",
        "Code", "Name", "Category", "Client", "Location", "Branch",
        "Department", "Shift", "Base Salary", "Per Day", "Allowance", "Joined", "Status",
      ],
      rows: groups.flatMap((g) =>
        g.rows.map((e) => [
          g.label,
          g.recon?.site_count ?? "",
          g.recon?.contracted_billed_qty ?? "",
          g.recon?.required_on_ground ?? "",
          g.recon?.enrolled_active ?? "",
          g.recon?.variance ?? "",
          displayCodeFor(e),
          e.full_name,
          CATEGORY_LABEL[(e.category ?? "client") as EmployeeCategory],
          e.client_name ?? "",
          e.location_name ?? "",
          e.branch_name ?? "",
          departmentOf(e) ?? "",
          e.shift,
          e.base_salary ?? "",
          perDayOf(e.base_salary) ?? "",
          e.allowance ?? "",
          e.join_date ?? "",
          lifecycleStatusLabel(e),
        ]),
      ),
    });

  const totalShown = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <>
      <Header
        title="Assignments & Pay"
        subtitle="Posting, pay and contracted-vs-enrolled strength by client — edit one guard or the whole group"
        actions={<ExportButton onExport={handleExport} label="Export" />}
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}
        {notice && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-success-50 text-success-800 border border-success-200 rounded-md text-sm">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={2} />
            <div className="flex-1">{notice}</div>
            <button onClick={() => setNotice(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        <div className="mb-4 flex flex-wrap gap-2">
          {[
            { label: "Contracted (billed)", value: totals.contracted, icon: Building2, tint: "text-brand-600 dark:text-brand-500" },
            { label: "Enrolled (active)", value: totals.enrolled, icon: Users, tint: "text-success-600 dark:text-success-500" },
            { label: "Sites", value: totals.sites, icon: MapPin, tint: "text-muted-foreground" },
            {
              label: "Clients mismatched",
              value: totals.mismatched,
              icon: AlertCircle,
              tint: totals.mismatched > 0 ? "text-warning-600 dark:text-warning-500" : "text-success-600 dark:text-success-500",
            },
          ].map((t) => {
            const onClick = "onClick" in t ? (t.onClick as (() => void) | undefined) : undefined;
            const body = (
              <>
                <t.icon className={`w-4 h-4 shrink-0 ${t.tint}`} strokeWidth={2} />
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</span>
                <span className="text-base font-semibold tabular-nums text-foreground">{t.value}</span>
              </>
            );
            const cls = "inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-card";
            const title = "hint" in t ? (t.hint as string | undefined) : undefined;
            return onClick ? (
              <button
                key={t.label}
                type="button"
                onClick={onClick}
                title={title}
                className={`${cls} text-left transition-colors hover:border-brand-500/50 hover:bg-accent`}
              >
                {body}
              </button>
            ) : (
              <div key={t.label} title={title} className={cls}>{body}</div>
            );
          })}
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-56">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search clients…"
              className="w-full pl-9 pr-4 py-2 border border-border rounded-md text-sm bg-card"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
            <input
              type="checkbox"
              checked={showFired}
              onChange={(e) => setShowFired(e.target.checked)}
            />
            Fired / left
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
            <input type="checkbox" checked={onlyMismatch} onChange={(e) => setOnlyMismatch(e.target.checked)} />
            Only mismatches
          </label>
          <span className="text-sm text-muted-foreground">
            {groups.length} group{groups.length === 1 ? "" : "s"} · {totalShown} employee{totalShown === 1 ? "" : "s"}
          </span>
        </div>

        {loading && (
          <div className="py-16 text-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
          </div>
        )}

        {!loading && groups.length === 0 && (
          <div className="py-16 text-center text-sm text-muted-foreground">
            No employees match this search.
          </div>
        )}

        {strandedOnServices > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-warning-600" strokeWidth={2} />
            <span className="flex-1">
              {strandedOnServices} employee{strandedOnServices === 1 ? " is" : "s are"} posted to a
              Services-only client, which this page hides. Their contract bills for equipment, not
              people — either move them to a guard-deployment client or{" "}
              <button
                type="button"
                onClick={() => setShowServicesClients(true)}
                className="font-medium underline"
              >
                show Services clients
              </button>{" "}
              to edit them here.
            </span>
          </div>
        )}
        {showServicesClients && (
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <span>Showing Services-only clients — their contracted figures count equipment, not headcount.</span>
            <button
              type="button"
              onClick={() => setShowServicesClients(false)}
              className="font-medium underline"
            >
              Hide again
            </button>
          </div>
        )}

        <p className="mb-3 text-xs text-muted-foreground">
          Variance = contracted − enrolled(active). Positive (amber) = understaffed; negative (red) = over-enrolled.
        </p>

        <div className="space-y-3">
          {groups.map((g) => {
            const open = expanded.has(g.key);
            const sel = selectionFor(g.key);
            const monthly = g.rows.reduce(
              (sum, e) => sum + Number(e.base_salary ?? 0) + Number(e.allowance ?? 0),
              0,
            );
            return (
              <div key={g.key} className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.key)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                    aria-expanded={open}
                  >
                    <ChevronRight
                      className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                      strokeWidth={1.75}
                    />
                    {g.clientId ? (
                      <Building2 className="w-4 h-4 shrink-0 text-brand-600 dark:text-brand-500" strokeWidth={1.5} />
                    ) : (
                      <Users className="w-4 h-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                    )}
                    <span className="font-medium text-foreground truncate">{g.label}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {g.rows.length} employee{g.rows.length === 1 ? "" : "s"}
                    </span>
                    {g.hint && <span className="text-xs text-muted-foreground truncate hidden md:inline">· {g.hint}</span>}
                    {g.gap && (
                      <span
                        className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium bg-warning-50 text-warning-800 dark:text-warning-500 border-warning-200"
                        title={
                          g.gap === "contract"
                            ? "This client has people posted to it but no contract that is live today — either it was never entered, or it has expired."
                            : "This client has a live contract but nobody is posted to it."
                        }
                      >
                        <AlertTriangle className="w-3 h-3" strokeWidth={2} />
                        {g.gap === "contract" ? "No live contract" : "No employees"}
                      </span>
                    )}
                  </button>
                  {g.recon && (
                    <span className="hidden lg:flex items-center gap-3 text-xs text-muted-foreground tabular-nums shrink-0">
                      <span title="Sites">{g.recon.site_count} site{g.recon.site_count === 1 ? "" : "s"}</span>
                      <span title="Contracted (billed) vs enrolled (active)">
                        {g.recon.enrolled_active}/{g.recon.contracted_billed_qty} enrolled
                      </span>
                      <span title="On-ground requirement">req. {g.recon.required_on_ground}</span>
                      <span
                        className={`inline-block px-2 py-0.5 rounded-md border font-medium ${varianceBadge(g.recon.variance)}`}
                        title="Variance = contracted − enrolled(active)"
                      >
                        {g.recon.variance > 0 ? `+${g.recon.variance}` : g.recon.variance}
                      </span>
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">
                    {money(monthly)}/mo
                  </span>
                  {/* Assign / Edit rules live on the SITE row when the group has
                      sites — a posting names a site, and a pay rule reads the
                      posts of one site's contract lines. Only a group with no
                      site level (a siteless client, Office Staff, Relievers)
                      keeps them up here, where the group IS the whole target. */}
                  {canEdit && !g.siteBuckets && (g.clientId || g.categoryKey) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={assignable.length === 0}
                      title={assignable.length === 0 ? "No unassigned employees" : undefined}
                      onClick={() =>
                        setAssignTo(
                          g.clientId
                            ? { kind: "client", id: g.clientId, name: g.label, siteId: null, siteName: null }
                            : { kind: "category", category: g.categoryKey!, name: g.label },
                        )
                      }
                    >
                      <UserPlus className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                      Assign employees
                    </Button>
                  )}
                  {canEdit && !g.siteBuckets && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={g.rows.length === 0}
                      onClick={() => {
                        if (!open) toggleGroup(g.key);
                        setRulesTarget({ group: g, siteId: null, siteName: null, rows: g.rows });
                      }}
                    >
                      <SlidersHorizontal className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                      Edit rules{sel.size > 0 ? ` (${sel.size})` : ""}
                    </Button>
                  )}
                </div>

                {open && (
                  g.siteBuckets ? (
                    /* Client → site → employees. The site level only appears for
                       clients that have sites; a guard's site comes from their
                       open posting, not the employee row. */
                    <div className="border-t border-border">
                      {g.siteBuckets.map((b) => {
                        const sKey = `${g.key}|${b.id}`;
                        const sOpen = openSites.has(sKey);
                        // How many of THIS site's people are ticked — the buttons
                        // must not count a selection made on a sibling site.
                        const sSel = b.rows.filter((r) => sel.has(r.id)).length;
                        return (
                          <div key={sKey} className="border-b border-border last:border-0">
                            <div className="flex items-center gap-2 px-4 py-2.5 hover:bg-accent transition-colors">
                              <button
                                type="button"
                                onClick={() => toggleSite(sKey)}
                                aria-expanded={sOpen}
                                className="flex items-center gap-2 min-w-0 flex-1 text-left"
                              >
                                <ChevronRight
                                  className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${sOpen ? "rotate-90" : ""}`}
                                  strokeWidth={1.75}
                                />
                                <MapPin className="w-4 h-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                <span className="text-sm text-foreground truncate">{b.name}</span>
                                <span
                                  className="text-xs text-muted-foreground shrink-0 tabular-nums"
                                  title={b.id ? "Assigned / required (committed strength) for this site" : undefined}
                                >
                                  {(() => {
                                    if (!b.id) return `${b.rows.length} employee${b.rows.length === 1 ? "" : "s"}`;
                                    // A single-site client keeps its strength on a contract-wide line
                                    // (no site_id), so per-site lines read 0 — fall back to the client's
                                    // own contracted total. Multi-site clients carry per-site strength.
                                    const realSites = g.siteBuckets?.filter((x) => x.id !== "").length ?? 0;
                                    const req =
                                      realSites <= 1
                                        ? g.recon?.contracted_billed_qty ?? requiredBySite.get(b.id) ?? 0
                                        : requiredBySite.get(b.id) ?? 0;
                                    return `${b.rows.length}/${req} assigned`;
                                  })()}
                                </span>
                              </button>
                              {/* The No-site / No-region bucket is not a place:
                                  there is nothing to post someone TO, so it
                                  offers only Edit rules to repair the pay of
                                  whoever landed there. For Office Staff the
                                  bucket is a REGION, so the target carries the
                                  branch instead of a site. */}
                              {canEdit && (g.clientId || g.categoryKey) && b.id !== "" && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={assignable.length === 0}
                                  title={assignable.length === 0 ? "No unassigned employees" : `Post employees to ${b.name}`}
                                  onClick={() =>
                                    setAssignTo(
                                      g.clientId
                                        ? {
                                            kind: "client",
                                            id: g.clientId,
                                            name: g.label,
                                            siteId: b.id,
                                            siteName: b.name,
                                          }
                                        : {
                                            kind: "category",
                                            category: g.categoryKey!,
                                            name: g.label,
                                            branchId: b.id,
                                            branchName: b.name,
                                          },
                                    )
                                  }
                                >
                                  <UserPlus className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                                  Assign employees
                                </Button>
                              )}
                              {canEdit && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={b.rows.length === 0}
                                  title={`Set pay by post for ${b.name}`}
                                  onClick={() => {
                                    if (!sOpen) toggleSite(sKey);
                                    setRulesTarget({ group: g, siteId: b.id, siteName: b.name, rows: b.rows });
                                  }}
                                >
                                  <SlidersHorizontal className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                                  Edit rules{sSel > 0 ? ` (${sSel})` : ""}
                                </Button>
                              )}
                            </div>
                            {sOpen && renderEmployeeTable(g, b.rows)}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    renderEmployeeTable(g, g.rows)
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>

      {rulesTarget && (
        <EditRulesModal
          target={rulesTarget}
          selectedIds={selectionFor(rulesTarget.group.key)}
          lines={
            rulesTarget.group.clientId
              ? personnelLinesForSite(rulesTarget.group.clientId, rulesTarget.siteId ?? "")
              : []
          }
          allLines={contractLines}
          locations={locations}
          branches={branches}
          onClose={() => setRulesTarget(null)}
          onDone={async (msg) => {
            setRulesTarget(null);
            setSelected((prev) => ({ ...prev, [rulesTarget.group.key]: new Set<string>() }));
            setNotice(msg);
            await loadData();
          }}
        />
      )}

      {rowTarget && (
        <RowEditModal
          employee={rowTarget}
          canEdit={canEdit}
          displayCode={displayCodeFor(rowTarget)}
          departmentLabel={departmentOf(rowTarget)}
          lineOptions={
            rowTarget.client_id
              ? // Only the posts at the site this employee actually stands at —
                // a multi-site client's other sites staff their own lines, and
                // offering those here is how someone ends up filed under a post
                // that bills a city they have never been to. A line with no site
                // is contract-wide and belongs to every site.
                (() => {
                  const held = rowTarget.contract_line_id;
                  const atSite = personnelLinesForSite(
                    rowTarget.client_id,
                    siteByGuard.get(rowTarget.id) ?? "",
                  )
                    // Posts with no committed headcount are not choices. The one
                    // they already hold always stays, or saving would silently
                    // move them off a line the contract has since emptied.
                    .filter((l) => l.id === held || lineIsOpen(l, todayIso()));
                  // Whatever they hold today stays on the list even when it
                  // belongs to another site — 58 people are pinned across sites
                  // right now, and dropping their own post would show them as
                  // "Not set" and invite an accidental reassignment.
                  if (held && !atSite.some((l) => l.id === held)) {
                    const elsewhere = contractLines.find((l) => l.id === held);
                    if (elsewhere) return [elsewhere, ...atSite];
                  }
                  return atSite;
                })()
              : []
          }
          siteNoteForLine={(l) => {
            const own = siteByGuard.get(rowTarget.id) ?? "";
            if (!l.site_id || l.site_id === own) return null;
            return sites.find((s) => s.id === l.site_id)?.name ?? "another site";
          }}
          slotForLine={slotForLine}
          clients={clients}
          onClose={() => setRowTarget(null)}
          onSaved={async () => { setRowTarget(null); await loadData(); }}
          onChangeClient={() => { const t = rowTarget; setRowTarget(null); setChangeClientTarget(t); }}
          onChangeCategory={() => { const t = rowTarget; setRowTarget(null); setChangeCategoryTarget(t); }}
          onChangeShift={() => { const t = rowTarget; setRowTarget(null); setChangeShiftTarget(t); }}
          onError={setError}
        />
      )}

      {assignTo && (
        <AssignEmployeesModal
          target={assignTo}
          candidates={assignable}
          contractsForClient={contractsForClient}
          linesForContract={linesForContract}
          addendums={addendums}
          allEmployees={employees}
          onClose={() => setAssignTo(null)}
          onDone={async (msg) => { setAssignTo(null); setNotice(msg); await loadData(); }}
          onError={setError}
        />
      )}

      {transferTarget && (
        <TransferModal
          employee={transferTarget}
          clients={clients}
          displayCode={displayCodeFor(transferTarget)}
          sites={sites}
          currentSiteId={siteByGuard.get(transferTarget.id) ?? ""}
          contractsForClient={contractsForClient}
          linesForContract={linesForContract}
          linesForSite={personnelLinesForSite}
          onClose={() => setTransferTarget(null)}
          onDone={async (msg) => { setTransferTarget(null); setNotice(msg); await loadData(); }}
          onError={setError}
        />
      )}

      {changeClientTarget && (
        <ChangeClientModal
          guard={changeClientTarget}
          clients={clients}
          contractsForClient={contractsForClient}
          linesForContract={linesForContract}
          displayCode={displayCodeFor(changeClientTarget)}
          onClose={() => setChangeClientTarget(null)}
          onDone={async () => { setChangeClientTarget(null); await loadData(); }}
          onError={setError}
        />
      )}
      {changeCategoryTarget && (
        <ChangeCategoryModal
          guard={changeCategoryTarget}
          clients={clients}
          contractsForClient={contractsForClient}
          linesForContract={linesForContract}
          displayCode={displayCodeFor(changeCategoryTarget)}
          onClose={() => setChangeCategoryTarget(null)}
          onDone={async () => { setChangeCategoryTarget(null); await loadData(); }}
          onError={setError}
        />
      )}
      {changeShiftTarget && (
        <ChangeShiftModal
          guard={changeShiftTarget}
          displayCode={displayCodeFor(changeShiftTarget)}
          onClose={() => setChangeShiftTarget(null)}
          onDone={async () => { setChangeShiftTarget(null); await loadData(); }}
          onError={setError}
        />
      )}
    </>
  );
}

/**
 * How a contract line reads in a picker. Shared so the Assign dialog and the
 * Department field on a row offer the identical wording — they are choosing
 * from the same list, and two spellings of one post read as two posts.
 *
 * The shift matters: a site routinely bills the same post twice, once per
 * shift, and without it the options are indistinguishable.
 *
 * `siteNote` names the site when the line belongs to a DIFFERENT one than the
 * list is for. That only happens for a post somebody is already pinned to from
 * elsewhere, which is kept on offer so it can be seen and corrected — and
 * without the name it renders as a second, identical copy of the local post.
 */
const lineOptionLabel = (
  l: ContractLine,
  slot: { filled: number; committed: number } | null,
  siteNote?: string | null,
) =>
  ((l.label ?? "").trim() || CONTRACT_LINE_CATEGORY_LABEL[l.category]) +
  (l.shift_code ? ` (${l.shift_code})` : "") +
  (l.location ? ` — ${l.location}` : "") +
  (siteNote ? ` — at ${siteNote}` : "") +
  (slot ? ` · ${slot.filled}/${slot.committed} filled` : "");

/** One post at the site, and who is currently filling it. */
type PostBucket = {
  key: string;
  label: string;
  /** Null for the catch-all bucket of people pinned to no contract line. */
  category: ContractLineCategory | null;
  rows: EmployeeRow[];
};

const CATEGORY_RANK = new Map(PERSONNEL_LINE_CATEGORIES.map((c, i) => [c, i]));

// ─────────────────────────────────────────────────────────────────────────────
// Edit rules — the reason this page exists. Sets pay for ONE SITE, by the posts
// that site's contract actually commits to.
//
// The old "Bulk edit" applied one figure to a whole client, which is not how a
// contract is priced: a site staffed by supervisors and guards has two rates,
// and flattening them was wrong in every case where a client is more than one
// role. So the modal reads the contract lines that staff this site and offers a
// row per post — a site with only Guards and Supervisors asks for exactly two
// figures, nothing else.
//
//   Fixed     one rule per post. Every supervisor at this site ends on the same
//             salary — that is the point of a fixed rule.
//   Variable  one figure per person, for the sites where pay is negotiated
//             individually and a single post rate would be a lie.
//
// Pay is still never overwritten in place: each change goes through
// set_employee_salary with an effective date, so past months keep the pay they
// were actually run on.
// ─────────────────────────────────────────────────────────────────────────────
function EditRulesModal({
  target, selectedIds, lines, allLines, locations, branches, onClose, onDone,
}: {
  target: RulesTarget;
  selectedIds: Set<string>;
  /** Personnel contract lines that staff this site — the posts on offer. */
  lines: ContractLine[];
  /** Every contract line, to name a post someone is pinned to from elsewhere. */
  allLines: ContractLine[];
  locations: Location[];
  branches: Branch[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<RulesMode>("fixed");
  /** Fixed mode: post key -> the rule set against it. */
  const [rules, setRules] = useState<Record<string, PostRule>>({});
  /** Variable mode: employee id -> the figures typed for them. */
  const [drafts, setDrafts] = useState<Record<string, { base: string; allowance: string }>>({});
  const [other, setOther] = useState<OtherState>(emptyOther);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const setOtherField = <K extends keyof OtherState>(k: K, v: OtherState[K]) =>
    setOther((o) => ({ ...o, [k]: v }));
  const ruleFor = (key: string) => rules[key] ?? emptyRule();
  const setRule = <K extends keyof PostRule>(key: string, k: K, v: PostRule[K]) =>
    setRules((prev) => ({ ...prev, [key]: { ...(prev[key] ?? emptyRule()), [k]: v } }));

  const scopeLabel = target.siteName ?? target.group.label;

  // Nothing ticked at this site = everyone at this site. The selection is stored
  // per CLIENT, so it has to be intersected here or a tick on a sibling site
  // would silently shrink this site's target list to nobody.
  const targets = useMemo(() => {
    const picked = target.rows.filter((r) => selectedIds.has(r.id));
    return picked.length > 0 ? picked : target.rows;
  }, [target.rows, selectedIds]);
  const usingSelection = targets.length !== target.rows.length;

  // ── The posts ───────────────────────────────────────────────────────────────
  //
  // A post is grouped by its LABEL, not by contract line. A site routinely
  // carries several lines for the same post — Nova Islamabad bills Guard twice,
  // once for the day shift and once for the night — and showing those as two
  // identical "Guard" rows would be indistinguishable on screen and would force
  // the same figure to be typed twice. Since the label falls back to the
  // category name, two posts can never render under the same heading: lines
  // deliberately named apart ("Guard — Gate" vs "Guard — Roving") stay apart,
  // and lines that are the same post split by shift come back together.
  const lineLabelOf = (l: ContractLine) =>
    (l.label ?? "").trim() || CONTRACT_LINE_CATEGORY_LABEL[l.category];

  const { buckets, emptyPosts } = useMemo(() => {
    const lineById = new Map(allLines.map((l) => [l.id, l]));
    const relevant: ContractLine[] = [...lines];
    const seen = new Set(relevant.map((l) => l.id));
    // Someone pinned to a line this site does not list — another site's line, or
    // one on a contract that has since lapsed — still belongs under their real
    // post rather than being swept into the leftovers.
    for (const r of targets) {
      const id = r.contract_line_id;
      if (!id || seen.has(id)) continue;
      const l = lineById.get(id);
      if (l) { relevant.push(l); seen.add(id); }
    }

    type Draft = { key: string; label: string; category: ContractLineCategory; rank: number; rows: EmployeeRow[] };
    const byLabel = new Map<string, Draft>();
    /** line id -> the post it belongs to, so employees can be routed in one pass. */
    const postOfLine = new Map<string, string>();
    for (const l of relevant) {
      const label = lineLabelOf(l);
      const key = label.toLowerCase();
      const rank = CATEGORY_RANK.get(l.category) ?? 99;
      const existing = byLabel.get(key);
      if (existing) existing.rank = Math.min(existing.rank, rank);
      else byLabel.set(key, { key, label, category: l.category, rank, rows: [] });
      postOfLine.set(l.id, key);
    }

    const leftover: EmployeeRow[] = [];
    for (const r of targets) {
      const post = r.contract_line_id ? postOfLine.get(r.contract_line_id) : undefined;
      if (post) byLabel.get(post)!.rows.push(r);
      else leftover.push(r);
    }

    const ordered = [...byLabel.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
    const out: PostBucket[] = ordered.map((d) => ({
      key: d.key,
      label: d.label,
      category: d.category,
      rows: d.rows,
    }));
    if (leftover.length > 0) {
      // One post at this site means every unpinned person is unambiguously that
      // post — the same inference the Department column already makes. With two
      // or more there is nothing to infer from, so they get their own row and
      // can still be given a rate rather than being left out of the edit.
      if (out.length === 1) out[0] = { ...out[0], rows: [...out[0].rows, ...leftover] };
      else out.push({ key: "__unposted", label: "Not on a contract line", category: null, rows: leftover });
    }

    // Posts the contract commits to that nobody fills yet. They get no inputs —
    // a rule against zero people does nothing — but they are worth naming,
    // because an empty post is usually a vacancy rather than a mistake.
    return {
      buckets: out.filter((b) => b.rows.length > 0),
      emptyPosts: out.filter((b) => b.rows.length === 0).map((b) => b.label),
    };
  }, [lines, allLines, targets]);

  /** Fixed: one rule per post, expanded to the people filling it. */
  const fixedChanges = useMemo(() => {
    const out: { employee: EmployeeRow; base: number; allowance: number }[] = [];
    for (const b of buckets) {
      const r = rules[b.key];
      if (!r || (r.baseMode === "none" && r.allowanceMode === "none")) continue;
      for (const e of b.rows) {
        const nextBase = applyPayMode(r.baseMode, r.baseValue, e.base_salary as number | null);
        const nextAllow = applyPayMode(r.allowanceMode, r.allowanceValue, e.allowance as number | null);
        if (nextBase == null && nextAllow == null) continue;
        out.push({
          employee: e,
          base: nextBase ?? (e.base_salary != null ? Math.round(Number(e.base_salary)) : 0),
          allowance: nextAllow ?? (e.allowance != null ? Math.round(Number(e.allowance)) : 0),
        });
      }
    }
    return out;
  }, [buckets, rules]);

  const currentPay = (e: EmployeeRow) => ({
    base: e.base_salary != null ? Math.round(Number(e.base_salary)) : 0,
    allowance: e.allowance != null ? Math.round(Number(e.allowance)) : 0,
  });
  /**
   * The figures shown for one person in Variable mode: what has been typed, or
   * what they earn today. Reads from an explicit store so it can also be used
   * inside the setState updater, where `drafts` would be a stale closure.
   */
  const draftIn = (
    store: Record<string, { base: string; allowance: string }>,
    e: EmployeeRow,
  ) => {
    const cur = currentPay(e);
    return (
      store[e.id] ?? {
        base: e.base_salary != null ? String(cur.base) : "",
        allowance: e.allowance != null ? String(cur.allowance) : "",
      }
    );
  };
  const draftFor = (e: EmployeeRow) => draftIn(drafts, e);
  const setDraft = (e: EmployeeRow, patch: Partial<{ base: string; allowance: string }>) =>
    setDrafts((prev) => ({ ...prev, [e.id]: { ...draftIn(prev, e), ...patch } }));

  /** Variable: only the people whose typed figures differ from what they earn. */
  const variableChanges = useMemo(() => {
    const out: { employee: EmployeeRow; base: number; allowance: number }[] = [];
    for (const b of buckets) {
      for (const e of b.rows) {
        const d = drafts[e.id];
        if (!d) continue;
        const cur = currentPay(e);
        const base = d.base === "" ? cur.base : Math.max(0, Math.round(Number(d.base)));
        const allowance = d.allowance === "" ? cur.allowance : Math.max(0, Math.round(Number(d.allowance)));
        if (!Number.isFinite(base) || !Number.isFinite(allowance)) continue;
        if (base === cur.base && allowance === cur.allowance) continue;
        out.push({ employee: e, base, allowance });
      }
    }
    return out;
  }, [buckets, drafts]);

  const payChanges = mode === "fixed" ? fixedChanges : variableChanges;

  const fieldPatch = useMemo(() => {
    const patch: Record<string, unknown> = {};
    if (other.setLocation) patch.location_id = other.locationId || null;
    if (other.setBranch) patch.branch_id = other.branchId || null;
    if (other.setJoinDate) patch.join_date = other.joinDate || null;
    return patch;
  }, [other]);

  const hasFieldChange = Object.keys(fieldPatch).length > 0;
  const hasPayChange = payChanges.length > 0;

  const apply = async () => {
    if (!hasPayChange && !hasFieldChange) {
      setErr(
        mode === "fixed"
          ? "Nothing to apply — set a rule against a post, or tick a field to update."
          : "Nothing to apply — change someone's figures, or tick a field to update.",
      );
      return;
    }
    if (hasPayChange && !other.effectiveDate) {
      setErr("Pick an effective date for the pay change.");
      return;
    }
    setSaving(true);
    setErr(null);
    setProgress(0);
    try {
      if (hasFieldChange) {
        const { error } = await supabase
          .from("employees")
          .update(fieldPatch)
          .in("id", targets.map((t) => t.id));
        if (error) throw error;
      }
      // Salary is per-employee: each needs its own dated history row, so this is
      // a loop, not one statement. Sequential keeps the error message useful.
      for (let i = 0; i < payChanges.length; i++) {
        const c = payChanges[i];
        const { error } = await supabase.rpc("set_employee_salary", {
          p_employee_id: c.employee.id,
          p_effective_date: other.effectiveDate,
          p_base_salary: c.base,
          p_allowance: c.allowance,
          p_per_day_salary: c.base / daysInCurrentMonth(),
          p_reason: other.reason.trim() || "Increment",
        });
        if (error) throw new Error(`${c.employee.full_name}: ${error.message}`);
        setProgress(i + 1);
      }
      const bits: string[] = [];
      if (hasPayChange) bits.push(`pay updated for ${payChanges.length}`);
      if (hasFieldChange) bits.push(`details updated for ${targets.length}`);
      await onDone(`${scopeLabel}: ${bits.join(", ")}.`);
    } catch (e: any) {
      setErr(e.message ?? String(e));
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-border rounded-md text-sm bg-card";
  // Named `payMode` and not `mode`, which is already the Fixed/Variable switch.
  const modeSelect = (payMode: PayMode, onChange: (m: PayMode) => void) => (
    <ThemedSelect value={payMode} onChange={(e) => onChange(e.target.value as PayMode)} className={inputCls}>
      <option value="none">No change</option>
      <option value="set">Set to exact amount</option>
      <option value="percent">Increase by %</option>
      <option value="flat">Add fixed amount</option>
    </ThemedSelect>
  );

  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={`Edit rules — ${scopeLabel}`}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {saving && payChanges.length > 0
              ? `Applying ${progress} / ${payChanges.length}…`
              : hasPayChange
                ? `${payChanges.length} pay change${payChanges.length === 1 ? "" : "s"} ready`
                : `${targets.length} employee${targets.length === 1 ? "" : "s"}${
                    usingSelection ? " (selected)" : ""
                  } at ${scopeLabel}`}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={apply} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Apply
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="min-w-0">
              <h4 className="text-sm font-medium text-foreground">
                {target.siteName ? `${target.group.label} · ${target.siteName}` : target.group.label}
              </h4>
              <p className="text-xs text-muted-foreground">
                {targets.length} employee{targets.length === 1 ? "" : "s"}
                {usingSelection ? " selected" : ""} · {buckets.length} post
                {buckets.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="inline-flex rounded-md border border-border overflow-hidden shrink-0">
              {(["fixed", "variable"] as RulesMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={`px-3 py-1.5 text-sm transition-colors ${
                    mode === m
                      ? "bg-brand-500/10 text-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {m === "fixed" ? "Fixed" : "Variable"}
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground mb-3">
            {mode === "fixed"
              ? "One rule per post — everyone filling the same post at this site ends on the same figure. Posts come from the contract lines that staff this site."
              : "One figure per person, for sites where pay is negotiated individually. Blank keeps what they earn today."}
          </p>

          {buckets.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground border border-border rounded-md">
              Nobody is posted here yet — use “Assign employees” on this site.
            </p>
          ) : mode === "fixed" ? (
            <div className="space-y-3">
              {buckets.map((b) => {
                const r = ruleFor(b.key);
                const exactBase = r.baseMode === "set" && r.baseValue !== "" && !isNaN(Number(r.baseValue));
                return (
                  <div key={b.key} className="border border-border rounded-md p-3">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className="text-sm font-medium text-foreground">{b.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {b.rows.length} employee{b.rows.length === 1 ? "" : "s"}
                      </span>
                      {b.category === null && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium bg-warning-50 text-warning-800 dark:text-warning-500 border-warning-200"
                          title="Their posting names no contract line, so the contract cannot say which post they fill. Set it with Edit on their row."
                        >
                          <AlertTriangle className="w-3 h-3" strokeWidth={2} />
                          No post on file
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Base salary</label>
                        <div className="flex gap-2">
                          {modeSelect(r.baseMode, (m) => setRule(b.key, "baseMode", m))}
                          <input
                            type="number"
                            value={r.baseValue}
                            disabled={r.baseMode === "none"}
                            onChange={(e) => setRule(b.key, "baseValue", e.target.value)}
                            className={`w-28 shrink-0 px-3 py-2 border border-border rounded-md text-sm bg-card${
                              r.baseMode === "none" ? " opacity-50" : ""
                            }`}
                            placeholder={r.baseMode === "percent" ? "10" : "35000"}
                            aria-label={`${b.label} base salary value`}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Allowance</label>
                        <div className="flex gap-2">
                          {modeSelect(r.allowanceMode, (m) => setRule(b.key, "allowanceMode", m))}
                          <input
                            type="number"
                            value={r.allowanceValue}
                            disabled={r.allowanceMode === "none"}
                            onChange={(e) => setRule(b.key, "allowanceValue", e.target.value)}
                            className={`w-28 shrink-0 px-3 py-2 border border-border rounded-md text-sm bg-card${
                              r.allowanceMode === "none" ? " opacity-50" : ""
                            }`}
                            placeholder="0"
                            aria-label={`${b.label} allowance value`}
                          />
                        </div>
                      </div>
                    </div>
                    {exactBase && (
                      <p className="text-xs text-muted-foreground mt-2">
                        All {b.rows.length} → {money(Math.max(0, Math.round(Number(r.baseValue))))} base.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-3">
              {buckets.map((b) => (
                <div key={b.key} className="border border-border rounded-md overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-border">
                    <span className="text-sm font-medium text-foreground">{b.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {b.rows.length} employee{b.rows.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {b.rows.map((e) => {
                      const d = draftFor(e);
                      return (
                        <div
                          key={e.id}
                          className="grid grid-cols-[1fr_7rem_7rem] gap-2 items-center px-3 py-2 border-b border-border last:border-0"
                        >
                          <span className="text-sm text-foreground truncate" title={e.full_name}>
                            {e.full_name}
                          </span>
                          <input
                            type="number"
                            value={d.base}
                            onChange={(ev) => setDraft(e, { base: ev.target.value })}
                            className="w-full px-2 py-1.5 border border-border rounded-md text-sm bg-card tabular-nums"
                            placeholder="Base"
                            aria-label={`${e.full_name} base salary`}
                          />
                          <input
                            type="number"
                            value={d.allowance}
                            onChange={(ev) => setDraft(e, { allowance: ev.target.value })}
                            className="w-full px-2 py-1.5 border border-border rounded-md text-sm bg-card tabular-nums"
                            placeholder="Allowance"
                            aria-label={`${e.full_name} allowance`}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {emptyPosts.length > 0 && (
            <p className="text-xs text-muted-foreground mt-2">
              This site's contract also commits to {emptyPosts.join(", ")} — nobody fills{" "}
              {emptyPosts.length === 1 ? "that post" : "those posts"} yet, so there is no pay to set.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Effective date</label>
              <input type="date" value={other.effectiveDate} onChange={(e) => setOtherField("effectiveDate", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Reason</label>
              <input value={other.reason} onChange={(e) => setOtherField("reason", e.target.value)} className={inputCls} placeholder="Annual increment" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Recorded as a dated increment per employee — earlier months keep the salary they were paid on.
          </p>

          {payChanges.length > 0 && (
            <div className="mt-3 border border-border rounded-md max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1.5 px-2 font-medium">Employee</th>
                    <th className="py-1.5 px-2 font-medium">Base</th>
                    <th className="py-1.5 px-2 font-medium">Allowance</th>
                  </tr>
                </thead>
                <tbody>
                  {payChanges.map((c) => (
                    <tr key={c.employee.id} className="border-b border-border last:border-0">
                      <td className="py-1.5 px-2 text-foreground">{c.employee.full_name}</td>
                      <td className="py-1.5 px-2 tabular-nums text-muted-foreground">
                        {money(c.employee.base_salary)} <span className="text-muted-foreground">→</span>{" "}
                        <span className="text-foreground font-medium">{money(c.base)}</span>
                      </td>
                      <td className="py-1.5 px-2 tabular-nums text-muted-foreground">
                        {money(c.employee.allowance)} <span className="text-muted-foreground">→</span>{" "}
                        <span className="text-foreground font-medium">{money(c.allowance)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="pt-4 border-t border-border">
          <h4 className="text-sm font-medium text-foreground mb-1">Other details</h4>
          <p className="text-xs text-muted-foreground mb-3">
            Applies to all {targets.length} — these are not per-post.
          </p>
          <div className="space-y-3">
            <RuleField
              label="Location"
              checked={other.setLocation}
              onToggle={(v) => setOtherField("setLocation", v)}
            >
              <ThemedSelect value={other.locationId} onChange={(e) => setOtherField("locationId", e.target.value)} className={inputCls}>
                <option value="">— Clear —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </ThemedSelect>
            </RuleField>
            <RuleField
              label="Primary branch"
              checked={other.setBranch}
              onToggle={(v) => setOtherField("setBranch", v)}
            >
              <ThemedSelect value={other.branchId} onChange={(e) => setOtherField("branchId", e.target.value)} className={inputCls}>
                <option value="">Head Office (default)</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </ThemedSelect>
            </RuleField>
            <RuleField
              label="Joining date"
              checked={other.setJoinDate}
              onToggle={(v) => setOtherField("setJoinDate", v)}
            >
              <input type="date" value={other.joinDate} onChange={(e) => setOtherField("joinDate", e.target.value)} className={inputCls} />
            </RuleField>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Client, category and shift are dated posting changes and stay one-at-a-time — use Edit on the row.
          </p>
        </section>
      </div>
    </Modal>
  );
}

function RuleField({
  label, checked, onToggle, children,
}: {
  label: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-2 sm:items-center">
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        {label}
      </label>
      <div className={checked ? "" : "opacity-40 pointer-events-none"}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One employee's assignment + pay. Plain fields save straight through; client,
// category and shift are dated posting changes handed to their own modals; pay
// goes through the dated increment panel.
// ─────────────────────────────────────────────────────────────────────────────
function RowEditModal({
  employee, canEdit, displayCode, clients,
  onClose, onSaved, onChangeClient, onChangeCategory, onChangeShift, onError, departmentLabel,
  lineOptions, slotForLine, siteNoteForLine,
}: {
  employee: EmployeeRow;
  canEdit: boolean;
  displayCode: string;
  /** The contract line this employee fills — shown in place of a free-text department. */
  departmentLabel: string | null;
  /** Personnel lines at the SITE this employee stands at, to pin them to one. */
  lineOptions: ContractLine[];
  /** Committed vs filled for a line, so the options read like the Assign dialog. */
  slotForLine: (line: ContractLine, onDate: string) => { committed: number; filled: number };
  /** Site name for a line that belongs to a different site; null for local posts. */
  siteNoteForLine: (line: ContractLine) => string | null;
  clients: Client[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onChangeClient: () => void;
  onChangeCategory: () => void;
  onChangeShift: () => void;
  onError: (m: string) => void;
}) {
  const [joinDate, setJoinDate] = useState(employee.join_date ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const category = (employee.category ?? "client") as EmployeeCategory;
  const clientName = clients.find((c) => c.id === employee.client_id)?.name ?? "—";
  const canPost = ["active", "on_leave"].includes(employee.lifecycle_state ?? "");
  // Before the first client posting exists there is no dated history to protect,
  // so category and shift are ordinary columns the user can just set.
  const neverPosted = !employee.client_id;
  const [shift, setShift] = useState<string>(employee.shift);
  const [draftCategory, setDraftCategory] = useState<EmployeeCategory>(category);
  const [lineId, setLineId] = useState(employee.contract_line_id ?? "");
  // Offer the picker whenever the client has a post to pin them to. It used to
  // need two or more, on the reasoning that a single line is already inferred —
  // but inferring a Department is not the same as recording one, and a guard
  // left unpinned drops out of every per-post figure on this page.
  const canPickLine = canEdit && category === "client" && lineOptions.length > 0;

  /**
   * A post is full when it already holds everyone the contract commits to it.
   * Moving in would put the site over its own contracted strength, which is the
   * cap the Assign dialog has always enforced — the Department picker skipped it
   * and was the way around it.
   *
   * The post they ALREADY hold is never full to them: they are one of the people
   * counted in it, and several lines are over-committed from before this check
   * existed (Nova Charsadda commits 5 day guards and holds 8). Blocking those
   * would freeze the field and stop the very corrections that fix them.
   */
  const heldLineId = employee.contract_line_id ?? "";
  const lineIsFull = (l: ContractLine) => {
    if (l.id === heldLineId) return false;
    const s = slotForLine(l, todayIso());
    return s.filled >= s.committed;
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      // Re-check at save: the numbers were read when the modal opened, and
      // somebody else may have taken the last slot since.
      if (canPickLine && lineId && lineId !== heldLineId) {
        const target = lineOptions.find((l) => l.id === lineId);
        if (target) {
          const s = slotForLine(target, todayIso());
          if (s.filled >= s.committed) {
            throw new Error(
              `${lineOptionLabel(target, null, siteNoteForLine(target))} is full — the contract ` +
                `commits ${s.committed} and ${s.filled} ${s.filled === 1 ? "is" : "are"} already ` +
                `in it. Raise the headcount on the contract, or add an addendum, before moving ` +
                `anyone in.`,
            );
          }
        }
      }

      const { error } = await supabase
        .from("employees")
        .update({
          join_date: joinDate || null,
          ...(neverPosted ? { shift, category: draftCategory } : {}),
          ...(canPickLine ? { contract_line_id: lineId || null } : {}),
        })
        .eq("id", employee.id);
      if (error) throw error;

      // The line also lives on the open posting, which is what site/strength
      // reporting reads. Correcting one without the other leaves the two
      // disagreeing about which slot the guard fills.
      if (canPickLine && lineId !== (employee.contract_line_id ?? "")) {
        const { error: depErr } = await supabase
          .from("deployments")
          .update({ contract_line_id: lineId || null })
          .eq("guard_id", employee.id)
          .is("end_date", null);
        if (depErr) throw depErr;
      }

      await onSaved();
    } catch (e: any) {
      const m = e.message ?? String(e);
      setErr(m);
      onError(m);
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-border rounded-md text-sm bg-card";
  const lockedCls = "w-full px-3 py-2 border border-border rounded-md text-sm bg-slate-50 text-slate-500 cursor-not-allowed";

  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={`${employee.full_name} · ${displayCode}`}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Close</Button>
          {canEdit && (
            <Button size="sm" onClick={save} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Save
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-6">
        <section>
          <h4 className="text-sm font-medium text-foreground mb-3">Posting</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Category</label>
              {neverPosted && canEdit ? (
                <ThemedSelect value={draftCategory} onChange={(e) => setDraftCategory(e.target.value as EmployeeCategory)} className={inputCls}>
                  <option value="client">Client</option>
                  <option value="office_staff">Office Staff</option>
                  <option value="reliever">Reliever</option>
                </ThemedSelect>
              ) : (
                <>
                  <input value={CATEGORY_LABEL[category]} disabled readOnly className={lockedCls} />
                  {canEdit && canPost && (
                    <button type="button" onClick={onChangeCategory} className="text-xs text-brand-700 dark:text-brand-500 hover:underline mt-1">
                      Change category (dated)
                    </button>
                  )}
                </>
              )}
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Client</label>
              <input value={category === "client" ? clientName : "—"} disabled readOnly className={lockedCls} />
              {canEdit && neverPosted && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Assign from the client's card — use its “Assign employees” button.
                </p>
              )}
              {canEdit && !neverPosted && canPost && category === "client" && (
                <button type="button" onClick={onChangeClient} className="text-xs text-brand-700 dark:text-brand-500 hover:underline mt-1">
                  Change client (dated)
                </button>
              )}
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Shift</label>
              {neverPosted && canEdit ? (
                <ThemedSelect value={shift} onChange={(e) => setShift(e.target.value)} className={inputCls}>
                  <option value="day">Day</option>
                  <option value="evening">Evening</option>
                  <option value="night">Night</option>
                </ThemedSelect>
              ) : (
                <>
                  <input value={employee.shift} disabled readOnly className={lockedCls + " capitalize"} />
                  {canEdit && canPost && category === "client" && (
                    <button type="button" onClick={onChangeShift} className="text-xs text-brand-700 dark:text-brand-500 hover:underline mt-1">
                      Change shift (dated)
                    </button>
                  )}
                </>
              )}
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Department</label>
              {canPickLine ? (
                <>
                  <ThemedSelect value={lineId} onChange={(e) => setLineId(e.target.value)} className={inputCls}>
                    <option value="">— Not set —</option>
                    {lineOptions.map((l) => (
                      <option key={l.id} value={l.id} disabled={lineIsFull(l)}>
                        {lineOptionLabel(l, slotForLine(l, todayIso()), siteNoteForLine(l))}
                        {lineIsFull(l) ? " · FULL" : ""}
                      </option>
                    ))}
                  </ThemedSelect>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    The post this employee fills, from their client's contract. Posts the
                    contract commits no headcount to are not offered, and a post already
                    holding everyone it commits cannot be moved into.
                  </p>
                </>
              ) : (
                <>
                  <input value={departmentLabel ?? "—"} disabled readOnly className={lockedCls} />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Follows the contract line this employee fills.
                  </p>
                </>
              )}
            </div>
          </div>
          {!canPost && (
            <p className="text-xs text-muted-foreground mt-2">
              Client / category / shift changes need an active employee.
            </p>
          )}
        </section>

        {/*
          Location, primary branch and additional branches used to sit here. They
          are cost-ownership and visibility settings, not posting details, and
          they still live on the Employee Management modal — the one place that
          edits an employee's record as a whole. Joining date stays: it dates the
          posting this page is about.
        */}
        <section className="pt-4 border-t border-border">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Joining date</label>
              <input
                type="date"
                value={joinDate}
                disabled={!canEdit}
                onChange={(e) => setJoinDate(e.target.value)}
                className={canEdit ? inputCls : lockedCls}
              />
            </div>
          </div>
        </section>

        <section className="pt-4 border-t border-border">
          <h4 className="text-sm font-medium text-foreground mb-3">Pay</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Base salary</label>
              <input value={money(employee.base_salary)} disabled readOnly className={lockedCls} />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Per day</label>
              <input value={money(perDayOf(employee.base_salary))} disabled readOnly className={lockedCls} />
              <p className="text-[11px] text-muted-foreground mt-1">Base ÷ {daysInCurrentMonth()} days this month.</p>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Allowance</label>
              <input value={money(employee.allowance)} disabled readOnly className={lockedCls} />
            </div>
          </div>
          {canEdit && (
            <SalaryHistoryPanel
              employeeId={employee.id}
              currentBase={employee.base_salary != null ? String(employee.base_salary) : ""}
              currentAllowance={employee.allowance != null ? String(employee.allowance) : ""}
              onApplied={() => { void onSaved(); }}
            />
          )}
        </section>
      </div>
    </Modal>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Assign employees to a client — the first posting for people who have none.
//
// Driven from the client, not the employee: you almost always know which client
// is short-staffed, not which particular new hire is idle, so the flow is "pick
// this client's new guards" rather than "find the guard, then pick a client".
//
// This can NOT go through change_client(): that RPC refuses a draft record
// ("must be Ops-verified before being posted"), and a brand-new hire is always
// draft. Hiring has always been the exception — the posting row is written
// directly, which the enforce_posting_requires_ops_verified trigger allows
// because the employee has no prior client. Moving an ALREADY-posted guard is a
// different action ("Change client") and still goes through the RPC.
// ─────────────────────────────────────────────────────────────────────────────
function AssignEmployeesModal({
  target, candidates, contractsForClient, linesForContract, addendums, allEmployees,
  onClose, onDone, onError,
}: {
  target: AssignTarget;
  candidates: EmployeeRow[];
  contractsForClient: (clientId: string) => Contract[];
  linesForContract: (contractId: string) => ContractLine[];
  addendums: ContractAddendum[];
  allEmployees: EmployeeRow[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
  onError: (m: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [contractId, setContractId] = useState("");
  const [contractLineId, setContractLineId] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [shift, setShift] = useState("");
  const [baseSalary, setBaseSalary] = useState("");
  const [allowance, setAllowance] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  // Office Staff and Relievers hold no client posting, so there is no contract,
  // no line and nothing to cap — the slot machinery is client-only.
  const toClient = target.kind === "client";
  const siteId = target.kind === "client" ? target.siteId : null;
  // Contract → line → how many slots are left. A client can hold several
  // contracts, so the contract has to be chosen before its lines mean anything.
  const clientContracts = toClient ? contractsForClient(target.id) : [];
  // Every line on the contract. The slot arithmetic below counts committed and
  // filled across the WHOLE contract, so it has to keep seeing all of them —
  // narrowing this to the site would compare a site-sized commitment against a
  // contract-sized headcount and refuse postings that are genuinely free.
  const lines = useMemo(
    () => (contractId ? linesForContract(contractId) : []),
    [contractId, linesForContract],
  );
  /**
   * The lines actually OFFERED.
   *
   * Posting to a site should not let you pick a line that staffs a different
   * site; a line with no site is contract-wide and stays on offer everywhere.
   * A line the contract commits no headcount to is dropped outright — it bills
   * for something, but it is not a post anybody can stand in.
   */
  const offeredLines = useMemo(() => {
    const adds = addendums.filter((a) => a.contract_id === contractId);
    return lines.filter(
      (l) =>
        (!siteId || l.site_id === siteId || l.site_id === null) &&
        effectiveCommittedForLine(l, adds, startDate) > 0,
    );
  }, [lines, siteId, addendums, contractId, startDate]);
  // Committed vs already-filled for THIS LINE, as of the posting start date, and
  // the cap that follows. Per line, not per category: on a multi-site contract
  // the category pool spans every site, so posting to Nova Charsadda measured
  // against all four Nova sites' guards at once and capped at a number that had
  // nothing to do with Charsadda. A line is one post at one site on one shift,
  // which is exactly what is being filled here.
  const slotFor = useCallback(
    (lineId: string) => {
      const line = lines.find((l) => l.id === lineId);
      if (!line) return null;
      const adds = addendums.filter((a) => a.contract_id === contractId);
      const committed = effectiveCommittedForLine(line, adds, startDate);
      const filled = activeCountByLine(allEmployees, startDate).get(lineId) ?? 0;
      return { category: line.category, committed, filled, available: Math.max(0, committed - filled) };
    },
    [addendums, contractId, lines, startDate, allEmployees],
  );

  const slot = contractLineId ? slotFor(contractLineId) : null;
  // No line chosen (or a contract with no lines at all) = no committed headcount
  // to measure against, so nothing to cap.
  const cap = slot ? slot.available : Infinity;
  const atCap = picked.size >= cap;

  // Changing contract or line invalidates a selection sized against the old cap.
  useEffect(() => { setPicked(new Set()); }, [contractId, contractLineId]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (e) =>
        e.full_name.toLowerCase().includes(q) ||
        (e.employee_code ?? "").toLowerCase().includes(q) ||
        (e.guard_code ?? "").toLowerCase().includes(q) ||
        (e.cnic_number ?? "").toLowerCase().includes(q) ||
        (e.phone ?? "").toLowerCase().includes(q),
    );
  }, [candidates, search]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < cap) next.add(id);
      return next;
    });
  const allShownPicked = shown.length > 0 && shown.every((e) => picked.has(e.id));
  const toggleAllShown = () =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (allShownPicked) {
        shown.forEach((e) => next.delete(e.id));
      } else {
        // Fill up to the remaining slots, then stop.
        for (const e of shown) {
          if (next.size >= cap) break;
          next.add(e.id);
        }
      }
      return next;
    });

  const save = async () => {
    const targets = candidates.filter((e) => picked.has(e.id));
    if (targets.length === 0) { setErr("Pick at least one employee."); return; }
    if (!startDate) { setErr("Pick a start date."); return; }
    if (toClient && clientContracts.length > 0 && !contractId) { setErr("Choose which contract this posting is under."); return; }
    if (toClient && offeredLines.length > 0 && !contractLineId) { setErr("Choose a contract line — it sets the category and its headcount limit."); return; }
    // Re-check against the live figures: the cap also guards the checkboxes, but
    // the committed count can move (an addendum, another operator) between the
    // dialog opening and Assign being pressed.
    if (slot && targets.length > slot.available) {
      setErr(
        `${CONTRACT_LINE_CATEGORY_LABEL[slot.category]}: only ${slot.available} of ` +
        `${slot.committed} slot${slot.committed === 1 ? "" : "s"} free on this contract ` +
        `(${slot.filled} already filled). Raise the committed count with an addendum to post more.`,
      );
      return;
    }
    const base = baseSalary ? Number(baseSalary) : null;
    if (base != null && (isNaN(base) || base <= 0)) {
      setErr("Enter a valid base salary, or leave it blank.");
      return;
    }

    setSaving(true);
    setErr(null);
    setProgress(0);
    try {
      // The site everyone in this batch is posted to. It comes from the site row
      // the button was pressed on; only a client with no sites at all falls back
      // to the default-site lookup, which is all this used to do.
      let postSiteId: string | null = siteId;
      if (toClient && !postSiteId) {
        const { data: defSite } = await supabase
          .from("sites").select("id")
          .eq("client_id", target.id).eq("is_default", true).maybeSingle();
        postSiteId = (defSite as { id?: string } | null)?.id ?? null;
      }

      // Sequential: each employee needs its own posting row, code and salary seed,
      // and a failure part-way must name the person it stopped on.
      for (let i = 0; i < targets.length; i++) {
        const e = targets[i];
        const fail = (m: string) => new Error(`${e.full_name}: ${m}`);

        if (!toClient) {
          // change_category closes any open posting the day before, clears the
          // client mirrors and sets the new category — the same dated path the
          // "Change category" action uses, so history is handled identically, and
          // it is fine for someone who never had a posting at all.
          const { error: catErr } = await supabase.rpc("change_category", {
            p_guard_id: e.id,
            p_new_category: target.category,
            p_new_client_id: null,
            p_contract_line_id: null,
            p_effective_date: startDate,
          });
          if (catErr) throw fail(catErr.message);
          // Office staff are placed by REGION — that is their equivalent of a
          // site. change_category clears the client mirrors but knows nothing
          // about branches, so the region the button was pressed on is applied
          // here. Merged with shift so a single update carries both.
          const patch: Record<string, unknown> = {};
          if (shift) patch.shift = shift;
          if (target.kind === "category" && target.branchId) patch.branch_id = target.branchId;
          if (Object.keys(patch).length > 0) {
            const { error: shErr } = await supabase.from("employees").update(patch).eq("id", e.id);
            if (shErr) throw fail(shErr.message);
          }
          if (base != null) {
            const { error: salErr } = await supabase.rpc("set_employee_salary", {
              p_employee_id: e.id,
              p_effective_date: startDate,
              p_base_salary: base,
              p_allowance: allowance ? Math.max(0, Number(allowance)) : 0,
              p_per_day_salary: base / daysInCurrentMonth(),
              p_reason: "Initial salary",
            });
            if (salErr) throw fail(salErr.message);
          }
          setProgress(i + 1);
          continue;
        }

        // Category and shift are plain columns until the first posting exists.
        const { error: upErr } = await supabase
          .from("employees")
          .update({
            category: "client",
            join_date: e.join_date ?? startDate,
            // The slot the guard occupies. activeCountByCategory reads these off
            // the employee row, so without them the next assignment would see the
            // line as still empty and blow past its committed count.
            contract_id: contractId || null,
            contract_line_id: contractLineId || null,
            assignment_effective_from: contractLineId ? startDate : null,
            assignment_effective_to: null,
            ...(shift ? { shift } : {}),
          })
          .eq("id", e.id);
        if (upErr) throw fail(upErr.message);

        // The posting row. Its sync trigger mirrors client_id onto the employee.
        // shift_code MUST be stamped here: it is what makes shift a dated property.
        // Left null, this segment resolves through to the guard's CURRENT shift, so
        // a later shift change would repaint every earlier day with the new shift.
        const { error: depErr } = await supabase.from("deployments").insert({
          guard_id: e.id,
          client_id: target.id,
          contract_line_id: contractLineId || null,
          site_id: postSiteId,
          start_date: startDate,
          shift_code: shift || e.shift || "day",
          reason: "new_hire",
        });
        if (depErr) throw fail(depErr.message);

        // Permanent GGS-NNNNN (once, at hiring) + the client-scoped display number.
        if (!e.guard_code) {
          const { error: codeErr } = await supabase.rpc("assign_guard_code", { p_employee_id: e.id });
          if (codeErr) throw fail(codeErr.message);
        }
        const { error: dispErr } = await supabase.rpc("assign_display_number", { p_employee_id: e.id });
        if (dispErr) throw fail(dispErr.message);

        // Seed the first salary-history row — the capture trigger only fires on
        // UPDATE, so without this the guard would have no effective-dated pay.
        if (base != null) {
          const { error: salErr } = await supabase.rpc("set_employee_salary", {
            p_employee_id: e.id,
            p_effective_date: startDate,
            p_base_salary: base,
            p_allowance: allowance ? Math.max(0, Number(allowance)) : 0,
            p_per_day_salary: base / daysInCurrentMonth(),
            p_reason: "Initial salary",
          });
          if (salErr) throw fail(salErr.message);
        }
        setProgress(i + 1);
      }
      await onDone(
        `${targets.length} employee${targets.length === 1 ? "" : "s"} assigned to ${target.name}.`,
      );
    } catch (e: any) {
      const m = e.message ?? String(e);
      setErr(progress > 0 ? `${m} — ${progress} already assigned before this failed.` : m);
      onError(m);
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-border rounded-md text-sm bg-card";
  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={
        target.kind === "client" && target.siteName
          ? `Assign employees to ${target.siteName} · ${target.name}`
          : target.kind === "category" && target.branchName
            ? `Assign employees to ${target.branchName} · ${target.name}`
            : `Assign employees to ${target.name}`
      }
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {saving ? `Assigning ${progress} / ${picked.size}…` : `${picked.size} selected`}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving || picked.size === 0}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Assign{picked.size > 0 ? ` ${picked.size}` : ""}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {toClient && (
        <div>
          <h4 className="text-sm font-medium text-foreground mb-2">Which contract</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Contract</label>
              <ThemedSelect
                value={contractId}
                onChange={(e) => { setContractId(e.target.value); setContractLineId(""); }}
                className={inputCls}
                disabled={clientContracts.length === 0}
              >
                <option value="">{clientContracts.length === 0 ? "No contracts on file" : "— Select —"}</option>
                {clientContracts.map((c) => (
                  <option key={c.id} value={c.id}>{c.contract_code} · {c.status}</option>
                ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Contract line (category)</label>
              <ThemedSelect
                value={contractLineId}
                onChange={(e) => setContractLineId(e.target.value)}
                className={inputCls}
                disabled={!contractId || offeredLines.length === 0}
              >
                <option value="">
                  {!contractId
                    ? "Pick a contract first"
                    : offeredLines.length === 0
                      ? lines.length === 0
                        ? "This contract has no lines"
                        : "No open posts here"
                      : "— Select —"}
                </option>
                {offeredLines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {lineOptionLabel(l, slotFor(l.id))}
                  </option>
                ))}
              </ThemedSelect>
            </div>
          </div>
          {contractId && lines.length === 0 && (
            <p className="text-xs text-warning-700 dark:text-warning-500 mt-2">
              This contract has no category lines, so there is no committed headcount to check against.
              Add lines on the Contracts page to cap postings by category.
            </p>
          )}
          {contractId && lines.length > 0 && offeredLines.length === 0 && (
            <p className="text-xs text-warning-700 dark:text-warning-500 mt-2">
              This contract has no open post
              {target.kind === "client" && target.siteName ? ` at ${target.siteName}` : ""} — its
              lines either staff another site or commit no headcount. Raise a line's committed
              count, or set its site, from the Contracts page.
            </p>
          )}
          {slot && (
            <p
              className={`text-xs mt-2 ${
                slot.available === 0 ? "text-danger-600 dark:text-danger-500" : "text-muted-foreground"
              }`}
            >
              {CONTRACT_LINE_CATEGORY_LABEL[slot.category]}: {slot.filled} of {slot.committed} committed
              {slot.committed === 1 ? " slot" : " slots"} filled —{" "}
              <span className="font-medium">
                {slot.available} available
              </span>
              {slot.available === 0 && " · free a slot or raise the count with an addendum"}
            </p>
          )}
        </div>
        )}

        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <div className="relative flex-1 min-w-52">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, code, CNIC or phone…"
                className={inputCls + " pl-9"}
                autoFocus
              />
            </div>
            {shown.length > 0 && (
              <Button variant="ghost" size="sm" onClick={toggleAllShown} disabled={cap === 0}>
                {allShownPicked ? "Clear" : `Select ${Math.min(shown.length, cap === Infinity ? shown.length : cap)}`}
              </Button>
            )}
          </div>
          {slot && (
            <p className="text-xs text-muted-foreground mb-2">
              {picked.size} of {slot.available} selectable
              {atCap && slot.available > 0 && " — line is full for this posting"}
            </p>
          )}

          <div className="border border-border rounded-md max-h-72 overflow-y-auto">
            {candidates.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                Everyone already has a client. Add someone first from Workforce ▸ Employees.
              </p>
            ) : shown.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                No unassigned employee matches that search.
              </p>
            ) : (
              shown.map((e) => {
                const checked = picked.has(e.id);
                const cat = (e.category ?? "client") as EmployeeCategory;
                const blocked = !checked && atCap;
                return (
                  <label
                    key={e.id}
                    title={blocked ? "No committed slots left on this contract line" : undefined}
                    className={`flex items-center gap-3 px-3 py-2 border-b border-border last:border-0 transition-colors ${
                      checked ? "bg-brand-500/10" : blocked ? "opacity-45 cursor-not-allowed" : "cursor-pointer hover:bg-accent"
                    }`}
                  >
                    <input type="checkbox" checked={checked} disabled={blocked} onChange={() => toggle(e.id)} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-foreground truncate">{e.full_name}</span>
                      <span className="block text-xs text-muted-foreground truncate">
                        {e.guard_code ?? e.employee_code}
                        {e.cnic_number ? ` · ${e.cnic_number}` : ""}
                        {e.phone ? ` · ${e.phone}` : ""}
                      </span>
                    </span>
                    {cat !== "client" && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-border text-muted-foreground shrink-0">
                        {CATEGORY_LABEL[cat]}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>
        </div>

        <div className="pt-4 border-t border-border">
          <h4 className="text-sm font-medium text-foreground mb-1">Applies to everyone selected</h4>
          <p className="text-xs text-muted-foreground mb-3">
            {toClient
              ? `This is each person's first posting${
                  target.kind === "client" && target.siteName ? `, at ${target.siteName}` : ""
                }, so it also issues their permanent guard code and their client number. Pay can be left blank and set later with Edit rules.`
              : `They move to ${target.name}${
                  target.kind === "category" && target.branchName ? ` · ${target.branchName}` : ""
                } from the date below. No client posting is created, so no client number is issued. Pay can be left blank and set later with Edit rules.`}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">{toClient ? "Start date" : "Effective date"}</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Shift</label>
              <ThemedSelect value={shift} onChange={(e) => setShift(e.target.value)} className={inputCls}>
                <option value="">Keep each employee's current shift</option>
                <option value="day">Day</option>
                <option value="evening">Evening</option>
                <option value="night">Night</option>
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Base salary (PKR)</label>
              <input type="number" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} className={inputCls} placeholder="Leave blank to set later" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Allowance (PKR)</label>
              <input type="number" min={0} value={allowance} onChange={(e) => setAllowance(e.target.value)} className={inputCls} placeholder="0" />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Transfer — move one employee to another client, or onto office staff /
// relievers.
//
// All three go through change_category(), which closes the open posting at the
// day before the effective date and opens a new one where the destination is a
// client. Nothing is deleted: the guard's history at the old client stays
// intact, and attendance already recorded against it is untouched.
//
// Moving to a client also reissues the client-scoped display number and logs the
// old -> new transition, so past paperwork still resolves. The permanent guard
// code (GGS-NNNNN) is never reissued.
//
// A FUTURE effective date is refused. The posting sync keys off "no open
// posting", so a future date would move the guard immediately while the form
// claimed they stay until then.
// ─────────────────────────────────────────────────────────────────────────────
type TransferDest = "client" | "site" | "office_staff" | "reliever";

function TransferModal({
  employee, clients, displayCode, sites, currentSiteId, contractsForClient, linesForContract, linesForSite, onClose, onDone, onError,
}: {
  employee: EmployeeRow;
  clients: Client[];
  displayCode: string;
  sites: { id: string; client_id: string; name: string }[];
  currentSiteId: string;
  contractsForClient: (clientId: string) => Contract[];
  linesForContract: (contractId: string) => ContractLine[];
  linesForSite: (clientId: string, siteId: string) => ContractLine[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
  onError: (m: string) => void;
}) {
  const currentCategory = (employee.category ?? "client") as EmployeeCategory;
  const [dest, setDest] = useState<TransferDest>("client");
  const [clientId, setClientId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [contractLineId, setContractLineId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const movingToClient = dest === "client";
  const movingToSite = dest === "site";
  // A site move stays on the current client; a client move uses the picked client.
  const activeClientId = movingToSite ? (employee.client_id ?? "") : clientId;

  // Sites available to pick. For a site move, the current client's OTHER sites
  // (you can't move to the site you're already on). For a client move, the target
  // client's sites. When the client has sites, the contract-line list is scoped to
  // the picked site (its own lines + contract-wide lines); otherwise the flat list.
  const allClientSites = activeClientId ? sites.filter((s) => s.client_id === activeClientId) : [];
  const clientSites = movingToSite ? allClientSites.filter((s) => s.id !== currentSiteId) : allClientSites;
  const lines = !activeClientId
    ? []
    : allClientSites.length > 0
      ? (siteId ? linesForSite(activeClientId, siteId) : [])
      : contractsForClient(activeClientId).flatMap((c) => linesForContract(c.id));
  const currentClientName = clients.find((c) => c.id === employee.client_id)?.name ?? "—";
  const clientChanges = movingToClient && clientId !== (employee.client_id ?? "");
  const currentSiteName = sites.find((s) => s.id === currentSiteId)?.name ?? null;
  // "Another site" only makes sense when the current client has more than one site.
  const canMoveSite =
    !!employee.client_id && sites.filter((s) => s.client_id === employee.client_id).length > 1;

  const save = async () => {
    if (movingToClient && !clientId) { setErr("Pick the client to transfer to."); return; }
    if (movingToSite && !employee.client_id) {
      setErr("This employee isn't posted to a client, so there's no site to move within.");
      return;
    }
    if (movingToSite && clientSites.length === 0) {
      setErr("This client has no other site to move to.");
      return;
    }
    if ((movingToClient || movingToSite) && clientSites.length > 0 && !siteId) {
      setErr("Pick the site to transfer to.");
      return;
    }
    if (!effectiveDate) { setErr("Pick an effective date."); return; }
    if (effectiveDate > todayIso()) {
      setErr("An effective date in the future is not supported — the transfer takes effect immediately.");
      return;
    }
    if (movingToClient && !clientChanges) {
      setErr("That is the client they are already on.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const onClient = movingToClient || movingToSite;
      const { error: mvErr } = await supabase.rpc("change_category", {
        p_guard_id: employee.id,
        p_new_category: onClient ? "client" : dest,
        // A site move stays on the same client; the RPC re-posts to the new site
        // from the effective date and closes the old posting the day before, so
        // past attendance stays under the previous site.
        p_new_client_id: movingToClient ? clientId : movingToSite ? employee.client_id : null,
        p_contract_line_id: onClient ? contractLineId || null : null,
        p_effective_date: effectiveDate,
        p_site_id: onClient ? siteId || null : null,
      });
      if (mvErr) throw mvErr;

      let label: string;
      if (movingToSite) {
        // Same client, so the display code is unchanged (the sync trigger only
        // reallocates when the client itself changes) — no new number, no history row.
        label = `${sites.find((s) => s.id === siteId)?.name ?? "the new site"}`;
      } else if (movingToClient) {
        // New client, new client-scoped number; the transition is logged so the
        // old code still resolves to this person.
        const { data: newDisp, error: dispErr } = await supabase.rpc("assign_display_number", {
          p_employee_id: employee.id,
        });
        if (dispErr) throw dispErr;
        const permanent = employee.guard_code ?? employee.employee_code;
        const { error: histErr } = await supabase.from("employee_code_history").insert({
          company_id: employee.company_id,
          employee_id: employee.id,
          old_code: displayCode,
          new_code: (newDisp as string | null) ?? permanent,
          client_id: clientId,
          reason: "reassigned",
        });
        if (histErr) throw histErr;
        label = clients.find((c) => c.id === clientId)?.name ?? "the new client";
      } else {
        label = CATEGORY_LABEL[dest as EmployeeCategory];
      }
      await onDone(`${employee.full_name} transferred to ${label}.`);
    } catch (e: any) {
      const m = e.message ?? String(e);
      setErr(m);
      onError(m);
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-border rounded-md text-sm bg-card";
  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={`Transfer ${employee.full_name}`}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Transfer
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Currently {CATEGORY_LABEL[currentCategory]}
          {currentCategory === "client" ? ` · ${currentClientName} · ${displayCode}` : ""}. The old
          posting is closed, not deleted — past attendance stays where it was recorded.
        </p>

        <label className="block">
          <span className="text-xs text-muted-foreground">Transfer to</span>
          <ThemedSelect
            value={dest}
            onChange={(e) => {
              setDest(e.target.value as TransferDest);
              setClientId(""); setSiteId(""); setContractLineId("");
            }}
            className={inputCls}
          >
            <option value="client">Another client</option>
            {canMoveSite && <option value="site">Another site</option>}
            <option value="office_staff">Office Staff</option>
            <option value="reliever">Reliever</option>
          </ThemedSelect>
        </label>

        {(movingToClient || movingToSite) && (
          <>
            {movingToClient && (
              <label className="block">
                <span className="text-xs text-muted-foreground">Client</span>
                <ThemedSelect
                  value={clientId}
                  onChange={(e) => { setClientId(e.target.value); setSiteId(""); setContractLineId(""); }}
                  className={inputCls}
                >
                  <option value="">— Select —</option>
                  {clients
                    .filter((c) => c.id !== employee.client_id)
                    .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </ThemedSelect>
              </label>
            )}
            {movingToSite && (
              <p className="text-xs text-muted-foreground">
                Staying on {currentClientName}
                {currentSiteName ? `, moving off ${currentSiteName}` : ""}. The display code is unchanged.
              </p>
            )}
            {clientSites.length > 0 && (
              <label className="block">
                <span className="text-xs text-muted-foreground">Site</span>
                <ThemedSelect
                  value={siteId}
                  onChange={(e) => { setSiteId(e.target.value); setContractLineId(""); }}
                  className={inputCls}
                >
                  <option value="">— Select —</option>
                  {clientSites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </ThemedSelect>
              </label>
            )}
            <label className="block">
              <span className="text-xs text-muted-foreground">Contract line (optional)</span>
              <ThemedSelect
                value={contractLineId}
                onChange={(e) => setContractLineId(e.target.value)}
                className={inputCls}
              >
                <option value="">— None —</option>
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label ?? CONTRACT_LINE_CATEGORY_LABEL[l.category]}
                  </option>
                ))}
              </ThemedSelect>
              <span className="block text-[11px] text-muted-foreground mt-1">
                Sets their Department and counts them against that line's committed strength.
              </span>
            </label>
          </>
        )}

        <label className="block">
          <span className="text-xs text-muted-foreground">Effective date</span>
          <input
            type="date"
            value={effectiveDate}
            max={todayIso()}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className={inputCls}
          />
        </label>

        {clientChanges && (
          <p className="text-xs text-muted-foreground">
            A new client number will be issued; {displayCode} is kept in their history.
          </p>
        )}
      </div>
    </Modal>
  );
}
