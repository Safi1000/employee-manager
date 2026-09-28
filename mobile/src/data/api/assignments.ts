// Assignments & Pay (web EmployeeAssignments.tsx). The load, the client → site
// grouping, the contracted-vs-enrolled reconciliation and the three writes (Edit
// rules, row edit, Assign employees) are ported from the web. Pay moves only
// through set_employee_salary; postings through deployments + the code RPCs.
import { q, rpc, sb, daysInCurrentMonth } from "./core";
import {
  activeCountByLine, addendumHeadcountDelta, CONTRACT_LINE_CATEGORY_LABEL, effectiveCommittedByCategory, effectiveCommittedForLine,
  isPersonnelCategory, PERSONNEL_LINE_CATEGORIES, standaloneAddendumHeadcount,
} from "../../lib/web/supabase";
import { isSeparatedState, lifecycleStatusLabel } from "../../lib/web/employmentWindow";
import { exportTable } from "../../lib/web/excel";

const todayIso = () => new Date().toISOString().slice(0, 10);
export const perDayOf = (base: number | null | undefined) => (base == null ? null : Math.round(Number(base) / daysInCurrentMonth()));
export const CATEGORY_LABEL: Record<string, string> = { client: "Client", office_staff: "Office Staff", reliever: "Reliever" };

export type ReconRow = { client_id: string; client_name: string; site_count: number; contracted_billed_qty: number; required_on_ground: number; enrolled_active: number; enrolled_total: number; variance: number };
export type EmpRow = any & { id: string; full_name: string };
export type SiteBucket = { id: string; name: string; rows: EmpRow[] };
export type Group = { key: string; label: string; clientId: string | null; categoryKey?: "office_staff" | "reliever"; hint: string; rows: EmpRow[]; siteBuckets?: SiteBucket[]; recon?: ReconRow; gap?: "contract" | "employees" };

export type AssignData = {
  locations: any[]; clients: any[]; branches: any[]; employees: EmpRow[]; contracts: any[]; contractLines: any[]; addendums: any[]; recon: ReconRow[];
  sites: { id: string; client_id: string; name: string }[]; siteByGuard: Map<string, string>; lastSiteByGuard: Map<string, string>;
};

export async function loadAssignments(regionId: string | null): Promise<AssignData> {
  const s = sb();
  let cliQ = s.from("clients").select("*").order("name");
  if (regionId) cliQ = cliQ.or(`branch_id.eq.${regionId},branch_id.is.null`);
  let empQ = s.from("employees").select("*, location:location_id(name), client:client_id(name), branch:branch_id(name)").order("full_name");
  if (regionId) empQ = empQ.eq("branch_id", regionId);
  const [locations, clients, branches, emps, eb, contracts, contractLines, addendums, recon, sites, deps] = await Promise.all([
    q<any[]>(s.from("locations").select("*").order("name")),
    q<any[]>(cliQ),
    q<any[]>(s.from("branches").select("*").order("is_head_office", { ascending: false }).order("name")),
    q<any[]>(empQ),
    q<any[]>(s.from("employee_branches").select("employee_id, branch_id")),
    q<any[]>(s.from("contracts").select("*").order("start_date", { ascending: false })),
    q<any[]>(s.from("contract_lines").select("*")),
    q<any[]>(s.from("contract_addendums").select("*")),
    q<ReconRow[]>(s.from("v_client_strength_reconciliation").select("*").order("client_name")),
    q<any[]>(s.from("sites").select("id, client_id, name").order("name")),
    q<any[]>(s.from("deployments").select("guard_id, site_id, start_date, end_date").range(0, 9999)),
  ]);
  const guardSite = new Map<string, string>();
  const lastSite = new Map<string, { site: string; end: string }>();
  for (const d of deps) {
    if (!d.site_id) continue;
    if (d.end_date === null) guardSite.set(d.guard_id, d.site_id);
    const end = d.end_date ?? "9999-12-31";
    const prev = lastSite.get(d.guard_id);
    if (!prev || end > prev.end) lastSite.set(d.guard_id, { site: d.site_id, end });
  }
  const addl = new Map<string, string[]>();
  for (const r of eb) addl.set(r.employee_id, [...(addl.get(r.employee_id) ?? []), r.branch_id]);
  return {
    locations, clients, branches, contracts, contractLines, addendums, recon, sites,
    employees: emps.map((e) => ({ ...e, location_name: e.location?.name ?? null, client_name: e.client?.name ?? null, branch_name: e.branch?.name ?? null, additional_branch_ids: addl.get(e.id) ?? [] })),
    siteByGuard: guardSite,
    lastSiteByGuard: new Map([...lastSite].map(([g, v]) => [g, v.site])),
  };
}

