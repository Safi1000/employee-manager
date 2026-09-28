// Demo fixtures. Field names follow the web app's row types in src/app/lib/supabase.ts
// so swapping a fixture for `supabase.from(...)` is a data-layer change, not a UI one.
// Everything here is generated deterministically relative to today.
import { addDays, iso } from "../lib/format";
import type { UserRole } from "../lib/permissions";
import { isLive } from "../lib/supabase";

// ---------- deterministic rng ----------
let seed = 20260925;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

export const TODAY = iso(new Date());
export const THIS_MONTH = TODAY.slice(0, 7);
const prevMonth = (ym: string, n = 1) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y!, m! - 1 - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
export const LAST_MONTH = prevMonth(THIS_MONTH);
export const monthsBack = (n: number) => Array.from({ length: n }, (_, i) => prevMonth(THIS_MONTH, i));

// ---------- types ----------
export type Shift = "day" | "night" | "evening";
export type Branch = { raw?: any; id: string; name: string; kind: "regional" | "head_office"; code: string; ho_excluded: boolean };
export type Client = { raw?: any;
  id: string; name: string; code: string; industry: string; branch_id: string; status: "active" | "inactive";
  invoice_group: "FIXED" | "VARIABLE"; ntn: string; strn: string; filer: "filer" | "non_filer"; billing_email: string;
  phone: string; signatory: string; address: string; bank: { title: string; account: string; bank: string };
  tax_lines: { name: string; rate: number; direction: "ADDED" | "WITHHELD" }[]; notes: string;
};
export type Site = { raw?: any; id: string; client_id: string; name: string; area: string; shifts: { shift: Shift; contracted: number }[] };
export type ContractLine = { raw?: any; id: string; category: string; notes: string; committed: number; rate: number; active: number };
export type Contract = { raw?: any;
  id: string; code: string; client_id: string; type: "services" | "guard_deployment"; start: string; end: string;
  status: "active" | "expired" | "terminated" | "draft"; lines: ContractLine[]; weapons: string; document: boolean;
  addendums: { effective: string; change: string; line: string; shift: Shift; source: string; reference: string }[];
};
export type Lifecycle = "active" | "waiting_rehire" | "waiting_fresh" | "terminated";
export type Employee = { raw?: any;
  id: string; code: string; permanent_code: string; name: string; father_name: string; phone: string; cnic: string;
  cnic_expiry: string | null; dob: string; category: "client" | "office_staff" | "reliever"; department: string;
  client_id: string | null; site_id: string | null; line_id: string | null; shift: Shift; branch_id: string;
  lifecycle: Lifecycle; status: "Active" | "On Leave" | "Inactive" | "Fired"; join_date: string | null; left_on: string | null;
  base: number; allowance: number; per_day: number; pay_mode: "fixed" | "variable"; physical_copy: boolean;
  incomplete: string[]; verified: boolean; bank: string; account: string; address: string; blood_group: string;
  ex_service: boolean; police_verification: "pending" | "cleared" | "adverse"; verisys: "pending" | "cleared" | "adverse";
  emergency_name: string; emergency_phone: string; education: string; warnings: number;
};
export type AttStatus = "present" | "absent" | "leave" | "double_duty" | "rest_day" | "relief_cover";
export type SiteReport = { site_id: string; shift: Shift; state: "awaiting" | "reported" | "confirmed"; supervisor: string; at: string | null };
export type Incident = { raw?: any;
  id: string; code: string; occurred_at: string; client_id: string; site_id: string; severity: "low" | "medium" | "high" | "critical";
  category: string; description: string; response: string; guards: string[]; status: "open" | "under_investigation" | "resolved" | "closed";
};
export type Invoice = { raw?: any;
  id: string; number: string; client_id: string; contract_id: string; month: string; amount: number; date: string;
  status: "Pending" | "Delivered" | "Unpaid" | "Partly-Paid" | "Paid"; attachment: boolean; notes: string;
  payments: { id: string; date: string; amount: number; mode: "Bank" | "Cash" | "Cheque"; notes: string; wht: number }[];
};
export type Payslip = { raw?: any;
  id: string; employee_id: string; month: string; working: number; present: number; double_duty: number; absent: number;
  leave: number; base: number; allowance: number; bonus: number; advance: number; deductions: number; net: number;
  status: "Pending" | "Cleared"; mode: "Cash" | "Bank" | "Cheque" | null; paid_on: string | null;
};
export type Expense = { raw?: any;
  id: string; date: string; category: string; client_id: string | null; vendor: string; description: string; amount: number;
  mode: "Cash" | "Bank" | "Cheque" | "Payable"; by: string; approved: boolean; nature: "Cost of Services" | "Operating Expense";
};
export type Advance = { raw?: any; id: string; date: string; employee_id: string; amount: number; mode: "Cash" | "Bank"; paid_by: string; notes: string; recovered: number };
export type FixedDef = { id: string; description: string; category: string; party: string; mode: string; paid_by: string; amount: number; runs: string };
export type FixedInstance = { id: string; def_id: string; month: string; amount: number; status: "Awaiting" | "Approved" | "Denied" };
export type Bank = { raw?: any; id: string; name: string; number: string; type: "Current" | "Savings"; owner: string; balance: number; cheque_balance: number };
export type Cheque = { raw?: any;
  id: string; number: string; type: "payment" | "deposit"; bank_id: string; date: string; party: string; amount: number;
  linked: string; status: "pending" | "cleared" | "bounced";
};
export type Deposit = { id: string; slip: string; bank_id: string; date: string; amount: number; by: string; ref: string };
export type Custodian = { raw?: any; id: string; location: string; type: "Office" | "Partner" | "Site"; holder: string; opening: number; held: number; active: boolean };
export type Txn = { id: string; date: string; kind: string; account: string; delta: number; before: number; after: number; description: string };
export type Payable = { raw?: any; id: string; vendor: string; category: string; client_id: string | null; amount: number; expense_date: string; due: string; status: "Pending" | "Overdue" | "Paid" };
export type Account = { raw?: any; code: string; name: string; type: "asset" | "liability" | "equity" | "revenue" | "expense"; parent: string | null; control: boolean; system: boolean };
export type JournalEntry = { id: string; date: string; ref: string; source: string; memo: string; lines: { account: string; debit: number; credit: number }[] };
export type Task = { raw?: any; id: string; title: string; description: string; assignee: string; due: string; status: "todo" | "in_progress" | "done"; priority: "low" | "medium" | "high" | "urgent" };
export type ImportantDate = { raw?: any; id: string; title: string; date: string; category: string; notice: number; priority: "low" | "medium" | "high" | "critical" };
export type RecurringAlert = { raw?: any; id: string; name: string; category: string; frequency: string; trigger_day: number; notice: number; active: boolean };
export type Licence = { raw?: any; id: string; item: string; category: string; expiry: string; authority: string };
export type StockItem = { raw?: any; id: string; name: string; kind: "weapon" | "uniform" | "equipment"; qty: number; issued: number; cost: number; replacement: number; serialised: boolean };
export type Holding = { raw?: any; id: string; employee_id: string; item_id: string; serial: string; condition: "Good" | "Fair" | "Damaged"; since: string };
export type AppUser = { raw?: any; id: string; name: string; email: string; title: string; role: UserRole; branch_id: string | null; permissions: string[]; employee_id: string | null; active: boolean };
export type AuditEntry = { raw?: any; id: string; at: string; user: string; action: "insert" | "update" | "delete"; table: string; record: string; fields: Record<string, { before?: unknown; after?: unknown }> };
export type Partner = { raw?: any; id: string; name: string; scope: string; method: "Fixed %" | "Pool"; share: number; status: "active" | "inactive"; allocated: number; contributed: number; drawn: number };