/** Everything the page derives from the load (the web's useMemos). */
export function derive(d: AssignData) {
  const clientById = new Map(d.clients.map((c) => [c.id, c]));
  const seen = new Map<string, boolean>();
  for (const c of d.contracts) seen.set(c.client_id, (seen.get(c.client_id) ?? true) && c.contract_type === "services");
  const servicesOnly = new Set([...seen].filter(([, only]) => only).map(([id]) => id));
  const today = todayIso();
  const liveContract = new Set<string>();
  for (const k of d.contracts) {
    if (k.status !== "active") continue;
    if (k.start_date && k.start_date > today) continue;
    if (!k.is_infinite && k.end_date && k.end_date < today) continue;
    liveContract.add(k.client_id);
  }
  const lineLabelById = new Map<string, string>(d.contractLines.map((l) => [l.id, (l.label ?? "").trim() || (CONTRACT_LINE_CATEGORY_LABEL as any)[l.category]]));
  const linesByContract = new Map<string, any[]>();
  for (const l of d.contractLines) linesByContract.set(l.contract_id, [...(linesByContract.get(l.contract_id) ?? []), l]);
  const soleCategoryByClient = new Map<string, string | null>();
  for (const k of d.contracts) {
    if (k.status !== "active") continue;
    const cats = new Set<string>();
    for (const l of linesByContract.get(k.id) ?? []) if (isPersonnelCategory(l.category)) cats.add(l.category);
    if (cats.size === 0) continue;
    const prev = soleCategoryByClient.get(k.client_id);
    const only = cats.size === 1 ? [...cats][0] : null;
    soleCategoryByClient.set(k.client_id, prev === undefined ? only : prev === only ? only : null);
  }
  const departmentOf = (e: EmpRow): string | null => {
    if (e.contract_line_id) return lineLabelById.get(e.contract_line_id) ?? null;
    if (!e.client_id) return null;
    const sole = soleCategoryByClient.get(e.client_id);
    return sole ? (CONTRACT_LINE_CATEGORY_LABEL as any)[sole] : null;
  };
  const displayCodeFor = (e: EmpRow) => {
    const fallback = e.guard_code ?? e.employee_code;
    if (e.display_number == null || !e.client_id) return fallback;
    const prefix = clientById.get(e.client_id)?.employee_id_prefix;
    return prefix ? `${prefix}-${String(e.display_number).padStart(3, "0")}` : fallback;
  };
  const addsFor = (contractId: string) => d.addendums.filter((a) => a.contract_id === contractId);
  const lineIsOpen = (l: any, onDate: string) => effectiveCommittedForLine(l, addsFor(l.contract_id), onDate) > 0;
  const filledToday = activeCountByLine(d.employees as any, todayIso());
  const slotForLine = (line: any, onDate: string) => {
    const committed = effectiveCommittedForLine(line, addsFor(line.contract_id), onDate);
    const filled = onDate === todayIso() ? filledToday.get(line.id) ?? 0 : activeCountByLine(d.employees as any, onDate).get(line.id) ?? 0;
    return { committed, filled };
  };
  const personnelLinesForSite = (clientId: string, siteId: string) => {
    const activeIds = new Set(d.contracts.filter((c) => c.client_id === clientId && c.status === "active").map((c) => c.id));
    return d.contractLines.filter((l) => activeIds.has(l.contract_id) && isPersonnelCategory(l.category) && (siteId === "" || l.site_id === siteId || l.site_id === null));
  };
  const committedPersonnelByClient = new Map<string, number>();
  for (const k of d.contracts) {
    if (k.status !== "active" || k.contract_type !== "guard_deployment") continue;
    const lines = linesByContract.get(k.id) ?? [];
    if (lines.length === 0) continue;
    const committed = effectiveCommittedByCategory(lines, addsFor(k.id), todayIso());
    let total = 0;
    for (const [cat, n] of committed) if (isPersonnelCategory(cat)) total += n;
    committedPersonnelByClient.set(k.client_id, (committedPersonnelByClient.get(k.client_id) ?? 0) + total);
  }
  const activeDeploymentIds = new Set(d.contracts.filter((c) => c.status === "active" && c.contract_type === "guard_deployment").map((c) => c.id));
  const requiredBySite = new Map<string, number>();
  for (const l of d.contractLines) {
    if (!l.site_id || !activeDeploymentIds.has(l.contract_id) || !isPersonnelCategory(l.category)) continue;
    requiredBySite.set(l.site_id, (requiredBySite.get(l.site_id) ?? 0) + effectiveCommittedForLine(l, addsFor(l.contract_id), todayIso()));
  }
  for (const a of d.addendums) {
    if (a.contract_line_id || !a.site_id || !a.category || !activeDeploymentIds.has(a.contract_id)) continue;
    if (!isPersonnelCategory(a.category) || a.effective_from > todayIso()) continue;
    requiredBySite.set(a.site_id, Math.max(0, (requiredBySite.get(a.site_id) ?? 0) + addendumHeadcountDelta(a)));
  }
  return { clientById, servicesOnly, liveContract, departmentOf, displayCodeFor, lineIsOpen, slotForLine, personnelLinesForSite, committedPersonnelByClient, requiredBySite };
}
export type Derived = ReturnType<typeof derive>;

export function buildGroups(d: AssignData, x: Derived, opts: { search: string; showFired: boolean; onlyMismatch: boolean; showServices: boolean }): Group[] {
  const qs = opts.search.trim().toLowerCase();
  const visible = d.employees.filter((e) => (opts.showFired ? isSeparatedState(e.lifecycle_state) : !isSeparatedState(e.lifecycle_state)));
  const byClient = new Map<string, EmpRow[]>();
  const office: EmpRow[] = [];
  const relievers: EmpRow[] = [];
  for (const e of visible) {
    const cat = e.category ?? "client";
    if (cat === "office_staff") office.push(e);
    else if (cat === "reliever") relievers.push(e);
    else if (e.client_id) byClient.set(e.client_id, [...(byClient.get(e.client_id) ?? []), e]);
  }
  const reconByClient = new Map(d.recon.map((r) => {
    const committed = x.committedPersonnelByClient.get(r.client_id) ?? 0;
    if (committed === 0) return [r.client_id, r] as const;
    return [r.client_id, { ...r, contracted_billed_qty: committed, required_on_ground: r.required_on_ground || committed, variance: committed - r.enrolled_active }] as const;
  }));
  const sitesByClient = new Map<string, { id: string; name: string }[]>();
  for (const st of d.sites) sitesByClient.set(st.client_id, [...(sitesByClient.get(st.client_id) ?? []), { id: st.id, name: st.name }]);

  const out: Group[] = d.clients.map((c) => {
    const rows = byClient.get(c.id) ?? [];
    const clientSites = sitesByClient.get(c.id) ?? [];
    let siteBuckets: SiteBucket[] | undefined;
    if (clientSites.length > 0) {
      const bySite = new Map<string, EmpRow[]>();
      for (const e of rows) {
        const sid = (opts.showFired ? d.lastSiteByGuard : d.siteByGuard).get(e.id) ?? "";
        bySite.set(sid, [...(bySite.get(sid) ?? []), e]);
      }
      siteBuckets = clientSites.map((st) => ({ id: st.id, name: st.name, rows: bySite.get(st.id) ?? [] }));
      const orphans = bySite.get("") ?? [];
      if (orphans.length) siteBuckets.push({ id: "", name: "No site recorded", rows: orphans });
      if (opts.showFired) siteBuckets = siteBuckets.filter((b) => b.rows.length > 0);
    }
    const hasContract = x.liveContract.has(c.id);
    const hasPeople = rows.length > 0;
    return {
      key: `client:${c.id}`, label: c.name, clientId: c.id, hint: c.employee_id_prefix ? `Prefix ${c.employee_id_prefix}` : "",
      rows, siteBuckets, recon: reconByClient.get(c.id),
      gap: hasContract && hasPeople ? undefined : hasContract ? "employees" : "contract",
    } as Group;
  });
  out.sort((a, b) => a.label.localeCompare(b.label));
  let officeBuckets: SiteBucket[] | undefined;
  if (d.branches.length > 0) {
    const byBranch = new Map<string, EmpRow[]>();
    for (const e of office) byBranch.set(e.branch_id ?? "", [...(byBranch.get(e.branch_id ?? "") ?? []), e]);
    officeBuckets = d.branches.map((b) => ({ id: b.id, name: b.name, rows: byBranch.get(b.id) ?? [] }));
    const unplaced = byBranch.get("") ?? [];
    if (unplaced.length) officeBuckets.push({ id: "", name: "No region recorded", rows: unplaced });
  }
  out.push({ key: "office", label: "Office Staff", clientId: null, categoryKey: "office_staff", hint: "By region", rows: office, siteBuckets: officeBuckets });
  out.push({ key: "relievers", label: "Relievers", clientId: null, categoryKey: "reliever", hint: "Relief pool", rows: relievers });
  let vis = opts.showServices ? out : out.filter((g) => !(g.clientId && x.servicesOnly.has(g.clientId)));
  vis = vis.filter((g) => !g.clientId || !(g.gap === "contract" && g.rows.length === 0));
  if (opts.showFired) vis = vis.filter((g) => g.rows.length > 0);
  if (qs) vis = vis.filter((g) => g.label.toLowerCase().includes(qs));
  if (opts.onlyMismatch) return vis.filter((g) => g.recon != null && g.recon.variance !== 0);
  return vis;
}