// ---------- reference data ----------
export const company = { id: "co1", name: "Guardian Global Security", short: "GGS", plan: "Growth", guard_cap: 250, theme: null as string | null, raw: null as any };

export const branches: Branch[] = [
  { id: "b1", name: "Lahore", kind: "regional", code: "LHR", ho_excluded: false },
  { id: "b2", name: "Karachi", kind: "regional", code: "KHI", ho_excluded: false },
  { id: "b3", name: "Islamabad HO", kind: "head_office", code: "ISB", ho_excluded: true },
];

const CLIENT_DEFS: [string, string, string, string][] = [
  ["Meridian Textiles", "MTX", "Manufacturing", "b1"],
  ["Crescent Bank — Gulberg", "CBG", "Banking", "b1"],
  ["Nishat Cold Storage", "NCS", "Logistics", "b1"],
  ["Harbour Freight Terminal", "HFT", "Logistics", "b2"],
  ["Sapphire Mall", "SPM", "Retail", "b2"],
  ["Indus Pharma", "INP", "Pharmaceuticals", "b2"],
  ["Capital Diplomatic Enclave", "CDE", "Government", "b3"],
  ["Margalla Heights School", "MHS", "Education", "b3"],
];

export const clients: Client[] = CLIENT_DEFS.map(([name, code, industry, branch], i) => ({
  id: `c${i + 1}`, name, code, industry, branch_id: branch, status: i === 7 ? "inactive" : "active",
  invoice_group: i % 3 === 0 ? "VARIABLE" : "FIXED",
  ntn: `${int(1000000, 9999999)}-${int(1, 9)}`, strn: `32-77-${int(1000, 9999)}-${int(100, 999)}-${int(10, 99)}`,
  filer: i % 4 === 3 ? "non_filer" : "filer", billing_email: `accounts@${code.toLowerCase()}.pk`,
  phone: `+92 3${int(0, 4)}${int(0, 9)} ${int(1000000, 9999999)}`, signatory: pick(["Asad Mahmood", "Rabia Khan", "Imran Siddiqui", "Farah Naqvi", "Omar Latif"]),
  address: pick(["Plot 14, Industrial Estate", "Main Boulevard", "Port Qasim Zone B", "Blue Area, Jinnah Ave", "Sector G-7"]) + ", " + (branch === "b1" ? "Lahore" : branch === "b2" ? "Karachi" : "Islamabad"),
  bank: { title: name, account: `PK${int(10, 99)}HABB00${int(10000000, 99999999)}`, bank: pick(["HBL", "Meezan", "UBL", "Allied"]) },
  tax_lines: [{ name: "Sales tax (PST)", rate: 16, direction: "ADDED" }, { name: "Withholding", rate: i % 2 ? 4.5 : 3, direction: "WITHHELD" }],
  notes: i === 1 ? "Armed guards only at vault. Cash-in-transit escorts billed separately." : "",
}));

const SITE_NAMES: Record<string, string[]> = {
  c1: ["Main Mill Gate", "Warehouse 3"], c2: ["Gulberg Branch", "Vault Annex"], c3: ["Cold Store A"],
  c4: ["Berth 7 Gate", "Container Yard", "Admin Block"], c5: ["Mall Entrances", "Parking Deck"], c6: ["Plant Perimeter"],
  c7: ["Enclave Gate 2"], c8: ["Junior Campus"],
};
export const sites: Site[] = Object.entries(SITE_NAMES).flatMap(([cid, names], ci) =>
  names.map((n, i) => ({
    id: `${cid}s${i + 1}`, client_id: cid, name: n, area: pick(["North", "East", "Central", "Riverside", "Sector 4"]),
    shifts: ci % 3 === 2 ? [{ shift: "day" as Shift, contracted: int(2, 4) }] : [
      { shift: "day" as Shift, contracted: int(2, 5) }, { shift: "night" as Shift, contracted: int(2, 4) },
    ],
  })),
);

export const contracts: Contract[] = clients.map((c, i) => {
  const cs = sites.filter((s) => s.client_id === c.id);
  const guards = cs.reduce((a, s) => a + s.shifts.reduce((b, x) => b + x.contracted, 0), 0);
  const armed = Math.max(1, Math.round(guards * 0.3));
  const start = `${2025 + (i % 2)}-${String((i % 12) + 1).padStart(2, "0")}-01`;
  const endDays = i === 2 ? 18 : i === 5 ? 44 : 200 + i * 30;
  return {
    id: `k${i + 1}`, code: `GGS-${c.code}-${String(24 + (i % 3)).padStart(2, "0")}`, client_id: c.id,
    type: i % 2 ? "services" : "guard_deployment", start, end: i === 7 ? addDays(TODAY, -40) : addDays(TODAY, endDays),
    status: i === 7 ? "expired" : "active",
    lines: [
      { id: `k${i + 1}l1`, category: "Unarmed guard", notes: "12-hour shift", committed: guards - armed, rate: 42000, active: guards - armed - (i % 3 === 0 ? 1 : 0) },
      { id: `k${i + 1}l2`, category: "Armed guard", notes: "Licensed weapon", committed: armed, rate: 52000, active: armed },
      ...(i % 3 === 1 ? [{ id: `k${i + 1}l3`, category: "Supervisor", notes: "Roving", committed: 1, rate: 68000, active: 1 }] : []),
    ],
    weapons: `${armed}× 12-bore, ${armed} walkie-talkies`, document: i !== 4,
    addendums: i === 3 ? [{ effective: addDays(TODAY, -60), change: "ADD_HEADCOUNT", line: "Unarmed guard", shift: "night", source: "EMAIL", reference: "HFT/OPS/211" }] : [],
  };
});

// ---------- people ----------
const FIRST = ["Muhammad", "Ali", "Usman", "Bilal", "Hamza", "Zeeshan", "Imran", "Kashif", "Naveed", "Sajid", "Tariq", "Waqas",
  "Adnan", "Faisal", "Shahid", "Arshad", "Javed", "Rizwan", "Asif", "Nadeem", "Irfan", "Khalid", "Amir", "Rashid", "Sohail"];
const LAST = ["Khan", "Ahmed", "Hussain", "Iqbal", "Malik", "Butt", "Chaudhry", "Raza", "Shah", "Abbasi", "Qureshi", "Akhtar", "Mirza", "Aslam", "Javed"];

const makeEmployee = (i: number, over: Partial<Employee>): Employee => {
  const first = FIRST[i % FIRST.length]!;
  const last = LAST[(i * 7) % LAST.length]!;
  const base = pick([36000, 38000, 40000, 42000, 45000]);
  return {
    id: `e${i + 1}`, code: `GGS-${String(1001 + i)}`, permanent_code: `P${String(5000 + i)}`, name: `${first} ${last}`,
    father_name: `${pick(FIRST)} ${last}`, phone: `03${int(0, 4)}${int(0, 9)}${int(1000000, 9999999)}`,
    cnic: `35${int(100, 999)}-${int(1000000, 9999999)}-${int(1, 9)}`,
    cnic_expiry: i % 13 === 5 ? addDays(TODAY, -int(5, 90)) : i % 11 === 3 ? null : addDays(TODAY, int(60, 2000)),
    dob: `19${int(72, 99)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`,
    category: "client", department: "Security Guard", client_id: null, site_id: null, line_id: null, shift: "day", branch_id: "b1",
    lifecycle: "active", status: "Active", join_date: addDays(TODAY, -int(40, 1400)), left_on: null,
    base, allowance: pick([0, 2000, 3000, 5000]), per_day: Math.round(base / 30), pay_mode: i % 5 === 0 ? "variable" : "fixed",
    physical_copy: i % 4 !== 1, incomplete: i % 9 === 4 ? ["Bank account", "Emergency contact"] : i % 11 === 3 ? ["CNIC expiry"] : [],
    verified: i % 6 !== 2, bank: pick(["HBL", "Meezan", "JazzCash", "UBL"]), account: `${int(1000, 9999)}${int(100000, 999999)}`,
    address: `House ${int(1, 300)}, ${pick(["Township", "Samanabad", "Korangi", "Gulshan", "G-9", "Shadman"])}`,
    blood_group: pick(["A+", "B+", "O+", "AB+", "O−"]), ex_service: i % 7 === 0,
    police_verification: i % 10 === 6 ? "pending" : "cleared", verisys: i % 8 === 5 ? "pending" : "cleared",
    emergency_name: `${pick(FIRST)} ${last}`, emergency_phone: `03${int(0, 4)}${int(0, 9)}${int(1000000, 9999999)}`,
    education: pick(["Matric", "Middle", "Intermediate", "Primary"]), warnings: i % 12 === 7 ? 1 : 0,
    ...over,
  };
};