export function totals(d: AssignData, x: Derived, showServices: boolean) {
  return d.recon.filter((r) => showServices || !x.servicesOnly.has(r.client_id)).reduce((acc, r) => {
    acc.contracted += r.contracted_billed_qty; acc.enrolled += r.enrolled_active; acc.sites += r.site_count;
    if (r.variance !== 0) acc.mismatched += 1;
    return acc;
  }, { contracted: 0, enrolled: 0, sites: 0, mismatched: 0 });
}

export function exportAssignments(groups: Group[], x: Derived) {
  return exportTable({
    fileName: "assignments-and-pay", sheetName: "Assignments",
    headers: ["Group", "Sites", "Contracted", "On-ground req.", "Enrolled (active)", "Variance", "Code", "Name", "Category", "Client", "Location", "Branch", "Department", "Shift", "Base Salary", "Per Day", "Allowance", "Joined", "Status"],
    rows: groups.flatMap((g) => g.rows.map((e) => [
      g.label, g.recon?.site_count ?? "", g.recon?.contracted_billed_qty ?? "", g.recon?.required_on_ground ?? "", g.recon?.enrolled_active ?? "", g.recon?.variance ?? "",
      x.displayCodeFor(e), e.full_name, CATEGORY_LABEL[e.category ?? "client"], e.client_name ?? "", e.location_name ?? "", e.branch_name ?? "",
      x.departmentOf(e) ?? "", e.shift, e.base_salary ?? "", perDayOf(e.base_salary) ?? "", e.allowance ?? "", e.join_date ?? "", lifecycleStatusLabel(e),
    ])),
  });
}

// ------------------------------------------------------------- Edit rules
export type PayMode = "none" | "percent" | "flat" | "set";
export type PostRule = { baseMode: PayMode; baseValue: string; allowanceMode: PayMode; allowanceValue: string };
export const emptyRule = (): PostRule => ({ baseMode: "none", baseValue: "", allowanceMode: "none", allowanceValue: "" });
export type PostBucket = { key: string; label: string; category: string | null; rows: EmpRow[] };

export function applyPayMode(mode: PayMode, raw: string, current: number | null): number | null {
  if (mode === "none") return null;
  const v = Number(raw);
  if (raw === "" || isNaN(v)) return null;
  if (mode === "set") return Math.max(0, Math.round(v));
  const base = current ?? 0;
  if (mode === "percent") return Math.max(0, Math.round(base * (1 + v / 100)));
  return Math.max(0, Math.round(base + v));
}