export const employees: Employee[] = (() => {
  const out: Employee[] = [];
  let i = 0;
  for (const s of sites) {
    const client = clients.find((c) => c.id === s.client_id)!;
    const k = contracts.find((c) => c.client_id === s.client_id)!;
    for (const sh of s.shifts) {
      for (let n = 0; n < sh.contracted; n++) {
        if (s.id === "c4s2" && sh.shift === "night" && n === sh.contracted - 1) continue; // an open vacancy
        const armed = n === 0 && k.lines[1];
        out.push(makeEmployee(i++, {
          client_id: s.client_id, site_id: s.id, shift: sh.shift, branch_id: client.branch_id,
          line_id: armed ? k.lines[1]!.id : k.lines[0]!.id, department: armed ? "Armed Guard" : "Security Guard",
          status: client.status === "inactive" ? "Inactive" : i % 17 === 9 ? "On Leave" : "Active",
        }));
      }
    }
  }
  out.push(makeEmployee(i++, { category: "office_staff", department: "Operations Supervisor", branch_id: "b1", base: 85000, allowance: 10000 }));
  out.push(makeEmployee(i++, { category: "office_staff", department: "Accounts Officer", branch_id: "b3", base: 95000, allowance: 8000 }));
  out.push(makeEmployee(i++, { category: "office_staff", department: "HR Executive", branch_id: "b2", base: 78000, allowance: 6000 }));
  out.push(makeEmployee(i++, { category: "office_staff", department: "Driver", branch_id: "b1", base: 42000, allowance: 4000 }));
  for (let r = 0; r < 4; r++) out.push(makeEmployee(i++, { category: "reliever", department: "Reliever", branch_id: r % 2 ? "b2" : "b1", pay_mode: "variable" }));
  for (let w = 0; w < 3; w++) out.push(makeEmployee(i++, { lifecycle: w === 0 ? "waiting_rehire" : "waiting_fresh", status: "Inactive", join_date: w === 0 ? "2024-02-11" : null }));
  for (let f = 0; f < 3; f++) out.push(makeEmployee(i++, { lifecycle: "terminated", status: "Fired", left_on: addDays(TODAY, -int(3, 70)), client_id: "c1", site_id: "c1s1" }));
  return out;
})();

export const empName = (id: string) => employees.find((e) => e.id === id)?.name ?? "—";

// ---------- attendance ----------
// Deterministic day status per guard; today's exceptions are a small set.
export const statusFor = (empId: string, date: string): AttStatus | null => {
  const n = Number(empId.slice(1)) * 31 + Number(date.slice(8, 10)) * 7 + Number(date.slice(5, 7));
  if (date > TODAY) return null;
  const r = (n * 2654435761) % 100;
  if (r < 4) return "absent";
  if (r < 7) return "leave";
  if (r < 9) return "double_duty";
  if (r < 11) return "rest_day";
  return "present";
};

export const siteReports: SiteReport[] = sites.flatMap((s, i) =>
  s.shifts.map((sh) => ({
    site_id: s.id, shift: sh.shift,
    state: (i % 4 === 0 ? "confirmed" : i % 4 === 1 ? "reported" : i % 4 === 2 && sh.shift === "day" ? "confirmed" : "awaiting") as SiteReport["state"],
    supervisor: pick(["Naveed Akhtar", "Sajid Raza", "Tariq Malik"]),
    at: i % 4 === 3 ? null : `${TODAY}T0${int(6, 9)}:${int(10, 59)}:00`,
  })),
);

export const vacancies = [
  { id: "v1", client_id: "c4", site_id: "c4s2", shift: "night" as Shift, reason: "Guard resigned — Container Yard night", opened: addDays(TODAY, -4) },
  { id: "v2", client_id: "c1", site_id: "c1s1", shift: "day" as Shift, reason: "Fired: Waqas Akhtar (misconduct)", opened: addDays(TODAY, -9) },
  { id: "v3", client_id: "c5", site_id: "c5s1", shift: "night" as Shift, reason: "Addendum +1 headcount not yet posted", opened: addDays(TODAY, -2) },
];

export const monthlyVerified: Record<string, boolean> = { c1: true, c2: true, c4: false, c5: false };

// ---------- operations ----------
const INC_CATS = ["theft", "altercation", "guard_injury", "weapon_discharge", "no_show", "asset_damage", "client_complaint", "other"];
export const incidents: Incident[] = [
  ["Attempted break-in at rear fence, intruders fled on guard challenge.", "high", "theft", "under_investigation"],
  ["Guard reported sick mid-shift; reliever dispatched within 40 minutes.", "low", "no_show", "resolved"],
  ["Verbal altercation with delivery driver at gate over entry pass.", "medium", "altercation", "resolved"],
  ["Accidental discharge during weapon handover. No injuries. Weapon withdrawn.", "critical", "weapon_discharge", "open"],
  ["Barrier arm damaged by reversing truck.", "medium", "asset_damage", "closed"],
  ["Client complained guard was on phone at post.", "low", "client_complaint", "open"],
  ["Guard slipped on wet ramp, minor sprain.", "medium", "guard_injury", "resolved"],
].map(([d, sev, cat, st], i) => {
  const s = sites[(i * 3) % sites.length]!;
  const g = employees.filter((e) => e.site_id === s.id).slice(0, 1 + (i % 2)).map((e) => e.id);
  return {
    id: `i${i + 1}`, code: `INC-${String(240 + i)}`, occurred_at: `${addDays(TODAY, -i * 3)}T${String(int(0, 23)).padStart(2, "0")}:${int(10, 59)}:00`,
    client_id: s.client_id, site_id: s.id, severity: sev as Incident["severity"], category: cat!, description: d!,
    response: i % 2 ? "Supervisor attended, client informed, report filed." : "", guards: g, status: st as Incident["status"],
  };
});
export const incidentCategories = INC_CATS;

export const posts: { id: string; client_id: string; name: string }[] = [];
export const complaints: { id: string; client_id: string; raised: string; description: string; status: string; channel?: string }[] = [
  { id: "cc1", client_id: "c5", raised: addDays(TODAY, -3), description: "Parking deck guard not wearing cap and badge.", status: "open" },
  { id: "cc2", client_id: "c2", raised: addDays(TODAY, -12), description: "Late shift change on Saturday, vault unattended 15 min.", status: "resolved" },
  { id: "cc3", client_id: "c6", raised: addDays(TODAY, -20), description: "Request for female searcher at staff gate.", status: "in_progress" },
];