const CATEGORY_RANK = new Map((PERSONNEL_LINE_CATEGORIES as readonly string[]).map((c, i) => [c, i]));

/** The web's post buckets: one per distinct post label on the lines staffing this site. */
export function postBuckets(lines: any[], allLines: any[], targets: EmpRow[]) {
  const lineById = new Map(allLines.map((l) => [l.id, l]));
  const relevant = [...lines];
  const seen = new Set(relevant.map((l) => l.id));
  for (const r of targets) {
    const id = r.contract_line_id;
    if (!id || seen.has(id)) continue;
    const l = lineById.get(id);
    if (l) { relevant.push(l); seen.add(id); }
  }
  const byLabel = new Map<string, { key: string; label: string; category: string; rank: number; rows: EmpRow[] }>();
  const postOfLine = new Map<string, string>();
  for (const l of relevant) {
    const label = (l.label ?? "").trim() || (CONTRACT_LINE_CATEGORY_LABEL as any)[l.category];
    const key = label.toLowerCase();
    const rank = CATEGORY_RANK.get(l.category) ?? 99;
    const existing = byLabel.get(key);
    if (existing) existing.rank = Math.min(existing.rank, rank);
    else byLabel.set(key, { key, label, category: l.category, rank, rows: [] });
    postOfLine.set(l.id, key);
  }
  const leftover: EmpRow[] = [];
  for (const r of targets) {
    const post = r.contract_line_id ? postOfLine.get(r.contract_line_id) : undefined;
    if (post) byLabel.get(post)!.rows.push(r); else leftover.push(r);
  }
  const out: PostBucket[] = [...byLabel.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)).map((dd) => ({ key: dd.key, label: dd.label, category: dd.category, rows: dd.rows }));
  if (leftover.length > 0) {
    if (out.length === 1) out[0] = { ...out[0], rows: [...out[0].rows, ...leftover] };
    else out.push({ key: "__unposted", label: "Not on a contract line", category: null, rows: leftover });
  }
  return { buckets: out.filter((b) => b.rows.length > 0), emptyPosts: out.filter((b) => b.rows.length === 0).map((b) => b.label) };
}

export type PayChange = { employee: EmpRow; base: number; allowance: number };
const curPay = (e: EmpRow) => ({ base: e.base_salary != null ? Math.round(Number(e.base_salary)) : 0, allowance: e.allowance != null ? Math.round(Number(e.allowance)) : 0 });

export function fixedChanges(buckets: PostBucket[], rules: Record<string, PostRule>): PayChange[] {
  const out: PayChange[] = [];
  for (const b of buckets) {
    const r = rules[b.key];
    if (!r || (r.baseMode === "none" && r.allowanceMode === "none")) continue;
    for (const e of b.rows) {
      const nb = applyPayMode(r.baseMode, r.baseValue, e.base_salary);
      const na = applyPayMode(r.allowanceMode, r.allowanceValue, e.allowance);
      if (nb == null && na == null) continue;
      const cur = curPay(e);
      out.push({ employee: e, base: nb ?? cur.base, allowance: na ?? cur.allowance });
    }
  }
  return out;
}
export function variableChanges(buckets: PostBucket[], drafts: Record<string, { base: string; allowance: string }>): PayChange[] {
  const out: PayChange[] = [];
  for (const b of buckets) for (const e of b.rows) {
    const dd = drafts[e.id];
    if (!dd) continue;
    const cur = curPay(e);
    const base = dd.base === "" ? cur.base : Math.max(0, Math.round(Number(dd.base)));
    const allowance = dd.allowance === "" ? cur.allowance : Math.max(0, Math.round(Number(dd.allowance)));
    if (!Number.isFinite(base) || !Number.isFinite(allowance)) continue;
    if (base === cur.base && allowance === cur.allowance) continue;
    out.push({ employee: e, base, allowance });
  }
  return out;
}

export type OtherState = { effectiveDate: string; reason: string; setLocation: boolean; locationId: string; setBranch: boolean; branchId: string; setJoinDate: boolean; joinDate: string };
export const emptyOther = (): OtherState => ({ effectiveDate: todayIso(), reason: "Increment", setLocation: false, locationId: "", setBranch: false, branchId: "", setJoinDate: false, joinDate: "" });