export const dailyNotes: Record<string, Record<string, string>> = {
  [TODAY]: { c1: "All posts manned. Rear fence lights out since 02:00 — reported to client maintenance.", c4: "Container Yard night short by one, covered by reliever." },
  [addDays(TODAY, -1)]: { c1: "Normal. Visitor log audited.", c2: "Vault annex CCTV down 3 hrs.", c5: "Weekend footfall high; extra guard at Gate 3." },
};
export const reportExports = [
  { id: "x1", date: addDays(TODAY, -1), clients: 6, by: "Naveed Akhtar", at: `${addDays(TODAY, -1)}T20:14:00` },
  { id: "x2", date: addDays(TODAY, -2), clients: 7, by: "Naveed Akhtar", at: `${addDays(TODAY, -2)}T19:52:00` },
  { id: "x3", date: addDays(TODAY, -3), clients: 7, by: "Sajid Raza", at: `${addDays(TODAY, -3)}T21:03:00` },
];

// ---------- money ----------
const contractValue = (k: Contract) => k.lines.reduce((a, l) => a + l.committed * l.rate, 0);
export { contractValue };

export const invoices: Invoice[] = contracts
  .filter((k) => k.status === "active")
  .flatMap((k, ki) =>
    [2, 1, 0].map((back) => {
      const month = prevMonth(THIS_MONTH, back + 1);
      const amount = Math.round(contractValue(k) * 1.16);
      const paidFull = back > 0 || ki % 3 === 0;
      const partial = !paidFull && ki % 3 === 1;
      const overdue = !paidFull && !partial && ki % 2 === 0;
      const payments = paidFull
        ? [{ id: `p${ki}${back}`, date: `${prevMonth(THIS_MONTH, back)}-${String(int(3, 20)).padStart(2, "0")}`, amount: Math.round(amount * 0.96), mode: "Bank" as const, notes: "IBFT", wht: Math.round(amount * 0.04) }]
        : partial ? [{ id: `p${ki}${back}`, date: addDays(TODAY, -5), amount: Math.round(amount * 0.5), mode: "Cheque" as const, notes: "Part payment", wht: 0 }] : [];
      return {
        id: `inv${ki}${back}`, number: `GGS-${month.replace("-", "")}-${String(ki + 1).padStart(3, "0")}`, client_id: k.client_id, contract_id: k.id,
        month, amount, date: `${month}-28`, status: (paidFull ? "Paid" : partial ? "Partial" : overdue ? "Overdue" : "Unpaid") as Invoice["status"],
        attachment: ki % 2 === 0, notes: "", payments,
      };
    }),
  );

export const invoiceDrafts = contracts.filter((k) => k.status === "active").map((k, i) => ({
  id: `d${i}`, number: `GGS-${THIS_MONTH.replace("-", "")}-${String(i + 1).padStart(3, "0")}`, client_id: k.client_id, contract_id: k.id,
  month: LAST_MONTH, window: `${k.start} → ${k.end}`, amount: Math.round(contractValue(k) * 1.16), cleared: i % 3 === 0,
  lines: k.lines.map((l) => ({ description: `${l.category} × ${l.committed}`, qty: l.committed, rate: l.rate })),
}));

export const payslips: Payslip[] = employees
  .filter((e) => e.lifecycle === "active" || e.lifecycle === "terminated")
  .flatMap((e, i) =>
    [THIS_MONTH, LAST_MONTH].map((m) => {
      const working = 30;
      const absent = (i + (m === THIS_MONTH ? 1 : 0)) % 5 === 0 ? 2 : i % 7 === 0 ? 1 : 0;
      const leave = i % 6 === 0 ? 1 : 0;
      const dd = i % 8 === 0 ? 2 : 0;
      const present = working - absent - leave;
      const perDay = e.base / 30;
      const advance = i % 9 === 0 ? 5000 : 0;
      const deductions = Math.round(absent * perDay);
      const net = Math.round(e.base + e.allowance + dd * perDay - deductions - advance);
      const cleared = m === LAST_MONTH || i % 4 === 0;
      return {
        id: `ps${e.id}${m}`, employee_id: e.id, month: m, working, present, double_duty: dd, absent, leave, base: e.base,
        allowance: e.allowance, bonus: dd ? Math.round(dd * perDay) : 0, advance, deductions, net, status: cleared ? "Cleared" : "Pending",
        mode: cleared ? (i % 3 ? "Bank" : "Cash") : null, paid_on: cleared ? `${m}-${m === THIS_MONTH ? "05" : "06"}` : null,
      } as Payslip;
    }),
  );

export const adjustments = [
  { id: "a1", employee_id: "e4", month: LAST_MONTH, amount: 3500, reason: "Double duty on 14th not counted", status: "open" },
  { id: "a2", employee_id: "e12", month: LAST_MONTH, amount: -2000, reason: "Uniform loss recovery", status: "open" },
  { id: "a3", employee_id: "e20", month: prevMonth(THIS_MONTH, 2), amount: 1500, reason: "Night allowance", status: "settled" },
];

export const leaveLedger = employees.filter((e) => e.lifecycle === "active").slice(0, 10).map((e, i) => ({
  employee_id: e.id, quota: 14, taken: (i * 3) % 12, lost: i % 5 === 0 ? 2 : 0,
  entries: [
    { date: `${prevMonth(THIS_MONTH, 3)}-01`, kind: "Accrued", days: 14 },
    { date: `${prevMonth(THIS_MONTH, 2)}-12`, kind: "Taken", days: -((i * 3) % 12 ? 2 : 0) },
    { date: `${LAST_MONTH}-20`, kind: "Taken", days: -((i * 3) % 12 > 2 ? (i * 3) % 12 - 2 : 0) },
  ],
}));

export const payrollScopes = [
  ...clients.filter((c) => c.status === "active").map((c, i) => ({
    key: c.id, name: c.name, kind: "client" as const, stage: (i < 2 ? "finance" : i < 5 ? "review" : "draft") as "draft" | "review" | "finance",
    ops_verified: i !== 4, finance_verified: i === 0,
  })),
  { key: "office", name: "Office staff", kind: "office" as const, stage: "review" as const, ops_verified: true, finance_verified: false },
  { key: "relievers", name: "Relievers", kind: "relievers" as const, stage: "draft" as const, ops_verified: false, finance_verified: false },
];

export const expenseCategories = ["Fuel", "Uniforms", "Weapon licences", "Office rent", "Utilities", "Vehicle maintenance", "Meals", "Stationery", "Travel", "Communication"];
export const vendors = ["PSO Fuel Station", "Al-Hamd Uniforms", "K-Electric", "Jazz Business", "City Motors", "Paper World", "Pak Arms Traders"];

export const expenses: Expense[] = Array.from({ length: 22 }, (_, i) => ({
  id: `x${i + 1}`, date: addDays(TODAY, -i * 2 - (i % 3)), category: expenseCategories[i % expenseCategories.length]!,
  client_id: i % 3 === 0 ? clients[i % 6]!.id : null, vendor: vendors[i % vendors.length]!,
  description: ["Patrol vehicle diesel", "Winter jackets batch", "12-bore licence renewal", "Lahore office rent", "Electricity bill",
    "Tyre replacement", "Night-shift meals", "Duty register printing", "Supervisor visit to Karachi", "SIM & data bundles"][i % 10]!,
  amount: [18500, 96000, 24000, 150000, 31200, 22000, 8400, 6500, 41000, 12800][i % 10]! + i * 150,
  mode: (["Cash", "Bank", "Cheque", "Payable"] as const)[i % 4]!, by: pick(["Naveed Akhtar", "Accounts Office", "Sajid Raza"]),
  approved: i % 3 !== 1, nature: i % 3 === 0 ? "Cost of Services" : "Operating Expense",
}));

export const advances: Advance[] = employees.filter((e) => e.lifecycle === "active").slice(3, 11).map((e, i) => ({
  id: `adv${i}`, date: addDays(TODAY, -i * 4), employee_id: e.id, amount: [5000, 8000, 3000, 10000][i % 4]!, mode: i % 2 ? "Bank" : "Cash",
  paid_by: "Accounts Office", notes: ["Medical", "School fees", "Family emergency", "Eid"][i % 4]!, recovered: i % 3 === 0 ? 5000 : 0,
}));

export const fixedDefs: FixedDef[] = [
  { id: "fd1", description: "Lahore office rent", category: "Office rent", party: "Gulberg Properties", mode: "Bank", paid_by: "HBL Current", amount: 150000, runs: "Monthly · 1st" },
  { id: "fd2", description: "Internet & phones", category: "Communication", party: "Jazz Business", mode: "Bank", paid_by: "Meezan Ops", amount: 18000, runs: "Monthly · 10th" },
  { id: "fd3", description: "Security licence fee", category: "Weapon licences", party: "Home Department", mode: "Cheque", paid_by: "HBL Current", amount: 45000, runs: "Quarterly" },
  { id: "fd4", description: "Vehicle lease", category: "Vehicle maintenance", party: "City Motors", mode: "Bank", paid_by: "HBL Current", amount: 62000, runs: "Monthly · 5th" },
];
export const fixedInstances: FixedInstance[] = fixedDefs.map((d, i) => ({ id: `fi${i}`, def_id: d.id, month: THIS_MONTH, amount: d.amount, status: (["Awaiting", "Approved", "Awaiting", "Denied"] as const)[i]! }));

export const deferred = [
  { id: "df1", description: "Annual insurance — guards group policy", total: 720000, start: `${prevMonth(THIS_MONTH, 4)}-01`, months: 12, recognised: 5 },
  { id: "df2", description: "Weapon licence block renewal", total: 180000, start: `${prevMonth(THIS_MONTH, 1)}-01`, months: 6, recognised: 2 },
];

export const banks: Bank[] = [
  { id: "bk1", name: "HBL Current", number: "0042-7910-0183-03", type: "Current", owner: "Company", balance: 4_380_500, cheque_balance: -260_000 },
  { id: "bk2", name: "Meezan Ops", number: "0107-0103-5521-9", type: "Current", owner: "Company", balance: 1_214_900, cheque_balance: 185_000 },
  { id: "bk3", name: "UBL Payroll", number: "2319-4488-0020", type: "Current", owner: "Company", balance: 920_000, cheque_balance: 0 },
  { id: "bk4", name: "Allied Savings", number: "0010-0077-6612-5", type: "Savings", owner: "Partner — Faisal Iqbal", balance: 2_050_000, cheque_balance: 0 },
];

export const cheques: Cheque[] = [
  { id: "ch1", number: "004517", type: "payment", bank_id: "bk1", date: addDays(TODAY, -2), party: "Al-Hamd Uniforms", amount: 96000, linked: "Expense x2", status: "pending" },
  { id: "ch2", number: "004518", type: "payment", bank_id: "bk1", date: addDays(TODAY, 3), party: "Home Department", amount: 164000, linked: "Fixed fd3", status: "pending" },
  { id: "ch3", number: "881204", type: "deposit", bank_id: "bk2", date: addDays(TODAY, -5), party: "Crescent Bank", amount: 185000, linked: "Invoice payment", status: "pending" },
  { id: "ch4", number: "004509", type: "payment", bank_id: "bk1", date: addDays(TODAY, -21), party: "City Motors", amount: 62000, linked: "Fixed fd4", status: "cleared" },
  { id: "ch5", number: "771093", type: "deposit", bank_id: "bk2", date: addDays(TODAY, -30), party: "Sapphire Mall", amount: 210000, linked: "Invoice payment", status: "bounced" },
];

export const deposits: Deposit[] = [
  { id: "dp1", slip: "DS-3301", bank_id: "bk1", date: addDays(TODAY, -1), amount: 250000, by: "Naveed Akhtar", ref: "Site cash, week 38" },
  { id: "dp2", slip: "DS-3294", bank_id: "bk2", date: addDays(TODAY, -8), amount: 120000, by: "Accounts Office", ref: "Advance recoveries" },
];

export const custodians: Custodian[] = [
  { id: "cu1", location: "Lahore office safe", type: "Office", holder: "Accounts Office", opening: 150000, held: 212400, active: true },
  { id: "cu2", location: "Karachi office", type: "Office", holder: "Hamza Raza", opening: 80000, held: 64500, active: true },
  { id: "cu3", location: "Partner float", type: "Partner", holder: "Faisal Iqbal", opening: 0, held: 300000, active: true },
  { id: "cu4", location: "Ops supervisor float", type: "Site", holder: "Naveed Akhtar", opening: 20000, held: 18200, active: true },
];

export const bankTxns: Txn[] = [
  { id: "t1", date: addDays(TODAY, -1), kind: "Cash deposit", account: "HBL Current", delta: 250000, before: 4130500, after: 4380500, description: "DS-3301" },
  { id: "t2", date: addDays(TODAY, -3), kind: "Invoice payment", account: "Meezan Ops", delta: 412000, before: 802900, after: 1214900, description: "Meridian Textiles" },
  { id: "t3", date: addDays(TODAY, -4), kind: "Payroll disbursement", account: "UBL Payroll", delta: -1180000, before: 2100000, after: 920000, description: "Payroll batch" },
  { id: "t4", date: addDays(TODAY, -6), kind: "Wire transfer", account: "HBL Current", delta: -500000, before: 4630500, after: 4130500, description: "To UBL Payroll" },
  { id: "t5", date: addDays(TODAY, -6), kind: "Wire transfer", account: "UBL Payroll", delta: 500000, before: 1600000, after: 2100000, description: "From HBL Current" },
];
export const custodyTxns: Txn[] = [
  { id: "ct1", date: addDays(TODAY, -1), kind: "Deposit to bank", account: "Lahore office safe", delta: -250000, before: 462400, after: 212400, description: "DS-3301" },
  { id: "ct2", date: addDays(TODAY, -2), kind: "Expense", account: "Ops supervisor float", delta: -1800, before: 20000, after: 18200, description: "Fuel" },
  { id: "ct3", date: addDays(TODAY, -5), kind: "Withdraw to cash", account: "Karachi office", delta: 50000, before: 14500, after: 64500, description: "From Meezan Ops" },
];

export const payables: Payable[] = expenses.filter((e) => e.mode === "Payable").map((e, i) => ({
  id: `pay${i}`, vendor: e.vendor, category: e.category, client_id: e.client_id, amount: e.amount, expense_date: e.date,
  due: addDays(e.date, 30), status: (i === 0 ? "Pending" : i === 1 ? "Overdue" : i % 2 ? "Paid" : "Pending") as Payable["status"],
}));

export const openingReceivable: Record<string, number> = { c1: 120000, c2: 0, c3: 45000, c4: 310000, c5: 0, c6: 88000, c7: 0, c8: 20000 };