export async function applyRules(targets: EmpRow[], payChanges: PayChange[], other: OtherState, onProgress: (n: number) => void) {
  const patch: Record<string, unknown> = {};
  if (other.setLocation) patch.location_id = other.locationId || null;
  if (other.setBranch) patch.branch_id = other.branchId || null;
  if (other.setJoinDate) patch.join_date = other.joinDate || null;
  const hasField = Object.keys(patch).length > 0;
  if (!payChanges.length && !hasField) throw new Error("Nothing to apply — set a rule or change a figure, or tick a field to update.");
  if (payChanges.length && !other.effectiveDate) throw new Error("Pick an effective date for the pay change.");
  if (hasField) await q(sb().from("employees").update(patch as never).in("id", targets.map((t) => t.id)));
  for (let i = 0; i < payChanges.length; i++) {
    const c = payChanges[i];
    try {
      await rpc("set_employee_salary", {
        p_employee_id: c.employee.id, p_effective_date: other.effectiveDate, p_base_salary: c.base, p_allowance: c.allowance,
        p_per_day_salary: c.base / daysInCurrentMonth(), p_reason: other.reason.trim() || "Increment",
      });
    } catch (e) { throw new Error(`${c.employee.full_name}: ${(e as Error).message}`); }
    onProgress(i + 1);
  }
  const bits: string[] = [];
  if (payChanges.length) bits.push(`pay updated for ${payChanges.length}`);
  if (hasField) bits.push(`details updated for ${targets.length}`);
  return bits.join(", ");
}