export const accounts: Account[] = [
  { code: "1000", name: "Assets", type: "asset", parent: null, control: true, system: true },
  { code: "1100", name: "Cash in hand", type: "asset", parent: "1000", control: true, system: true },
  { code: "1200", name: "Bank accounts", type: "asset", parent: "1000", control: true, system: true },
  { code: "1300", name: "Accounts receivable", type: "asset", parent: "1000", control: true, system: true },
  { code: "1400", name: "Employee advances", type: "asset", parent: "1000", control: false, system: true },
  { code: "1500", name: "Prepaid expenses", type: "asset", parent: "1000", control: false, system: false },
  { code: "1600", name: "Fixed assets", type: "asset", parent: "1000", control: false, system: false },
  { code: "2000", name: "Liabilities", type: "liability", parent: null, control: true, system: true },
  { code: "2100", name: "Accounts payable", type: "liability", parent: "2000", control: true, system: true },
  { code: "2200", name: "Salaries payable", type: "liability", parent: "2000", control: false, system: true },
  { code: "2300", name: "Sales tax payable", type: "liability", parent: "2000", control: false, system: true },
  { code: "3000", name: "Equity", type: "equity", parent: null, control: true, system: true },
  { code: "3100", name: "Partners' capital", type: "equity", parent: "3000", control: false, system: false },
  { code: "3200", name: "Retained earnings", type: "equity", parent: "3000", control: false, system: true },
  { code: "4000", name: "Revenue", type: "revenue", parent: null, control: true, system: true },
  { code: "4100", name: "Guarding services", type: "revenue", parent: "4000", control: false, system: true },
  { code: "5000", name: "Cost of services", type: "expense", parent: null, control: true, system: true },
  { code: "5100", name: "Guard salaries", type: "expense", parent: "5000", control: false, system: true },
  { code: "5200", name: "Uniforms & kit", type: "expense", parent: "5000", control: false, system: false },
  { code: "6000", name: "Operating expenses", type: "expense", parent: null, control: true, system: true },
  { code: "6100", name: "Rent & utilities", type: "expense", parent: "6000", control: false, system: false },
  { code: "6200", name: "Vehicles & fuel", type: "expense", parent: "6000", control: false, system: false },
  { code: "6300", name: "Office & admin", type: "expense", parent: "6000", control: false, system: false },
];

export const journal: JournalEntry[] = [
  { id: "j1", date: `${LAST_MONTH}-28`, ref: "GGS-INV batch", source: "Invoice", memo: "Monthly invoices", lines: [{ account: "1300", debit: 6_840_000, credit: 0 }, { account: "4100", debit: 0, credit: 5_896_552 }, { account: "2300", debit: 0, credit: 943_448 }] },
  { id: "j2", date: `${LAST_MONTH}-30`, ref: "Payroll", source: "Payslip", memo: "Salaries accrued", lines: [{ account: "5100", debit: 3_120_000, credit: 0 }, { account: "2200", debit: 0, credit: 3_120_000 }] },
  { id: "j3", date: `${THIS_MONTH}-05`, ref: "Payroll", source: "Payslip disbursement", memo: "Salaries paid", lines: [{ account: "2200", debit: 2_980_000, credit: 0 }, { account: "1200", debit: 0, credit: 2_480_000 }, { account: "1100", debit: 0, credit: 500_000 }] },
  { id: "j4", date: `${THIS_MONTH}-08`, ref: "x2", source: "Expense", memo: "Winter jackets batch", lines: [{ account: "5200", debit: 96_150, credit: 0 }, { account: "1200", debit: 0, credit: 96_150 }] },
  { id: "j5", date: `${THIS_MONTH}-10`, ref: "Meridian", source: "Invoice payment", memo: "Receipt", lines: [{ account: "1200", debit: 412_000, credit: 0 }, { account: "1300", debit: 0, credit: 412_000 }] },
  { id: "j6", date: `${THIS_MONTH}-12`, ref: "adv3", source: "Advance", memo: "Advance to guard", lines: [{ account: "1400", debit: 10_000, credit: 0 }, { account: "1100", debit: 0, credit: 10_000 }] },
  { id: "j7", date: `${THIS_MONTH}-15`, ref: "fd1", source: "Expense", memo: "Office rent", lines: [{ account: "6100", debit: 150_000, credit: 0 }, { account: "1200", debit: 0, credit: 150_000 }] },
  { id: "j8", date: `${THIS_MONTH}-18`, ref: "DS-3301", source: "Custody transfer", memo: "Cash to bank", lines: [{ account: "1200", debit: 250_000, credit: 0 }, { account: "1100", debit: 0, credit: 250_000 }] },
  { id: "j9", date: `${prevMonth(THIS_MONTH, 6)}-01`, ref: "OB-1", source: "Opening balance", memo: "Opening balances", lines: [{ account: "1200", debit: 5_000_000, credit: 0 }, { account: "1100", debit: 600_000, credit: 0 }, { account: "3100", debit: 0, credit: 5_600_000 }] },
  { id: "j10", date: `${THIS_MONTH}-20`, ref: "Partner", source: "Partner entry", memo: "Drawing — Faisal Iqbal", lines: [{ account: "3100", debit: 200_000, credit: 0 }, { account: "1200", debit: 0, credit: 200_000 }] },
];

export const openingBatches = [
  { id: "ob1", description: "Go-live opening balances", date: `${prevMonth(THIS_MONTH, 6)}-01`, region: "All regions", posted: true, lines: [
    { account: "1200", region: "Lahore", debit: 5_000_000, credit: 0 }, { account: "1100", region: "Lahore", debit: 600_000, credit: 0 }, { account: "3100", region: "Lahore", debit: 0, credit: 5_600_000 },
  ] },
];

export const periods = monthsBack(7).map((m, i) => ({
  month: m, invoices: 7 + (i % 2), payments: 6 + (i % 3), expenses: 18 + i, payslips: 58 + (i % 4), advances: 4 + (i % 3), cheques: 3 + (i % 2),
  status: (i >= 2 ? "closed" : "open") as "open" | "closed",
}));

export const partners: Partner[] = [
  { id: "pt1", name: "Faisal Iqbal", scope: "Company-wide", method: "Fixed %", share: 40, status: "active", allocated: 2_400_000, contributed: 3_000_000, drawn: 1_600_000 },
  { id: "pt2", name: "Sana Mirza", scope: "Karachi region", method: "Fixed %", share: 25, status: "active", allocated: 1_100_000, contributed: 1_500_000, drawn: 900_000 },
  { id: "pt3", name: "Col. (R) Ahsan Malik", scope: "Islamabad HO", method: "Pool", share: 15, status: "active", allocated: 520_000, contributed: 1_100_000, drawn: 300_000 },
];

export const projects = [
  { id: "pr1", name: "Armoured vehicle purchase", target: 6_500_000, raised: 4_200_000, investors: [{ name: "Faisal Iqbal", amount: 2_500_000 }, { name: "Sana Mirza", amount: 1_700_000 }] },
  { id: "pr2", name: "CCTV monitoring room", target: 2_000_000, raised: 2_000_000, investors: [{ name: "Col. (R) Ahsan Malik", amount: 2_000_000 }] },
];

// ---------- compliance ----------
export const importantDates: ImportantDate[] = [
  { id: "id1", title: "Security company licence renewal", date: addDays(TODAY, 21), category: "Licence", notice: 30, priority: "high" },
  { id: "id2", title: "EOBI quarterly return", date: addDays(TODAY, 6), category: "Statutory", notice: 10, priority: "high" },
  { id: "id3", title: "Weapon licence audit — Karachi", date: addDays(TODAY, 48), category: "Weapons", notice: 14, priority: "medium" },
  { id: "id4", title: "Harbour Freight contract review", date: addDays(TODAY, 44), category: "Contract", notice: 30, priority: "medium" },
  { id: "id5", title: "Fire-drill certificate — HO", date: addDays(TODAY, -3), category: "Safety", notice: 7, priority: "low" },
];
export const recurringAlerts: RecurringAlert[] = [
  { id: "ra1", name: "Sales tax return", category: "Tax", frequency: "Monthly", trigger_day: 15, notice: 5, active: true },
  { id: "ra2", name: "PESSI contribution", category: "Statutory", frequency: "Monthly", trigger_day: 10, notice: 3, active: true },
  { id: "ra3", name: "Guard refresher training", category: "Training", frequency: "Quarterly", trigger_day: 1, notice: 14, active: false },
];
export const licences: Licence[] = [
  { id: "l1", item: "PSPA security licence", category: "Company", expiry: addDays(TODAY, 21), authority: "Home Dept Punjab" },
  { id: "l2", item: "12-bore arms licence #A-1182", category: "Weapon", expiry: addDays(TODAY, -8), authority: "DC Lahore" },
  { id: "l3", item: "12-bore arms licence #A-1190", category: "Weapon", expiry: addDays(TODAY, 75), authority: "DC Lahore" },
  { id: "l4", item: "Vehicle LEA-4471 fitness", category: "Vehicle", expiry: addDays(TODAY, 160), authority: "Excise" },
  { id: "l5", item: "Sindh security licence", category: "Company", expiry: addDays(TODAY, 300), authority: "Home Dept Sindh" },
];
export const contractRenewals = [
  { id: "cr1", client_id: "c3", expected: addDays(TODAY, 18), stage: "Negotiating" },
  { id: "cr2", client_id: "c6", expected: addDays(TODAY, 44), stage: "Proposal sent" },
  { id: "cr3", client_id: "c8", expected: addDays(TODAY, 10), stage: "Lost" },
];
export const complianceCases = [
  { id: "cs1", case: "EOBI short-contribution notice", jurisdiction: "Punjab", authority: "EOBI", target: addDays(TODAY, 30), stage: "Reply filed" },
  { id: "cs2", case: "Labour inspection — Harbour site", jurisdiction: "Sindh", authority: "Labour Dept", target: addDays(TODAY, 12), stage: "Documents requested" },
];
export const filings = [
  { id: "f1", type: "Sales tax (PRA)", period: LAST_MONTH, due: `${THIS_MONTH}-15`, amount: 943448, status: "filed" },
  { id: "f2", type: "Withholding statement", period: LAST_MONTH, due: `${THIS_MONTH}-30`, amount: 0, status: "pending" },
];
export const govVisits = [
  { id: "gv1", date: addDays(TODAY, -15), authority: "Special Branch", note: "Guard verification spot-check at Crescent Bank. No findings." },
];

// ---------- inventory ----------
export const stock: StockItem[] = [
  { id: "it1", name: "12-bore shotgun", kind: "weapon", qty: 24, issued: 17, cost: 85000, replacement: 110000, serialised: true },
  { id: "it2", name: "Uniform shirt", kind: "uniform", qty: 180, issued: 120, cost: 1800, replacement: 2200, serialised: false },
  { id: "it3", name: "Uniform trouser", kind: "uniform", qty: 160, issued: 118, cost: 1600, replacement: 2000, serialised: false },
  { id: "it4", name: "Cap & badge", kind: "uniform", qty: 90, issued: 62, cost: 650, replacement: 800, serialised: false },
  { id: "it5", name: "Walkie-talkie", kind: "equipment", qty: 30, issued: 21, cost: 14000, replacement: 18000, serialised: true },
  { id: "it6", name: "Metal detector wand", kind: "equipment", qty: 12, issued: 9, cost: 9500, replacement: 12000, serialised: true },
  { id: "it7", name: "Winter jacket", kind: "uniform", qty: 60, issued: 12, cost: 4800, replacement: 5600, serialised: false },
];
export const holdings: Holding[] = employees.filter((e) => e.lifecycle === "active" && e.category === "client").slice(0, 14).flatMap((e, i) => [
  { id: `h${i}a`, employee_id: e.id, item_id: "it2", serial: "—", condition: "Good" as const, since: e.join_date ?? TODAY },
  ...(e.department === "Armed Guard" ? [{ id: `h${i}b`, employee_id: e.id, item_id: "it1", serial: `SG-${4400 + i}`, condition: (i % 5 === 0 ? "Fair" : "Good") as Holding["condition"], since: e.join_date ?? TODAY }] : []),
]);
export const clearances = employees.filter((e) => e.lifecycle === "terminated").map((e, i) => ({
  id: `cl${i}`, employee_id: e.id, fired: e.left_on!, items: i === 0 ? ["Uniform shirt", "12-bore shotgun"] : ["Uniform shirt", "Cap & badge"],
  fines: i === 1 ? 2200 : 0, dues: 18000 + i * 3000, stage: (i === 0 ? "ops" : i === 1 ? "finance" : "done") as "ops" | "finance" | "done",
}));
export const fixedAssets = [
  { id: "fa1", name: "Toyota Hilux LEA-4471", region: "Lahore", cost: 7_800_000, dep: 1_560_000, status: "In use" },
  { id: "fa2", name: "Suzuki Bolan KHI-2210", region: "Karachi", cost: 1_900_000, dep: 760_000, status: "In use" },
  { id: "fa3", name: "Control-room CCTV", region: "Islamabad HO", cost: 2_000_000, dep: 200_000, status: "In use" },
  { id: "fa4", name: "Generator 15 kVA", region: "Lahore", cost: 950_000, dep: 610_000, status: "Maintenance" },
];
export const vehicleLogs = [
  { id: "vl1", vehicle: "LEA-4471", date: addDays(TODAY, -1), km: 142, driver: "Kashif Qureshi", purpose: "Night patrol, Gulberg" },
  { id: "vl2", vehicle: "KHI-2210", date: addDays(TODAY, -2), km: 88, driver: "Asif Aslam", purpose: "Reliever drop, Port Qasim" },
];
export const ammo = [
  { id: "am1", date: addDays(TODAY, -7), issued: 240, accounted: 240 },
  { id: "am2", date: addDays(TODAY, -14), issued: 240, accounted: 238 },
];

// ---------- admin ----------
export const users: AppUser[] = [
  { id: "u1", name: "Ayesha Siddiqui", email: "ayesha@ggs.pk", title: "Managing Director", role: "super_admin", branch_id: null, permissions: [], employee_id: null, active: true },
  { id: "u2", name: "Naveed Akhtar", email: "naveed@ggs.pk", title: "Ops Supervisor — Lahore", role: "ops_manager", branch_id: "b1",
    permissions: ["attendance.view", "attendance.edit", "attendance.bulk_mark", "roster.view", "roster.edit", "incidents.view", "incidents.edit", "employees.view", "assignments.view", "inventory.view", "compliance.view"], employee_id: employees.find((e) => e.department === "Operations Supervisor")!.id, active: true },
  { id: "u3", name: "Hira Baig", email: "hira@ggs.pk", title: "Accounts Officer", role: "accounting", branch_id: null,
    permissions: ["banks.view", "receivables.view", "payables.view", "accounting.edit", "expenses.view", "expenses.edit", "invoices.view", "invoices.edit", "payroll.view", "payroll.edit", "reports.view", "coa.view"], employee_id: null, active: true },
  { id: "u4", name: "Omar Farooq", email: "omar@ggs.pk", title: "HR Executive", role: "hr", branch_id: "b2",
    permissions: ["employees.view", "employees.edit", "assignments.view", "assignments.hr", "documents.view", "documents.edit", "attendance.view"], employee_id: null, active: true },
  { id: "u5", name: "Sadia Noor", email: "sadia@ggs.pk", title: "Finance Director", role: "finance_director", branch_id: null,
    permissions: ["payroll.view", "payroll.approve", "reports.view", "cashflow.view", "coa.view", "period_close.manage", "banks.view", "receivables.view", "payables.view"], employee_id: null, active: false },
  { id: "u6", name: "Platform Owner", email: "owner@bastion.app", title: "TechxServe", role: "super_super_admin", branch_id: null, permissions: [], employee_id: null, active: true },
];