// --------------------------------------------------------------- Row edit
export function deptOptions(lineOptions: any[], x: Derived, heldLineId: string) {
  const byCat = new Map<string, { committed: number; filled: number; lines: any[] }>();
  for (const l of lineOptions) {
    const s = x.slotForLine(l, todayIso());
    const g = byCat.get(l.category) ?? { committed: 0, filled: 0, lines: [] };
    g.committed += s.committed; g.filled += s.filled; g.lines.push(l);
    byCat.set(l.category, g);
  }
  return [...byCat.entries()].map(([category, g]) => {
    const held = g.lines.find((l) => l.id === heldLineId);
    const rep = held ?? [...g.lines].sort((a, b) => (Number(b.committed_count) || 0) - (Number(a.committed_count) || 0))[0];
    return { category, label: (CONTRACT_LINE_CATEGORY_LABEL as any)[category] as string, committed: g.committed, filled: g.filled, lineId: rep.id as string, full: !held && g.filled >= g.committed };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/** The line options RowEditModal is mounted with: posts at their own site that are open, plus the one they hold. */
export function rowLineOptions(d: AssignData, x: Derived, e: EmpRow) {
  if (!e.client_id) return [];
  const held = e.contract_line_id;
  const atSite = x.personnelLinesForSite(e.client_id, d.siteByGuard.get(e.id) ?? "").filter((l) => l.id === held || x.lineIsOpen(l, todayIso()));
  if (held && !atSite.some((l) => l.id === held)) {
    const elsewhere = d.contractLines.find((l) => l.id === held);
    if (elsewhere) return [elsewhere, ...atSite];
  }
  return atSite;
}

export async function saveRowEdit(e: EmpRow, args: { joinDate: string; shift: string; category: string; lineId: string; canPickLine: boolean; depts: ReturnType<typeof deptOptions> }) {
  const heldLineId = e.contract_line_id ?? "";
  const neverPosted = !e.client_id;
  if (args.canPickLine && args.lineId && args.lineId !== heldLineId) {
    const picked = args.depts.find((dd) => dd.lineId === args.lineId);
    if (picked && picked.full) {
      throw new Error(`${picked.label} is full — the contract commits ${picked.committed} and ${picked.filled} ${picked.filled === 1 ? "is" : "are"} already in it. Raise the headcount on the contract, or add an addendum, before moving anyone in.`);
    }
  }
  await q(sb().from("employees").update({
    join_date: args.joinDate || null,
    ...(neverPosted ? { shift: args.shift, category: args.category } : {}),
    ...(args.canPickLine ? { contract_line_id: args.lineId || null } : {}),
  } as never).eq("id", e.id));
  if (args.canPickLine && args.lineId !== heldLineId) {
    await q(sb().from("deployments").update({ contract_line_id: args.lineId || null } as never).eq("guard_id", e.id).is("end_date", null));
  }
}

// --------------------------------------------------------- Assign employees
export type AssignTarget =
  | { kind: "client"; id: string; name: string; siteId: string | null; siteName: string | null }
  | { kind: "category"; category: "office_staff" | "reliever"; name: string; branchId?: string | null; branchName?: string | null };

export type OfferedGroup = { key: string; label: string; category: string; lines: any[]; addendumIds?: string[] };

export function offeredGroups(d: AssignData, contractId: string, siteId: string | null, asOf: string): OfferedGroup[] {
  const lines = contractId ? d.contractLines.filter((l) => l.contract_id === contractId) : [];
  const adds = d.addendums.filter((a) => a.contract_id === contractId);
  const offered = lines.filter((l) => (!siteId || l.site_id === siteId || l.site_id === null) && effectiveCommittedForLine(l, adds, asOf) > 0);
  const m = new Map<string, OfferedGroup>();
  for (const l of offered) {
    const label = (l.label ?? "").trim() || (CONTRACT_LINE_CATEGORY_LABEL as any)[l.category];
    const key = label.toLowerCase();
    const g = m.get(key) ?? ({ key, label, category: l.category, lines: [] as any[] } as OfferedGroup);
    g.lines.push(l);
    m.set(key, g);
  }
  if (siteId) {
    const lineCats = new Set(offered.map((l) => l.category));
    const byCat = new Map<string, string[]>();
    for (const a of d.addendums) {
      if (a.contract_id !== contractId || a.contract_line_id || a.change_type !== "ADD_HEADCOUNT") continue;
      if (a.site_id !== siteId || !a.category || !isPersonnelCategory(a.category) || lineCats.has(a.category)) continue;
      byCat.set(a.category, [...(byCat.get(a.category) ?? []), a.id]);
    }
    for (const [category, addendumIds] of byCat) {
      if (standaloneAddendumHeadcount(adds, category as never, siteId, asOf) <= 0) continue;
      const key = `addendum:${category}`;
      m.set(key, { key, label: `${(CONTRACT_LINE_CATEGORY_LABEL as any)[category]} (addendum)`, category, lines: [], addendumIds });
    }
  }
  return [...m.values()];
}

export async function addendumFilledCounts(groups: OfferedGroup[], asOf: string) {
  const withIds = groups.filter((g) => g.addendumIds?.length);
  const out = new Map<string, number>();
  if (withIds.length === 0) return out;
  const rows = await q<any[]>(sb().from("deployments").select("guard_id, contract_addendum_id").in("contract_addendum_id", withIds.flatMap((g) => g.addendumIds!))
    .lte("start_date", asOf).or(`end_date.is.null,end_date.gte.${asOf}`));
  for (const g of withIds) {
    const set = new Set(g.addendumIds!);
    out.set(g.key, new Set(rows.filter((r) => set.has(r.contract_addendum_id)).map((r) => r.guard_id)).size);
  }
  return out;
}

export function slotForGroup(d: AssignData, g: OfferedGroup, contractId: string, siteId: string | null, asOf: string, addendumFilled: Map<string, number>) {
  const adds = d.addendums.filter((a) => a.contract_id === contractId);
  if (g.addendumIds) {
    const committed = Math.max(0, standaloneAddendumHeadcount(adds, g.category as never, siteId ?? null, asOf));
    const filled = addendumFilled.get(g.key) ?? 0;
    return { category: g.category, committed, filled, available: Math.max(0, committed - filled) };
  }
  const byLine = activeCountByLine(d.employees as any, asOf);
  let committed = 0, filled = 0;
  for (const l of g.lines) { committed += effectiveCommittedForLine(l, adds, asOf); filled += byLine.get(l.id) ?? 0; }
  committed = Math.max(0, committed + standaloneAddendumHeadcount(adds, g.category as never, siteId ?? null, asOf));
  return { category: g.category, committed, filled, available: Math.max(0, committed - filled) };
}

export async function assignEmployees(target: AssignTarget, targets: EmpRow[], args: {
  startDate: string; contractId: string; groupKey: string; groups: OfferedGroup[]; slot: ReturnType<typeof slotForGroup> | null;
  clientContracts: number; shift: string; baseSalary: string; allowance: string;
}, onProgress: (n: number) => void) {
  const toClient = target.kind === "client";
  if (targets.length === 0) throw new Error("Pick at least one employee.");
  if (!args.startDate) throw new Error("A joining date is required.");
  if (toClient && args.clientContracts > 0 && !args.contractId) throw new Error("Choose which contract this posting is under.");
  if (toClient && args.groups.length > 0 && !args.groupKey) throw new Error("Choose a post — it sets the category and its headcount limit.");
  if (args.slot && targets.length > args.slot.available) {
    throw new Error(`${(CONTRACT_LINE_CATEGORY_LABEL as any)[args.slot.category]}: only ${args.slot.available} of ${args.slot.committed} slot${args.slot.committed === 1 ? "" : "s"} free on this contract (${args.slot.filled} already filled). Raise the committed count with an addendum to post more.`);
  }
  const base = args.baseSalary ? Number(args.baseSalary) : null;
  if (base != null && (isNaN(base) || base <= 0)) throw new Error("Enter a valid base salary, or leave it blank.");
  const salary = async (id: string) => {
    if (base == null) return;
    await rpc("set_employee_salary", {
      p_employee_id: id, p_effective_date: args.startDate, p_base_salary: base, p_allowance: args.allowance ? Math.max(0, Number(args.allowance)) : 0,
      p_per_day_salary: base / daysInCurrentMonth(), p_reason: "Initial salary",
    });
  };
  let postSiteId: string | null = target.kind === "client" ? target.siteId : null;
  if (target.kind === "client" && !postSiteId) {
    const def = await q<any>(sb().from("sites").select("id").eq("client_id", target.id).eq("is_default", true).maybeSingle());
    postSiteId = def?.id ?? null;
  }
  const grp = args.groups.find((g) => g.key === args.groupKey) ?? null;
  const lineForShift = (empShift: string): string | null => {
    if (!grp || grp.lines.length === 0) return null;
    if (grp.lines.length === 1) return grp.lines[0].id;
    return (grp.lines.find((l) => (l.shift_code ?? "") === empShift) ?? grp.lines[0]).id;
  };
  let done = 0;
  try {
    for (const e of targets) {
      try {
        if (target.kind === "category") {
          await rpc("change_category", { p_guard_id: e.id, p_new_category: target.category, p_new_client_id: null, p_contract_line_id: null, p_effective_date: args.startDate });
          const patch: Record<string, unknown> = {};
          if (args.shift) patch.shift = args.shift;
          if (target.branchId) patch.branch_id = target.branchId;
          if (Object.keys(patch).length) await q(sb().from("employees").update(patch as never).eq("id", e.id));
          await salary(e.id);
        } else {
          const empShift = args.shift || e.shift || "day";
          const lineId = lineForShift(empShift);
          await q(sb().from("deployments").insert({
            guard_id: e.id, client_id: target.id, contract_line_id: lineId, contract_addendum_id: lineId ? null : grp?.addendumIds?.[0] ?? null,
            site_id: postSiteId, start_date: args.startDate, shift_code: empShift, reason: "new_hire",
          } as never));
          await q(sb().from("employees").update({
            category: "client", join_date: e.join_date ?? args.startDate, contract_id: args.contractId || null, contract_line_id: lineId,
            assignment_effective_from: lineId ? args.startDate : null, assignment_effective_to: null, ...(args.shift ? { shift: args.shift } : {}),
          } as never).eq("id", e.id));
          if (!e.guard_code) await rpc("assign_guard_code", { p_employee_id: e.id });
          await rpc("assign_display_number", { p_employee_id: e.id });
          await salary(e.id);
        }
      } catch (x) { throw new Error(`${e.full_name}: ${(x as Error).message}`); }
      done++;
      onProgress(done);
    }
  } catch (x) {
    throw new Error(done > 0 ? `${(x as Error).message} — ${done} already assigned before this failed.` : (x as Error).message);
  }
  return `${targets.length} employee${targets.length === 1 ? "" : "s"} assigned to ${target.name}.`;
}