export const governanceRequests = [
  { id: "gr1", who: "Naveed Akhtar", what: "Grant attendance.backdate for 3 days", at: addDays(TODAY, -1), status: "pending" },
  { id: "gr2", who: "Hira Baig", what: "Approve expense above PKR 100,000 (Winter jackets)", at: addDays(TODAY, -3), status: "approved" },
];
export const thresholds = [
  { action: "Expense approval required above", value: "PKR 100,000" },
  { action: "Payroll run needs two signatures above", value: "PKR 5,000,000" },
  { action: "Backdate attendance beyond", value: "3 days" },
];

export const auditLog: AuditEntry[] = [
  { id: "al1", at: `${TODAY}T09:14:00`, user: "Naveed Akhtar", action: "update", table: "attendance", record: "e7 · " + TODAY, fields: { status: { before: "present", after: "absent" } } },
  { id: "al2", at: `${TODAY}T08:02:00`, user: "Hira Baig", action: "insert", table: "expenses", record: "x1", fields: { amount: { after: 18500 }, category: { after: "Fuel" } } },
  { id: "al3", at: `${addDays(TODAY, -1)}T17:40:00`, user: "Ayesha Siddiqui", action: "update", table: "employees", record: "e12", fields: { base_salary: { before: 38000, after: 40000 } } },
  { id: "al4", at: `${addDays(TODAY, -1)}T11:25:00`, user: "Omar Farooq", action: "delete", table: "employee_documents", record: "doc-882", fields: { name: { before: "cnic_back_old.jpg" } } },
  { id: "al5", at: `${addDays(TODAY, -2)}T15:00:00`, user: "Hira Baig", action: "update", table: "invoices", record: "GGS-INV-004", fields: { status: { before: "Unpaid", after: "Partial" } } },
];

export const tasks: Task[] = [
  { id: "tk1", title: "Post reliever at Container Yard night", description: "Vacancy open since Monday.", assignee: "Naveed Akhtar", due: addDays(TODAY, 1), status: "todo", priority: "urgent" },
  { id: "tk2", title: "Collect Sapphire Mall bounced cheque replacement", description: "", assignee: "Hira Baig", due: addDays(TODAY, 3), status: "in_progress", priority: "high" },
  { id: "tk3", title: "Renew arms licence #A-1182", description: "Expired last week.", assignee: "Omar Farooq", due: addDays(TODAY, 2), status: "todo", priority: "high" },
  { id: "tk4", title: "September OPS verification — Harbour Freight", description: "", assignee: "Naveed Akhtar", due: addDays(TODAY, 5), status: "in_progress", priority: "medium" },
  { id: "tk5", title: "Issue winter jackets to night shift", description: "", assignee: "Omar Farooq", due: addDays(TODAY, -1), status: "done", priority: "low" },
];
export const checklist: { id: string; text: string; done: boolean; raw?: any }[] = [
  { id: "pc1", text: "Call Indus Pharma about renewal", done: false },
  { id: "pc2", text: "Sign cheque 004518", done: true },
  { id: "pc3", text: "Review incident INC-243", done: false },
];

export const activity = [
  { id: "ac1", at: `${TODAY}T09:14:00`, who: "Naveed Akhtar", what: "marked Usman Iqbal absent at Main Mill Gate", tone: "danger" as const },
  { id: "ac2", at: `${TODAY}T08:55:00`, who: "Sajid Raza", what: "confirmed Berth 7 Gate · day shift", tone: "success" as const },
  { id: "ac3", at: `${TODAY}T08:02:00`, who: "Hira Baig", what: "recorded PKR 18,500 fuel expense", tone: "info" as const },
  { id: "ac4", at: `${addDays(TODAY, -1)}T20:14:00`, who: "Naveed Akhtar", what: "exported the daily report for 6 clients", tone: "info" as const },
  { id: "ac5", at: `${addDays(TODAY, -1)}T17:40:00`, who: "Ayesha Siddiqui", what: "raised base pay for Adnan Malik", tone: "warning" as const },
];

export const attachments = [
  { id: "at1", name: "Board minutes — Q3.pdf", size: "412 KB", at: addDays(TODAY, -6) },
  { id: "at2", name: "Insurance schedule 2026.xlsx", size: "88 KB", at: addDays(TODAY, -20) },
];

export const systemAlerts = [
  { id: "sa1", level: "blocking" as const, text: "Arms licence #A-1182 expired — 1 guard carrying this weapon", at: addDays(TODAY, -8) },
  { id: "sa2", level: "warning" as const, text: "3 guards have an expired CNIC", at: addDays(TODAY, -2) },
  { id: "sa3", level: "warning" as const, text: "Sapphire Mall cheque 771093 bounced", at: addDays(TODAY, -30) },
];

export const companies = [
  { id: "co1", name: "Guardian Global Security", contact: "ayesha@ggs.pk", users: 5, employees: employees.length, plan: "Growth", status: "active", paid_until: addDays(TODAY, 24) },
  { id: "co2", name: "Shield Force Pvt Ltd", contact: "admin@shieldforce.pk", users: 3, employees: 112, plan: "Starter", status: "trial", paid_until: addDays(TODAY, 9) },
  { id: "co3", name: "Falcon Guards", contact: "ops@falcon.pk", users: 8, employees: 340, plan: "Scale", status: "past_due", paid_until: addDays(TODAY, -4) },
];
export const subscriptionPayments = [
  { id: "sp1", company_id: "co1", date: addDays(TODAY, -6), amount: 45000, days: 30, notes: "Card" },
  { id: "sp2", company_id: "co3", date: addDays(TODAY, -34), amount: 90000, days: 30, notes: "Bank transfer" },
];

export const kpis = employees.filter((e) => e.category === "office_staff").map((e, i) => ({
  employee_id: e.id, kpi: ["Post coverage", "Receivable days", "Onboarding time", "Fuel per km"][i]!, target: ["98%", "45", "5 days", "0.12 L"][i]!,
  value: ["96.4%", "52", "4 days", "0.11 L"][i]!, rag: (["amber", "red", "green", "green"] as const)[i]!,
}));
export const appraisals = [
  { id: "ap1", employee_id: kpis[0]!.employee_id, period: "H1 2026", score: 4.2, status: "approved" },
  { id: "ap2", employee_id: kpis[1]!.employee_id, period: "H1 2026", score: 3.4, status: "pending" },
];

// Per-employee history helpers invent rows; in live mode they return nothing
// rather than fiction about a real person.
export const documentsFor = (e: Employee) => isLive ? [] : [
  { id: `${e.id}d1`, name: "CNIC front.jpg", kind: "CNIC", at: e.join_date ?? TODAY },
  { id: `${e.id}d2`, name: "CNIC back.jpg", kind: "CNIC", at: e.join_date ?? TODAY },
  ...(e.police_verification === "cleared" ? [{ id: `${e.id}d3`, name: "Police verification.pdf", kind: "Vetting", at: e.join_date ?? TODAY }] : []),
  ...(e.incomplete.length ? [] : [{ id: `${e.id}d4`, name: "Application form.pdf", kind: "Form", at: e.join_date ?? TODAY }]),
];

export const shiftHistory = (e: Employee) => isLive ? [] : [
  { date: e.join_date ?? TODAY, from: "—", to: `${e.shift} · ${sites.find((s) => s.id === e.site_id)?.name ?? "Office"}`, by: "Omar Farooq" },
];

export const salaryHistory = (e: Employee) => isLive ? [] : [
  { effective: e.join_date ?? TODAY, base: e.base - 2000, allowance: e.allowance, reason: "Joining" },
  { effective: `${prevMonth(THIS_MONTH, 4)}-01`, base: e.base, allowance: e.allowance, reason: "Annual increment" },
];
