import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Search, Upload, AlertCircle, Loader2, X, Trash2, ChevronDown, ChevronRight as ChevronRightIcon, FileText } from "lucide-react";
import { generateEmployeeFormPdf } from "../../lib/employeeFormPdf";
import EmployeeLifecyclePanel from "../../components/EmployeeLifecyclePanel";
import Header from "../../components/Header";
import { formatDate } from "../../lib/date";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import { useRegion, withRegion } from "../../lib/region";
import {
  supabase,
  EMPLOYEE_DOCS_BUCKET,
  BLOOD_GROUPS,
  EMERGENCY_CONTACT_RELATIONS,
  CONTRACT_LINE_CATEGORY_LABEL,
  effectiveCommittedByCategory,
  activeCountByCategory,
  type Employee,
  type EmployeeDocument,
  type Location,
  type Client,
  type Contract,
  type ContractLine,
  type ContractAddendum,
  type ContractLineCategory,
  type Branch,
  type EmployeeCategory,
  type EmployeeCodeHistory,
  type MaritalStatus,
  type SocialSecurityStatus,
  type EmployeeIdentityAmendment,
  type EmployeeChild,
  type EmployeeReference,
  type EmployeePreviousJob,
  type EmployeeDocumentChecklistItem,
  type ReferenceType,
  CHECKLIST_DOC_LABEL,
  LIFECYCLE_STATE_LABEL,
  type EmployeeLifecycleState,
} from "../../lib/supabase";
import {
  validateCnic,
  validatePhone,
  validateIban,
  validateBankAccount,
  validateFreeText,
} from "../../lib/validation";
import { useAuth } from "../../lib/auth";

type EmployeeRow = Employee & {
  location_name: string | null;
  client_name: string | null;
  branch_name: string | null;
  additional_branch_ids: string[];
  doc_count: number;
};
type DocumentWithUrl = EmployeeDocument & { publicUrl: string | null };

const CODE_HISTORY_REASON: Record<EmployeeCodeHistory["reason"], string> = {
  assigned: "assigned",
  reassigned: "reassigned",
  prefix_changed: "prefix changed",
};

// One "OLD → NEW, reason · date" line. Shared by the inline latest-only view and
// the full "View All Logs" modal.
function CodeHistoryRow({ h }: { h: EmployeeCodeHistory }) {
  return (
    <div className="flex items-center gap-2 flex-wrap text-sm text-slate-700">
      {h.old_code ? (
        <>
          <span className="font-mono text-slate-500 line-through">{h.old_code}</span>
          <span className="text-slate-400">→</span>
        </>
      ) : null}
      <span className="font-mono text-slate-900">{h.new_code}</span>
      <span className="text-xs text-slate-400">
        {CODE_HISTORY_REASON[h.reason]} · {formatDate(h.changed_at.slice(0, 10))}
      </span>
    </div>
  );
}

type FormState = {
  full_name: string;
  phone: string;
  location_id: string;
  client_id: string;
  contract_id: string;
  contract_line_id: string;
  assignment_effective_from: string;
  assignment_effective_to: string;
  branch_id: string;
  additional_branch_ids: string[];
  category: EmployeeCategory;
  department: string;
  shift: "day" | "night" | "evening";
  base_salary: string;
  per_day_salary: string;
  allowance: string;
  opening_leaves: string;
  join_date: string;
  bank_name: string;
  bank_account: string;
  // Sprint 2 HR additions
  cnic_number: string;
  date_of_birth: string;
  father_or_husband_name: string;
  blood_group: string;
  permanent_address: string;
  current_address: string;
  emergency_contact_name: string;
  emergency_contact_relation: string;
  emergency_contact_phone: string;
  reporting_to_employee_id: string;
  employee_contract_type: "" | "permanent" | "contract" | "probation" | "daily_wages";
  probation_end_date: string;
  weapon_licence_number: string;
  weapon_licence_expiry: string;
  guard_service_licence_number: string;
  guard_service_licence_expiry: string;
  medical_fitness_expiry: string;
  eobi_registration_number: string;
  iban: string;
  // §11 Employee Data Form — extended paper-form fields
  interview_date: string;
  form_serial_no: string;
  cnic_expiry: string;
  education: string;
  marital_status: "" | MaritalStatus;
  height_cm: string;
  weight_kg: string;
  build: string;
  uniform_size: string;
  shoe_size: string;
  special_skills: string;
  emergency_contact2_name: string;
  emergency_contact2_relation: string;
  emergency_contact2_phone: string;
  post_office: string;
  police_station: string;
  area_nazim: string;
  union_council: string;
  spouse_name: string;
  next_of_kin_name: string;
  next_of_kin_relation: string;
  next_of_kin_cnic: string;
  next_of_kin_contact: string;
  is_ex_serviceman: boolean;
  army_number: string;
  service_unit: string;
  service_rank: string;
  service_trade: string;
  service_join_date: string;
  service_discharge_date: string;
  discharging_officer: string;
  weapons_trained: string;
  designation: string;
  project: string;
  company_id_card_number: string;
  social_security_status: "" | SocialSecurityStatus;
  social_security_number: string;
  insurance_provider: string;
  insurance_number: string;
  remarks: string;
  // Physical document copies on file → complete profile.
  physical_copy_present: boolean;
  // §12 recruitment pipeline
  referral_source: string;
  referred_by_name: string;
  // Intake lifecycle state — Add only ("" = normal active hire).
  lifecycle_intake: "" | "applicant" | "waitlisted";
  cnic?: File;
  police_verification?: File;
  other?: FileList;
};

// Default values for the §11 extended fields, spread into both emptyForm and the
// edit-form population so the two never drift.
const emptyPaperFormFields = {
  interview_date: "",
  form_serial_no: "",
  cnic_expiry: "",
  education: "",
  marital_status: "" as "" | MaritalStatus,
  height_cm: "",
  weight_kg: "",
  build: "",
  uniform_size: "",
  shoe_size: "",
  special_skills: "",
  emergency_contact2_name: "",
  emergency_contact2_relation: "",
  emergency_contact2_phone: "",
  post_office: "",
  police_station: "",
  area_nazim: "",
  union_council: "",
  spouse_name: "",
  next_of_kin_name: "",
  next_of_kin_relation: "",
  next_of_kin_cnic: "",
  next_of_kin_contact: "",
  is_ex_serviceman: false,
  army_number: "",
  service_unit: "",
  service_rank: "",
  service_trade: "",
  service_join_date: "",
  service_discharge_date: "",
  discharging_officer: "",
  weapons_trained: "",
  designation: "",
  project: "",
  company_id_card_number: "",
  social_security_status: "" as "" | SocialSecurityStatus,
  social_security_number: "",
  insurance_provider: "",
  insurance_number: "",
  remarks: "",
  physical_copy_present: false,
  referral_source: "",
  referred_by_name: "",
  lifecycle_intake: "" as "" | "applicant" | "waitlisted",
};

const emptyForm: FormState = {
  full_name: "",
  phone: "",
  location_id: "",
  client_id: "",
  contract_id: "",
  contract_line_id: "",
  assignment_effective_from: "",
  assignment_effective_to: "",
  branch_id: "",
  additional_branch_ids: [],
  category: "client",
  department: "",
  shift: "day",
  base_salary: "",
  per_day_salary: "",
  allowance: "",
  opening_leaves: "",
  join_date: "",
  bank_name: "",
  bank_account: "",
  cnic_number: "",
  date_of_birth: "",
  father_or_husband_name: "",
  blood_group: "",
  permanent_address: "",
  current_address: "",
  emergency_contact_name: "",
  emergency_contact_relation: "",
  emergency_contact_phone: "",
  reporting_to_employee_id: "",
  employee_contract_type: "",
  probation_end_date: "",
  weapon_licence_number: "",
  weapon_licence_expiry: "",
  guard_service_licence_number: "",
  guard_service_licence_expiry: "",
  medical_fitness_expiry: "",
  eobi_registration_number: "",
  iban: "",
  ...emptyPaperFormFields,
};


const daysInCurrentMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};

const FIELD_CLS =
  "w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";

// §11 extended paper-form sections, rendered once and reused by both the Add and
// Edit modals (like renderAssignmentFields). Follows the existing form pattern:
// a border-t block with an h4 heading and a two-column grid.
function renderPaperFormSections(f: FormState, setF: (f: FormState) => void) {
  // Text input bound to a string field on FormState.
  const txt = (
    key: keyof FormState,
    label: string,
    opts: { type?: string; placeholder?: string; wide?: boolean } = {},
  ) => (
    <div className={opts.wide ? "col-span-2" : ""}>
      <label className="block text-sm text-slate-700 mb-1">{label}</label>
      <input
        type={opts.type ?? "text"}
        value={(f[key] as string) ?? ""}
        onChange={(e) => setF({ ...f, [key]: e.target.value })}
        className={FIELD_CLS}
        placeholder={opts.placeholder}
      />
    </div>
  );
  const area = (key: keyof FormState, label: string) => (
    <div className="col-span-2">
      <label className="block text-sm text-slate-700 mb-1">{label}</label>
      <textarea
        rows={2}
        value={(f[key] as string) ?? ""}
        onChange={(e) => setF({ ...f, [key]: e.target.value })}
        className={FIELD_CLS}
      />
    </div>
  );

  return (
    <>
      <div className="pt-4 border-t border-slate-200">
        <h4 className="text-sm text-slate-900 mb-4">Personal Details</h4>
        <div className="grid grid-cols-2 gap-4">
          {txt("cnic_expiry", "CNIC Expiry", { type: "date" })}
          {txt("education", "Education")}
          <div>
            <label className="block text-sm text-slate-700 mb-1">Marital Status</label>
            <ThemedSelect
              value={f.marital_status}
              onChange={(e) => setF({ ...f, marital_status: e.target.value as "" | MaritalStatus })}
              className={FIELD_CLS}
            >
              <option value="">—</option>
              <option value="single">Single</option>
              <option value="married">Married</option>
              <option value="divorced">Divorced</option>
              <option value="widowed">Widowed</option>
            </ThemedSelect>
          </div>
          {txt("height_cm", "Height (cm)", { type: "number" })}
          {txt("weight_kg", "Weight (kg)", { type: "number" })}
          {txt("build", "Build", { placeholder: "e.g. Medium" })}
          {txt("uniform_size", "Uniform Size")}
          {txt("shoe_size", "Shoe Size")}
          {area("special_skills", "Special Skills")}
        </div>
      </div>

      <div className="pt-4 border-t border-slate-200">
        <h4 className="text-sm text-slate-900 mb-4">Second Emergency Contact</h4>
        <div className="grid grid-cols-2 gap-4">
          {txt("emergency_contact2_name", "Name")}
          {txt("emergency_contact2_relation", "Relation")}
          {txt("emergency_contact2_phone", "Phone", { type: "tel" })}
        </div>
      </div>

      <div className="pt-4 border-t border-slate-200">
        <h4 className="text-sm text-slate-900 mb-4">Political / Locality</h4>
        <div className="grid grid-cols-2 gap-4">
          {txt("post_office", "Post Office")}
          {txt("police_station", "Police Station")}
          {txt("area_nazim", "Area Nazim")}
          {txt("union_council", "Union Council")}
        </div>
      </div>

      <div className="pt-4 border-t border-slate-200">
        <h4 className="text-sm text-slate-900 mb-4">Family</h4>
        <div className="grid grid-cols-2 gap-4">
          {txt("spouse_name", "Spouse Name")}
          {txt("next_of_kin_name", "Next of Kin — Name")}
          {txt("next_of_kin_relation", "Next of Kin — Relation")}
          {txt("next_of_kin_cnic", "Next of Kin — CNIC")}
          {txt("next_of_kin_contact", "Next of Kin — Contact")}
        </div>
      </div>

      <div className="pt-4 border-t border-slate-200">
        <h4 className="text-sm text-slate-900 mb-4">Ex-Service</h4>
        <div className="grid grid-cols-2 gap-4">
          <label className="col-span-2 flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={f.is_ex_serviceman}
              onChange={(e) => setF({ ...f, is_ex_serviceman: e.target.checked })}
            />
            <span>Ex-serviceman</span>
          </label>
          {f.is_ex_serviceman && (
            <>
              {txt("army_number", "Army Number")}
              {txt("service_unit", "Unit")}
              {txt("service_rank", "Rank")}
              {txt("service_trade", "Trade")}
              {txt("service_join_date", "Join Date", { type: "date" })}
              {txt("service_discharge_date", "Discharge Date", { type: "date" })}
              {txt("discharging_officer", "Discharging Officer")}
            </>
          )}
        </div>
      </div>

      <div className="pt-4 border-t border-slate-200">
        <h4 className="text-sm text-slate-900 mb-4">Experience</h4>
        <div className="grid grid-cols-2 gap-4">{area("weapons_trained", "Weapons Trained On")}</div>
      </div>

      <div className="pt-4 border-t border-slate-200">
        <h4 className="text-sm text-slate-900 mb-4">Internal Office Data</h4>
        <div className="grid grid-cols-2 gap-4">
          {txt("interview_date", "Interview Date", { type: "date" })}
          {txt("form_serial_no", "Form Serial No.")}
          {txt("designation", "Designation")}
          {txt("project", "Project")}
          {txt("company_id_card_number", "Company ID Card No.")}
          <div>
            <label className="block text-sm text-slate-700 mb-1">Social Security Status</label>
            <ThemedSelect
              value={f.social_security_status}
              onChange={(e) =>
                setF({ ...f, social_security_status: e.target.value as "" | SocialSecurityStatus })
              }
              className={FIELD_CLS}
            >
              <option value="">—</option>
              <option value="registered">Registered</option>
              <option value="not_registered">Not registered</option>
              <option value="exempt">Exempt</option>
            </ThemedSelect>
          </div>
          {txt("social_security_number", "Social Security No.")}
          {txt("insurance_provider", "Insurance Provider")}
          {txt("insurance_number", "Insurance No.")}
          {area("remarks", "Remarks")}
        </div>
      </div>

      <div className="pt-4 border-t border-slate-200">
        <h4 className="text-sm text-slate-900 mb-4">Recruitment</h4>
        <div className="grid grid-cols-2 gap-4">
          {txt("referral_source", "Referral Source", { placeholder: "e.g. Walk-in, Advert, Referral" })}
          {txt("referred_by_name", "Referred By")}
        </div>
      </div>

      <div className="pt-4 border-t border-slate-200">
        <h4 className="text-sm text-slate-900 mb-4">Documents</h4>
        <label
          className={`flex items-center gap-2 text-sm rounded-md border p-3 cursor-pointer ${
            f.physical_copy_present
              ? "bg-success-50 border-success-200 text-success-800"
              : "bg-danger-50 border-danger-200 text-danger-800"
          }`}
        >
          <input
            type="checkbox"
            checked={f.physical_copy_present}
            onChange={(e) => setF({ ...f, physical_copy_present: e.target.checked })}
          />
          <span>
            Physical Copy Present
            <span className="block text-xs opacity-80">
              {f.physical_copy_present
                ? "Profile marked complete."
                : "Profile is incomplete until the physical copies are on file."}
            </span>
          </span>
        </label>
      </div>
    </>
  );
}

// §11 extended paper-form columns, mapped from the form to DB values (blank → null,
// numbers coerced). Spread into both the insert and update payloads so Add and Edit
// persist the same fields. Core identity fields (full_name, cnic_number, dob,
// father_or_husband_name) are handled by the normal payload and, once verified, are
// locked by the DB — changes must go through the amend flow.
const paperFormPayload = (f: FormState) => ({
  interview_date: f.interview_date || null,
  form_serial_no: f.form_serial_no.trim() || null,
  cnic_expiry: f.cnic_expiry || null,
  education: f.education.trim() || null,
  marital_status: f.marital_status || null,
  height_cm: f.height_cm ? Number(f.height_cm) : null,
  weight_kg: f.weight_kg ? Number(f.weight_kg) : null,
  build: f.build.trim() || null,
  uniform_size: f.uniform_size.trim() || null,
  shoe_size: f.shoe_size.trim() || null,
  special_skills: f.special_skills.trim() || null,
  emergency_contact2_name: f.emergency_contact2_name.trim() || null,
  emergency_contact2_relation: f.emergency_contact2_relation.trim() || null,
  emergency_contact2_phone: f.emergency_contact2_phone.trim() || null,
  post_office: f.post_office.trim() || null,
  police_station: f.police_station.trim() || null,
  area_nazim: f.area_nazim.trim() || null,
  union_council: f.union_council.trim() || null,
  spouse_name: f.spouse_name.trim() || null,
  next_of_kin_name: f.next_of_kin_name.trim() || null,
  next_of_kin_relation: f.next_of_kin_relation.trim() || null,
  next_of_kin_cnic: f.next_of_kin_cnic.trim() || null,
  next_of_kin_contact: f.next_of_kin_contact.trim() || null,
  is_ex_serviceman: f.is_ex_serviceman,
  physical_copy_present: f.physical_copy_present,
  army_number: f.army_number.trim() || null,
  service_unit: f.service_unit.trim() || null,
  service_rank: f.service_rank.trim() || null,
  service_trade: f.service_trade.trim() || null,
  service_join_date: f.service_join_date || null,
  service_discharge_date: f.service_discharge_date || null,
  discharging_officer: f.discharging_officer.trim() || null,
  weapons_trained: f.weapons_trained.trim() || null,
  designation: f.designation.trim() || null,
  project: f.project.trim() || null,
  company_id_card_number: f.company_id_card_number.trim() || null,
  social_security_status: f.social_security_status || null,
  social_security_number: f.social_security_number.trim() || null,
  insurance_provider: f.insurance_provider.trim() || null,
  insurance_number: f.insurance_number.trim() || null,
  remarks: f.remarks.trim() || null,
  referral_source: f.referral_source.trim() || null,
  referred_by_name: f.referred_by_name.trim() || null,
});

// First-of-month for today, used to stamp when an opening-leaves override takes
// effect (the override applies from the month it's entered, forward).
const firstOfCurrentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

// Parse the "Opening Leaves" form field into the {opening_leaves, month} pair to
// persist. Empty string → not set (null). Stamps the effective month on set.
const openingLeavesPayload = (raw: string) =>
  raw === ""
    ? { opening_leaves: null, opening_leaves_month: null }
    : {
        opening_leaves: Math.max(0, Math.floor(Number(raw) || 0)),
        opening_leaves_month: firstOfCurrentMonth(),
      };

const computePerDay = (baseStr: string): string => {
  const base = Number(baseStr);
  if (!Number.isFinite(base) || base <= 0) return "";
  const days = daysInCurrentMonth();
  const pd = base / days;
  return pd.toFixed(2);
};

export default function EmployeeManagement() {
  const { profile, company } = useAuth();
  const { regionId } = useRegion();
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [contractLines, setContractLines] = useState<ContractLine[]>([]);
  const [addendums, setAddendums] = useState<ContractAddendum[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | EmployeeCategory>("all");
  const [shiftFilter, setShiftFilter] = useState<"all" | "day" | "night" | "evening">("all");
  const [statusFilter, setStatusFilter] = useState("all");
  // Profile completeness (physical copies on file) filter.
  const [completenessFilter, setCompletenessFilter] = useState<"all" | "complete" | "incomplete">("all");
  // §12 recruitment pipeline / lifecycle-state filter.
  const [lifecycleFilter, setLifecycleFilter] = useState<"all" | EmployeeLifecycleState>("all");
  // Quick Active / Inactive tab split (Inactive = anything not currently Active).
  const [empTab, setEmpTab] = useState<"all" | "active" | "inactive">("all");

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeRow | null>(null);
  const [selectedDocs, setSelectedDocs] = useState<DocumentWithUrl[]>([]);
  const [codeHistory, setCodeHistory] = useState<EmployeeCodeHistory[]>([]);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string | null>>({});
  const [editFormErrors, setEditFormErrors] = useState<Record<string, string | null>>({});
  const [submitting, setSubmitting] = useState(false);

  const [editForm, setEditForm] = useState<FormState>(emptyForm);
  const [editStatus, setEditStatus] = useState<EmployeeRow["status"]>("Active");
  const [editing, setEditing] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    const [locRes, cliRes, brRes, empRes, docRes, ebRes, conRes, clRes, adRes] = await Promise.all([
      supabase.from("locations").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
      withRegion(
        supabase
          .from("employees")
          .select("*, location:location_id(name), client:client_id(name), branch:branch_id(name)")
          .order("created_at", { ascending: false }),
        regionId,
      ),
      supabase.from("employee_documents").select("employee_id"),
      supabase.from("employee_branches").select("employee_id, branch_id"),
      supabase.from("contracts").select("*").order("start_date", { ascending: false }),
      supabase.from("contract_lines").select("*"),
      supabase.from("contract_addendums").select("*"),
    ]);
    if (locRes.error) setError(locRes.error.message);
    if (cliRes.error) setError(cliRes.error.message);
    if (brRes.error) setError(brRes.error.message);
    if (empRes.error) setError(empRes.error.message);
    if (docRes.error) setError(docRes.error.message);
    setLocations(locRes.data ?? []);
    setClients(cliRes.data ?? []);
    setContracts((conRes.data ?? []) as Contract[]);
    setContractLines((clRes.data ?? []) as ContractLine[]);
    setAddendums((adRes.data ?? []) as ContractAddendum[]);
    setBranches(brRes.data ?? []);
    const docCount = new Map<string, number>();
    for (const d of (docRes.data ?? []) as { employee_id: string }[]) {
      docCount.set(d.employee_id, (docCount.get(d.employee_id) ?? 0) + 1);
    }
    const addlBranches = new Map<string, string[]>();
    for (const r of (ebRes.data ?? []) as { employee_id: string; branch_id: string }[]) {
      const arr = addlBranches.get(r.employee_id) ?? [];
      arr.push(r.branch_id);
      addlBranches.set(r.employee_id, arr);
    }
    setEmployees(
      (empRes.data ?? []).map((e: any) => ({
        ...e,
        location_name: e.location?.name ?? null,
        client_name: e.client?.name ?? null,
        branch_name: e.branch?.name ?? null,
        additional_branch_ids: addlBranches.get(e.id) ?? [],
        doc_count: docCount.get(e.id) ?? 0,
      }))
    );
    setLoading(false);
  };

  // Reloads when the global region changes: the region selector scopes the
  // whole screen, not just the client-side branch filter below it.
  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  // Branches first by Head Office then alpha — used in selects with placeholder.
  const branchOptions = useMemo(() => branches.slice(), [branches]);

  // Clients filtered by chosen branch (empty branch = show all in company).
  const clientsForBranch = (branchId: string): Client[] =>
    branchId ? clients.filter((c) => c.branch_id === branchId) : clients;

  // When the form's client changes:
  //  - if the form has no primary branch yet, the client's branch becomes primary.
  //  - otherwise, the client's branch is added to additional visibility (if not
  //    already the primary or already listed). Doesn't displace anything.
  const onPickClient = (
    f: FormState,
    setF: (next: FormState) => void,
    clientId: string,
  ) => {
    const c = clients.find((x) => x.id === clientId);
    const cb = c?.branch_id ?? null;
    let primary = f.branch_id;
    let additional = f.additional_branch_ids;
    if (cb) {
      if (!primary) {
        primary = cb;
      } else if (cb !== primary && !additional.includes(cb)) {
        additional = [...additional, cb];
      }
    }
    setF({
      ...f,
      client_id: clientId,
      contract_id: "", // contracts are per-client; clear stale selection
      contract_line_id: "",
      branch_id: primary,
      additional_branch_ids: additional,
    });
  };

  const today = () => new Date().toISOString().slice(0, 10);

  // Contracts / lines available for a client (cascading selectors).
  const contractsForClient = (clientId: string): Contract[] =>
    contracts.filter((c) => c.client_id === clientId);
  const linesForContract = (contractId: string): ContractLine[] =>
    contractLines.filter((l) => l.contract_id === contractId);

  const lineCategoryById = useMemo(() => {
    const m = new Map<string, ContractLineCategory>();
    for (const l of contractLines) m.set(l.id, l.category);
    return m;
  }, [contractLines]);

  // Per-category slot picture for a line on a contract, as of today. Excludes a
  // given employee (so editing an employee already on the line doesn't count
  // them against themselves).
  const slotInfo = (contractId: string, lineId: string, excludeEmployeeId?: string) => {
    const cat = lineCategoryById.get(lineId);
    if (!cat) return null;
    const lines = linesForContract(contractId);
    const adds = addendums.filter((a) => a.contract_id === contractId);
    const committed = effectiveCommittedByCategory(lines, adds, today()).get(cat) ?? 0;
    const contractEmployees = employees.filter(
      (e) => e.contract_id === contractId && e.id !== excludeEmployeeId,
    );
    const active = activeCountByCategory(contractEmployees, lineCategoryById, today()).get(cat) ?? 0;
    return { category: cat, committed, active, available: Math.max(0, committed - active), full: active >= committed };
  };

  // Cascading Client → Contract → Contract Line selectors + assignment window.
  // Shared by the Add and Edit forms; `excludeEmployeeId` keeps an employee from
  // counting against their own slot when editing.
  const renderAssignmentFields = (
    f: FormState,
    setF: (next: FormState) => void,
    excludeEmployeeId?: string,
  ) => {
    const clientContracts = contractsForClient(f.client_id);
    const lines = f.contract_id ? linesForContract(f.contract_id) : [];
    const info = f.contract_line_id ? slotInfo(f.contract_id, f.contract_line_id, excludeEmployeeId) : null;
    return (
      <>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Contract</label>
          <ThemedSelect
            value={f.contract_id}
            onChange={(e) => setF({ ...f, contract_id: e.target.value, contract_line_id: "" })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
          >
            <option value="">— Unassigned —</option>
            {clientContracts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.contract_code} · {c.status}
              </option>
            ))}
          </ThemedSelect>
        </div>
        {f.contract_id && (
          <div>
            <label className="block text-sm text-slate-700 mb-1">Contract Line (category slot)</label>
            <ThemedSelect
              value={f.contract_line_id}
              onChange={(e) =>
                setF({
                  ...f,
                  contract_line_id: e.target.value,
                  assignment_effective_from: f.assignment_effective_from || f.join_date || today(),
                })
              }
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            >
              <option value="">— Select line —</option>
              {lines.map((l) => {
                const si = slotInfo(f.contract_id, l.id, excludeEmployeeId);
                return (
                  <option key={l.id} value={l.id}>
                    {CONTRACT_LINE_CATEGORY_LABEL[l.category]}
                    {l.location ? ` — ${l.location}` : ""}
                    {si ? ` · ${si.active}/${si.committed} filled` : ""}
                  </option>
                );
              })}
            </ThemedSelect>
            {lines.length === 0 && (
              <p className="text-xs text-warning-700 mt-1">
                This contract has no lines yet. Add category lines on the Contracts page first.
              </p>
            )}
            {info && (
              <p className={`text-xs mt-1 ${info.full ? "text-danger-600" : "text-slate-500"}`}>
                {CONTRACT_LINE_CATEGORY_LABEL[info.category]} slots: {info.active} of {info.committed} active —{" "}
                {info.available} available.
              </p>
            )}
          </div>
        )}
        {f.contract_line_id && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Assignment effective from</label>
              <input
                type="date"
                value={f.assignment_effective_from}
                onChange={(e) => setF({ ...f, assignment_effective_from: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
              <p className="text-[10px] text-slate-500 mt-1">When this employee starts filling the slot (may differ from join date).</p>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Effective to (optional)</label>
              <input
                type="date"
                value={f.assignment_effective_to}
                onChange={(e) => setF({ ...f, assignment_effective_to: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
              <p className="text-[10px] text-slate-500 mt-1">Leave blank while ongoing; set to free the slot from that date.</p>
            </div>
          </div>
        )}
      </>
    );
  };

  // Returns an error string if assigning to this line would exceed the
  // category's committed count; null if OK.
  const validateSlot = (f: FormState, excludeEmployeeId?: string): string | null => {
    if (f.category !== "client" || !f.contract_line_id) return null;
    const info = slotInfo(f.contract_id, f.contract_line_id, excludeEmployeeId);
    if (!info) return null;
    // Only blocks when the new assignment would be active now and the line is full.
    const willBeActiveNow =
      !f.assignment_effective_from || f.assignment_effective_from <= today();
    const endedAlready = f.assignment_effective_to && f.assignment_effective_to < today();
    if (willBeActiveNow && !endedAlready && info.full) {
      return `${CONTRACT_LINE_CATEGORY_LABEL[info.category]} slots: ${info.active} of ${info.committed} active — 0 available. Free a slot (mark one Inactive / end its assignment) or raise the committed count via an addendum.`;
    }
    return null;
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      if (
        q &&
        !e.full_name.toLowerCase().includes(q) &&
        !e.employee_code.toLowerCase().includes(q) &&
        !(e.phone ?? "").toLowerCase().includes(q)
      )
        return false;
      if (locationFilter !== "all" && e.location_id !== locationFilter) return false;
      if (clientFilter !== "all" && e.client_id !== clientFilter) return false;
      if (branchFilter !== "all") {
        // Null branch_id = "Head Office (default)"; treat it as the HO branch so
        // those employees show under the Head Office filter.
        const hoId = branches.find((b) => b.is_head_office)?.id;
        const effectivePrimary = e.branch_id ?? hoId ?? null;
        const inPrimary = effectivePrimary === branchFilter;
        const inAdditional = (e.additional_branch_ids ?? []).includes(branchFilter);
        if (!inPrimary && !inAdditional) return false;
      }
      if (categoryFilter !== "all" && (e.category ?? "client") !== categoryFilter) return false;
      if (shiftFilter !== "all" && e.shift !== shiftFilter) return false;
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (completenessFilter === "complete" && !e.physical_copy_present) return false;
      if (completenessFilter === "incomplete" && e.physical_copy_present) return false;
      if (lifecycleFilter !== "all" && e.lifecycle_state !== lifecycleFilter) return false;
      if (empTab === "active" && e.status !== "Active") return false;
      if (empTab === "inactive" && e.status === "Active") return false;
      return true;
    });
  }, [employees, search, locationFilter, clientFilter, branchFilter, categoryFilter, shiftFilter, statusFilter, completenessFilter, lifecycleFilter, empTab, branches]);

  type EmpRef = { id: string; employee_code: string; full_name: string };

  const uploadDoc = async (employee: EmpRef, docType: string, file: File) => {
    // SSA users (profile.company_id = null) come in via view_as_company.
    const effectiveCompanyId =
      profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!effectiveCompanyId || !company?.name) {
      throw new Error("Company not loaded — refresh and try again.");
    }
    const form = new FormData();
    form.append("file", file);
    form.append("category", "employees");
    form.append("company_id", effectiveCompanyId);
    form.append("company_name", company.name);
    form.append("entity_id", employee.id);
    form.append("entity_code", employee.employee_code);
    form.append("entity_name", employee.full_name);
    form.append("doc_type", docType);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "gdrive-upload",
      { body: form },
    );
    if (fnErr) {
      // supabase-js wraps non-2xx as FunctionsHttpError but stashes the actual
      // Response under .context. Read the JSON body so the real Drive error
      // bubbles up instead of "non-2xx status code".
      let detail = fnErr.message;
      try {
        const ctx = (fnErr as { context?: Response }).context;
        if (ctx) {
          const body = await ctx.clone().json();
          if (body?.error) detail = String(body.error);
        }
      } catch {}
      throw new Error(`Drive upload failed: ${detail}`);
    }
    if (!data?.drive_file_id) throw new Error(data?.error ?? "Upload failed");
    const { error: insErr } = await supabase.from("employee_documents").insert({
      employee_id: employee.id,
      doc_type: docType,
      file_name: data.file_name ?? file.name,
      storage_path: null,
      drive_file_id: data.drive_file_id,
      drive_view_url: data.drive_view_url,
      mime_type: data.mime_type ?? file.type,
      size_bytes: data.size_bytes ?? file.size,
    });
    if (insErr) throw insErr;
  };

  const deleteDocFiles = async (
    rows: { drive_file_id?: string | null; storage_path?: string | null }[],
  ) => {
    // Mixed cleanup: legacy rows go via Supabase storage, new rows via the
    // Drive edge function. Both succeed silently on missing files.
    const drivePromises = rows
      .filter((r) => r.drive_file_id)
      .map((r) =>
        supabase.functions.invoke("gdrive-delete", {
          body: { drive_file_id: r.drive_file_id },
        }),
      );
    const legacyPaths = rows
      .map((r) => r.storage_path)
      .filter((p): p is string => !!p);
    const storagePromise =
      legacyPaths.length > 0
        ? supabase.storage.from(EMPLOYEE_DOCS_BUCKET).remove(legacyPaths)
        : Promise.resolve();
    await Promise.all([...drivePromises, storagePromise]);
  };

  const replaceDoc = async (employee: EmpRef, docType: string, file: File) => {
    const { data: existing } = await supabase
      .from("employee_documents")
      .select("id, storage_path, drive_file_id")
      .eq("employee_id", employee.id)
      .eq("doc_type", docType);
    if (existing && existing.length > 0) {
      await deleteDocFiles(existing as any[]);
      await supabase
        .from("employee_documents")
        .delete()
        .in(
          "id",
          existing.map((d: any) => d.id)
        );
    }
    await uploadDoc(employee, docType, file);
  };

  const uploadDocs = async (employee: EmpRef, f: FormState) => {
    if (f.cnic) await replaceDoc(employee, "CNIC", f.cnic);
    if (f.police_verification) await replaceDoc(employee, "Police Verification", f.police_verification);
    if (f.other) {
      for (let i = 0; i < f.other.length; i++) {
        await uploadDoc(employee, "Other", f.other[i]);
      }
    }
  };

  // Toggle Active ↔ Inactive straight from the status badge (no Edit needed).
  // "On Leave" toggles to Active. Use the Edit form to set On Leave specifically.
  const [statusTogglingId, setStatusTogglingId] = useState<string | null>(null);
  const [statusConfirmTarget, setStatusConfirmTarget] = useState<EmployeeRow | null>(null);

  const requestStatusToggle = (emp: EmployeeRow) => {
    setStatusConfirmTarget(emp);
  };

  const confirmStatusToggle = async () => {
    if (!statusConfirmTarget) return;
    const emp = statusConfirmTarget;
    const next = emp.status === "Active" ? "Inactive" : "Active";
    setStatusConfirmTarget(null);
    setStatusTogglingId(emp.id);
    setError(null);
    const { error: upErr } = await supabase
      .from("employees")
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq("id", emp.id);
    setStatusTogglingId(null);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    await loadData();
  };

  const handleDelete = async (emp: EmployeeRow) => {
    const confirmed = window.confirm(
      `Delete ${emp.full_name} (${emp.employee_code})? This will permanently remove the employee and all their uploaded documents.`
    );
    if (!confirmed) return;
    setError(null);
    try {
      const { data: docs } = await supabase
        .from("employee_documents")
        .select("storage_path, drive_file_id")
        .eq("employee_id", emp.id);
      if (docs && docs.length > 0) {
        await deleteDocFiles(docs as any[]);
      }
      const { error: delErr } = await supabase.from("employees").delete().eq("id", emp.id);
      if (delErr) throw delErr;
      if (selectedEmployee?.id === emp.id) {
        setIsEditModalOpen(false);
        setIsViewModalOpen(false);
        setSelectedEmployee(null);
      }
      await loadData();
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  // "Bank Account Number" here accepts either a plain account number OR an IBAN
  // (its placeholder shows an IBAN), so only error when it fails both.
  const accountOrIbanError = (v: string): string | null => {
    if (!v || v.trim() === "") return null;
    if (validateBankAccount(v) === null || validateIban(v) === null) return null;
    return "Enter a valid account number or IBAN";
  };

  // Inline field errors for an employee form (null = OK).
  const computeEmployeeErrors = (f: FormState): Record<string, string | null> => ({
    full_name: validateFreeText(f.full_name),
    phone: validatePhone(f.phone),
    cnic_number: validateCnic(f.cnic_number),
    iban: validateIban(f.iban),
    bank_account: accountOrIbanError(f.bank_account),
    emergency_contact_phone: validatePhone(f.emergency_contact_phone),
    permanent_address: validateFreeText(f.permanent_address),
    current_address: validateFreeText(f.current_address),
  });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.full_name.trim()) return;
    if (form.category === "client" && !form.client_id) {
      setError("Select a client (or change category to Office Staff / Reliever).");
      return;
    }
    if (form.category === "client") {
      const sel = clients.find((c) => c.id === form.client_id);
      if (sel && !sel.employee_id_prefix) {
        setError(
          `Set an Employee ID Prefix for ${sel.name} before assigning employees. ` +
            `Edit the client to add one.`,
        );
        return;
      }
    }
    const errs = computeEmployeeErrors(form);
    if (Object.values(errs).some(Boolean)) {
      setFormErrors(errs);
      setError("Please fix the highlighted fields before saving.");
      return;
    }
    const slotErr = validateSlot(form);
    if (slotErr) {
      setError(slotErr);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { data, error: insErr } = await supabase
        .from("employees")
        .insert({
          full_name: form.full_name.trim(),
          phone: form.phone.trim() || null,
          location_id: form.location_id || null,
          client_id: form.category === "client" ? form.client_id : null,
          contract_id: form.category === "client" ? (form.contract_id || null) : null,
          contract_line_id: form.category === "client" ? (form.contract_line_id || null) : null,
          assignment_effective_from:
            form.category === "client" && form.contract_line_id
              ? (form.assignment_effective_from || form.join_date || today())
              : null,
          assignment_effective_to:
            form.category === "client" && form.contract_line_id ? (form.assignment_effective_to || null) : null,
          branch_id: form.branch_id || null,
          category: form.category,
          department: form.department.trim() || null,
          shift: form.shift,
          base_salary: form.base_salary ? Number(form.base_salary) : null,
          per_day_salary: form.per_day_salary ? Number(form.per_day_salary) : null,
          allowance: form.allowance ? Math.max(0, Number(form.allowance)) : 0,
          ...openingLeavesPayload(form.opening_leaves),
          join_date: form.join_date || null,
          bank_name: form.bank_name.trim() || null,
          bank_account: form.bank_account.trim() || null,
          cnic_number: form.cnic_number.trim() || null,
          date_of_birth: form.date_of_birth || null,
          father_or_husband_name: form.father_or_husband_name.trim() || null,
          blood_group: form.blood_group || null,
          permanent_address: form.permanent_address.trim() || null,
          current_address: form.current_address.trim() || null,
          emergency_contact_name: form.emergency_contact_name.trim() || null,
          emergency_contact_relation: form.emergency_contact_relation || null,
          emergency_contact_phone: form.emergency_contact_phone.trim() || null,
          reporting_to_employee_id: form.reporting_to_employee_id || null,
          employee_contract_type: form.employee_contract_type || null,
          probation_end_date: form.probation_end_date || null,
          weapon_licence_number: form.weapon_licence_number.trim() || null,
          weapon_licence_expiry: form.weapon_licence_expiry || null,
          guard_service_licence_number: form.guard_service_licence_number.trim() || null,
          guard_service_licence_expiry: form.guard_service_licence_expiry || null,
          medical_fitness_expiry: form.medical_fitness_expiry || null,
          eobi_registration_number: form.eobi_registration_number.trim() || null,
          iban: form.iban.trim() || null,
          ...paperFormPayload(form),
          // Recruitment intake: create as applicant/waitlisted when chosen; the DB
          // syncs status and further moves go through the lifecycle transition RPC.
          ...(form.lifecycle_intake ? { lifecycle_state: form.lifecycle_intake } : {}),
        })
        .select()
        .single();
      if (insErr) throw insErr;
      const newEmp = data as Employee;
      // Overwrite the throwaway EMP-XXXX the insert trigger minted with a
      // client-prefixed code ({prefix}-NNN), recording the first assignment in
      // history (old_code null so the temp EMP never shows there).
      if (form.category === "client" && form.client_id) {
        const { data: code, error: codeErr } = await supabase.rpc("assign_employee_code", {
          p_employee_id: newEmp.id,
          p_client_id: form.client_id,
          p_reason: "assigned",
          p_old_code: null,
        });
        if (codeErr) throw codeErr;
        if (code) newEmp.employee_code = code as string;
      }
      await uploadDocs(
        { id: newEmp.id, employee_code: newEmp.employee_code, full_name: newEmp.full_name },
        form,
      );
      await syncAdditionalBranches(newEmp.id, form.additional_branch_ids, form.branch_id);
      setForm(emptyForm);
      setFormErrors({});
      setIsModalOpen(false);
      await loadData();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Sync the employee_branches junction: delete rows not in the new set, insert
  // missing ones. Excludes the primary (it's implicit; never duplicated).
  const syncAdditionalBranches = async (
    employeeId: string,
    desiredIds: string[],
    primaryId: string
  ) => {
    const desired = new Set(desiredIds.filter((id) => id && id !== primaryId));
    const { data: existing, error: e1 } = await supabase
      .from("employee_branches")
      .select("branch_id")
      .eq("employee_id", employeeId);
    if (e1) throw e1;
    const have = new Set((existing ?? []).map((r: any) => r.branch_id as string));
    const toAdd = [...desired].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !desired.has(id));
    if (toRemove.length > 0) {
      const { error } = await supabase
        .from("employee_branches")
        .delete()
        .eq("employee_id", employeeId)
        .in("branch_id", toRemove);
      if (error) throw error;
    }
    if (toAdd.length > 0) {
      const rows = toAdd.map((branch_id) => ({ employee_id: employeeId, branch_id }));
      const { error } = await supabase.from("employee_branches").insert(rows);
      if (error) throw error;
    }
  };

  const openView = async (emp: EmployeeRow) => {
    setSelectedEmployee(emp);
    setSelectedDocs([]);
    setCodeHistory([]);
    setIsViewModalOpen(true);
    supabase
      .from("employee_code_history")
      .select("*")
      .eq("employee_id", emp.id)
      .order("changed_at", { ascending: false })
      .then(({ data: hist }) => setCodeHistory((hist ?? []) as EmployeeCodeHistory[]));
    const { data } = await supabase
      .from("employee_documents")
      .select("*")
      .eq("employee_id", emp.id)
      .order("uploaded_at", { ascending: false });
    const docs: DocumentWithUrl[] = (data ?? []).map((d: EmployeeDocument) => {
      // New uploads carry drive_view_url directly. Legacy rows still resolve
      // via Supabase storage.
      if (d.drive_view_url) {
        return { ...d, publicUrl: d.drive_view_url };
      }
      if (d.storage_path) {
        const { data: urlData } = supabase.storage
          .from(EMPLOYEE_DOCS_BUCKET)
          .getPublicUrl(d.storage_path);
        return { ...d, publicUrl: urlData.publicUrl };
      }
      return { ...d, publicUrl: null };
    });
    setSelectedDocs(docs);
  };

  // §11 branded 2-page form PDF: pull the repeating sections, then render.
  const downloadFormPdf = async (emp: EmployeeRow) => {
    const [c, r, j, d] = await Promise.all([
      supabase.from("employee_children").select("*").eq("employee_id", emp.id).order("created_at"),
      supabase.from("employee_references").select("*").eq("employee_id", emp.id),
      supabase.from("employee_previous_jobs").select("*").eq("employee_id", emp.id).order("seq"),
      supabase.from("employee_document_checklist").select("*").eq("employee_id", emp.id).order("doc_type"),
    ]);
    generateEmployeeFormPdf({
      employee: emp,
      companyName: company?.name ?? "Company",
      children: (c.data ?? []) as EmployeeChild[],
      references: (r.data ?? []) as EmployeeReference[],
      jobs: (j.data ?? []) as EmployeePreviousJob[],
      checklist: (d.data ?? []) as EmployeeDocumentChecklistItem[],
    });
  };

  const openEdit = (emp: EmployeeRow) => {
    setSelectedEmployee(emp);
    setEditStatus(emp.status);
    const baseStr = emp.base_salary != null ? String(emp.base_salary) : "";
    setEditForm({
      full_name: emp.full_name,
      phone: emp.phone ?? "",
      location_id: emp.location_id ?? "",
      client_id: emp.client_id ?? "",
      contract_id: emp.contract_id ?? "",
      contract_line_id: emp.contract_line_id ?? "",
      assignment_effective_from: emp.assignment_effective_from ?? "",
      assignment_effective_to: emp.assignment_effective_to ?? "",
      branch_id: emp.branch_id ?? "",
      additional_branch_ids: [...(emp.additional_branch_ids ?? [])],
      category: (emp.category ?? "client") as EmployeeCategory,
      department: emp.department ?? "",
      shift: emp.shift,
      base_salary: baseStr,
      per_day_salary: computePerDay(baseStr),
      allowance: emp.allowance != null ? String(emp.allowance) : "",
      opening_leaves: emp.opening_leaves != null ? String(emp.opening_leaves) : "",
      join_date: emp.join_date ?? "",
      bank_name: emp.bank_name ?? "",
      bank_account: emp.bank_account ?? "",
      cnic_number: emp.cnic_number ?? "",
      date_of_birth: emp.date_of_birth ?? "",
      father_or_husband_name: emp.father_or_husband_name ?? "",
      blood_group: emp.blood_group ?? "",
      permanent_address: emp.permanent_address ?? "",
      current_address: emp.current_address ?? "",
      emergency_contact_name: emp.emergency_contact_name ?? "",
      emergency_contact_relation: emp.emergency_contact_relation ?? "",
      emergency_contact_phone: emp.emergency_contact_phone ?? "",
      reporting_to_employee_id: emp.reporting_to_employee_id ?? "",
      employee_contract_type: emp.employee_contract_type ?? "",
      probation_end_date: emp.probation_end_date ?? "",
      weapon_licence_number: emp.weapon_licence_number ?? "",
      weapon_licence_expiry: emp.weapon_licence_expiry ?? "",
      guard_service_licence_number: emp.guard_service_licence_number ?? "",
      guard_service_licence_expiry: emp.guard_service_licence_expiry ?? "",
      medical_fitness_expiry: emp.medical_fitness_expiry ?? "",
      eobi_registration_number: emp.eobi_registration_number ?? "",
      iban: emp.iban ?? "",
      // §11 extended paper-form fields
      interview_date: emp.interview_date ?? "",
      form_serial_no: emp.form_serial_no ?? "",
      cnic_expiry: emp.cnic_expiry ?? "",
      education: emp.education ?? "",
      marital_status: emp.marital_status ?? "",
      height_cm: emp.height_cm != null ? String(emp.height_cm) : "",
      weight_kg: emp.weight_kg != null ? String(emp.weight_kg) : "",
      build: emp.build ?? "",
      uniform_size: emp.uniform_size ?? "",
      shoe_size: emp.shoe_size ?? "",
      special_skills: emp.special_skills ?? "",
      emergency_contact2_name: emp.emergency_contact2_name ?? "",
      emergency_contact2_relation: emp.emergency_contact2_relation ?? "",
      emergency_contact2_phone: emp.emergency_contact2_phone ?? "",
      post_office: emp.post_office ?? "",
      police_station: emp.police_station ?? "",
      area_nazim: emp.area_nazim ?? "",
      union_council: emp.union_council ?? "",
      spouse_name: emp.spouse_name ?? "",
      next_of_kin_name: emp.next_of_kin_name ?? "",
      next_of_kin_relation: emp.next_of_kin_relation ?? "",
      next_of_kin_cnic: emp.next_of_kin_cnic ?? "",
      next_of_kin_contact: emp.next_of_kin_contact ?? "",
      is_ex_serviceman: emp.is_ex_serviceman ?? false,
      physical_copy_present: emp.physical_copy_present ?? false,
      army_number: emp.army_number ?? "",
      service_unit: emp.service_unit ?? "",
      service_rank: emp.service_rank ?? "",
      service_trade: emp.service_trade ?? "",
      service_join_date: emp.service_join_date ?? "",
      service_discharge_date: emp.service_discharge_date ?? "",
      discharging_officer: emp.discharging_officer ?? "",
      weapons_trained: emp.weapons_trained ?? "",
      designation: emp.designation ?? "",
      project: emp.project ?? "",
      company_id_card_number: emp.company_id_card_number ?? "",
      social_security_status: emp.social_security_status ?? "",
      social_security_number: emp.social_security_number ?? "",
      insurance_provider: emp.insurance_provider ?? "",
      insurance_number: emp.insurance_number ?? "",
      remarks: emp.remarks ?? "",
      referral_source: emp.referral_source ?? "",
      referred_by_name: emp.referred_by_name ?? "",
      lifecycle_intake: "",
    });
    setEditFormErrors({});
    setIsEditModalOpen(true);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmployee) return;
    // The edit modal exposes the same structured fields (incl. the HR section's
    // CNIC/addresses/emergency phone), so validate the full set on save.
    const errs = computeEmployeeErrors(editForm);
    if (Object.values(errs).some(Boolean)) {
      setEditFormErrors(errs);
      setError("Please fix the highlighted fields before saving.");
      return;
    }
    // Slot check only blocks when this edit makes the employee newly active on a
    // full line — a still-active employee already counted on the line, or one
    // being marked Inactive, won't trip it.
    if (editStatus === "Active") {
      const slotErr = validateSlot(editForm, selectedEmployee.id);
      if (slotErr) {
        setError(slotErr);
        return;
      }
    }
    // Reassigning to a client with no prefix set can't produce an ID — block it
    // with the same message the create flow uses.
    if (editForm.category === "client" && editForm.client_id) {
      const sel = clients.find((c) => c.id === editForm.client_id);
      if (sel && !sel.employee_id_prefix) {
        setError(
          `Set an Employee ID Prefix for ${sel.name} before assigning employees. ` +
            `Edit the client to add one.`,
        );
        return;
      }
    }
    setEditing(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("employees")
        .update({
          full_name: editForm.full_name.trim(),
          phone: editForm.phone.trim() || null,
          location_id: editForm.location_id || null,
          client_id: editForm.category === "client" ? (editForm.client_id || null) : null,
          contract_id: editForm.category === "client" ? (editForm.contract_id || null) : null,
          contract_line_id: editForm.category === "client" ? (editForm.contract_line_id || null) : null,
          assignment_effective_from:
            editForm.category === "client" && editForm.contract_line_id
              ? (editForm.assignment_effective_from || editForm.join_date || today())
              : null,
          assignment_effective_to:
            editForm.category === "client" && editForm.contract_line_id
              ? (editForm.assignment_effective_to || null)
              : null,
          branch_id: editForm.branch_id || null,
          category: editForm.category,
          department: editForm.department.trim() || null,
          shift: editForm.shift,
          status: editStatus,
          base_salary: editForm.base_salary ? Number(editForm.base_salary) : null,
          per_day_salary: editForm.per_day_salary ? Number(editForm.per_day_salary) : null,
          allowance: editForm.allowance ? Math.max(0, Number(editForm.allowance)) : 0,
          // Opening leaves are one-time: only writable while still unset (null).
          // Once a value exists it's locked, so we omit it from the update.
          ...(selectedEmployee.opening_leaves == null
            ? openingLeavesPayload(editForm.opening_leaves)
            : {}),
          join_date: editForm.join_date || null,
          bank_name: editForm.bank_name.trim() || null,
          bank_account: editForm.bank_account.trim() || null,
          cnic_number: editForm.cnic_number.trim() || null,
          date_of_birth: editForm.date_of_birth || null,
          father_or_husband_name: editForm.father_or_husband_name.trim() || null,
          blood_group: editForm.blood_group || null,
          permanent_address: editForm.permanent_address.trim() || null,
          current_address: editForm.current_address.trim() || null,
          emergency_contact_name: editForm.emergency_contact_name.trim() || null,
          emergency_contact_relation: editForm.emergency_contact_relation || null,
          emergency_contact_phone: editForm.emergency_contact_phone.trim() || null,
          reporting_to_employee_id: editForm.reporting_to_employee_id || null,
          employee_contract_type: editForm.employee_contract_type || null,
          probation_end_date: editForm.probation_end_date || null,
          weapon_licence_number: editForm.weapon_licence_number.trim() || null,
          weapon_licence_expiry: editForm.weapon_licence_expiry || null,
          guard_service_licence_number: editForm.guard_service_licence_number.trim() || null,
          guard_service_licence_expiry: editForm.guard_service_licence_expiry || null,
          medical_fitness_expiry: editForm.medical_fitness_expiry || null,
          eobi_registration_number: editForm.eobi_registration_number.trim() || null,
          iban: editForm.iban.trim() || null,
          ...paperFormPayload(editForm),
        })
        .eq("id", selectedEmployee.id);
      if (upErr) throw upErr;
      // Moving to a different client regenerates the Employee ID from the new
      // client's prefix, preserving the old code in history. Same-client edits and
      // moves to a non-client category leave the code untouched.
      const reassigned =
        editForm.category === "client" &&
        !!editForm.client_id &&
        editForm.client_id !== selectedEmployee.client_id;
      if (reassigned) {
        const { error: codeErr } = await supabase.rpc("assign_employee_code", {
          p_employee_id: selectedEmployee.id,
          p_client_id: editForm.client_id,
          p_reason: "reassigned",
          p_old_code: selectedEmployee.employee_code,
        });
        if (codeErr) throw codeErr;
      }
      await uploadDocs(
        {
          id: selectedEmployee.id,
          employee_code: selectedEmployee.employee_code,
          // Use the freshly typed name so a renamed employee's first new upload
          // creates the folder with the updated label.
          full_name: editForm.full_name.trim() || selectedEmployee.full_name,
        },
        editForm,
      );
      await syncAdditionalBranches(selectedEmployee.id, editForm.additional_branch_ids, editForm.branch_id);
      setIsEditModalOpen(false);
      await loadData();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setEditing(false);
    }
  };

  return (
    <>
      <Header
        title="Employee Management"
        subtitle="Workforce roster, branches and document uploads"
        actions={
          <Button variant="primary" size="md" onClick={() => setIsModalOpen(true)}>
            <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
            Add Employee
          </Button>
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

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[200px] relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, phone, or employee ID..."
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <ThemedSelect
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Locations</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </ThemedSelect>
              <ClientFilterSelect
                clients={clients}
                value={clientFilter}
                onChange={setClientFilter}
                allValue="all"
              />
              <ThemedSelect
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Branches</option>
                {branchOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </ThemedSelect>
              <ThemedSelect
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as "all" | EmployeeCategory)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Categories</option>
                <option value="client">Client</option>
                <option value="office_staff">Office Staff</option>
                <option value="reliever">Reliever</option>
              </ThemedSelect>
              <ThemedSelect
                value={shiftFilter}
                onChange={(e) => setShiftFilter(e.target.value as "all" | "day" | "night" | "evening")}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Shifts</option>
                <option value="day">Day</option>
                <option value="night">Night</option>
                <option value="evening">Evening</option>
              </ThemedSelect>
              <ThemedSelect
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Status</option>
                <option value="Active">Active</option>
                <option value="On Leave">On Leave</option>
                <option value="Inactive">Inactive</option>
              </ThemedSelect>
              <ThemedSelect
                value={completenessFilter}
                onChange={(e) => setCompletenessFilter(e.target.value as "all" | "complete" | "incomplete")}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                title="Profile completeness"
              >
                <option value="all">All Profiles</option>
                <option value="complete">Complete</option>
                <option value="incomplete">Incomplete</option>
              </ThemedSelect>
              <ThemedSelect
                value={lifecycleFilter}
                onChange={(e) => setLifecycleFilter(e.target.value as "all" | EmployeeLifecycleState)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                title="Recruitment / lifecycle stage"
              >
                <option value="all">All Lifecycle</option>
                {(Object.keys(LIFECYCLE_STATE_LABEL) as EmployeeLifecycleState[]).map((s) => (
                  <option key={s} value={s}>{LIFECYCLE_STATE_LABEL[s]}</option>
                ))}
              </ThemedSelect>
            </div>
          </div>

          <div className="px-6 pt-4 flex gap-2">
            {([
              { v: "all", label: "All" },
              { v: "active", label: "Active" },
              { v: "inactive", label: "Inactive" },
            ] as const).map((t) => (
              <button
                key={t.v}
                type="button"
                onClick={() => setEmpTab(t.v)}
                className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                  empTab === t.v
                    ? "border-brand-600 bg-brand-50 text-brand-700"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-slate-50">
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground border-l-2 border-l-transparent">Employee ID</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Name</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Phone</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Location</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Branch</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Client / Category</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Shift</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Status</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sticky right-0 z-10 bg-slate-50 border-l border-border">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={9} className="px-6 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-6 py-10 text-center text-slate-500 text-sm">
                      No employees yet. Click "Add Employee" to create one.
                    </td>
                  </tr>
                )}
                {!loading &&
                  filtered.map((employee) => {
                    // Profile completeness is driven by the "Physical Copy Present"
                    // flag: incomplete → red row, complete → green row.
                    const incomplete = !employee.physical_copy_present;
                    return (
                    <tr
                      key={employee.id}
                      className="group border-b border-border transition-colors hover:bg-accent/50"
                      title={incomplete ? "Incomplete profile — physical document copies not on file" : "Complete profile"}
                    >
                      <td className={`px-6 py-3.5 text-sm font-mono border-l-2 ${incomplete ? "border-l-danger-500" : "border-l-transparent"}`}>
                        <span className={incomplete ? "text-danger-600 dark:text-danger-500" : "text-muted-foreground"}>{employee.employee_code}</span>
                      </td>
                      <td className="px-6 py-3.5 text-sm text-foreground">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{employee.full_name}</span>
                          {incomplete && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-danger-700 dark:text-danger-500 bg-danger-50 border border-danger-200 px-1.5 py-0.5 rounded-md">
                              <AlertCircle className="w-3 h-3" strokeWidth={2} />
                              Incomplete
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-3.5 text-sm text-muted-foreground tabular-nums">{employee.phone ?? "—"}</td>
                      <td className="px-6 py-3.5 text-sm text-muted-foreground">{employee.location_name ?? "—"}</td>
                      <td className="px-6 py-3.5 text-sm text-muted-foreground">{employee.branch_name ?? "—"}</td>
                      <td className="px-6 py-3.5 text-sm text-muted-foreground">
                        {(employee.category ?? "client") === "client" ? (
                          employee.client_name ?? "—"
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-secondary text-secondary-foreground border border-border capitalize">
                            {(employee.category ?? "client").replace("_", " ")}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-3.5">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border capitalize ${
                            employee.shift === "day"
                              ? "bg-warning-50 text-warning-700 dark:text-warning-500 border-warning-200"
                              : "bg-info-50 text-info-700 dark:text-info-500 border-info-200"
                          }`}
                        >
                          {employee.shift}
                        </span>
                      </td>
                      <td className="px-6 py-3.5">
                        <button
                          type="button"
                          disabled={statusTogglingId === employee.id}
                          onClick={() => requestStatusToggle(employee)}
                          title={employee.status === "Active" ? "Click to mark Inactive" : "Click to mark Active"}
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 ${
                            employee.status === "Active"
                              ? "bg-success-50 text-success-700 dark:text-success-500 border-success-200 hover:bg-success-100"
                              : employee.status === "On Leave"
                              ? "bg-warning-50 text-warning-700 dark:text-warning-500 border-warning-200 hover:bg-warning-100"
                              : "bg-secondary text-muted-foreground border-border hover:bg-accent"
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${employee.status === "Active" ? "bg-success-500" : employee.status === "On Leave" ? "bg-warning-500" : "bg-slate-400"}`} />
                          {employee.status}
                        </button>
                      </td>
                      <td className="px-6 py-3.5 sticky right-0 z-10 border-l border-border bg-card group-hover:bg-accent/50 transition-colors">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openView(employee)}>
                            View
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(employee)}>
                            Edit
                          </Button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Add Employee" size="lg">
        <form className="space-y-6" onSubmit={handleAdd}>
          <div>
            <h4 className="text-sm text-slate-900 mb-4">Basic Information</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Full Name *</label>
                <input
                  required
                  type="text"
                  value={form.full_name}
                  onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                  onBlur={(e) => setFormErrors((p) => ({ ...p, full_name: validateFreeText(e.target.value) }))}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="Enter full name"
                />
                {formErrors.full_name && <p className="text-xs text-danger-600 mt-1">{formErrors.full_name}</p>}
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Phone Number</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  onBlur={(e) => setFormErrors((p) => ({ ...p, phone: validatePhone(e.target.value) }))}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="+92 300 1234567"
                />
                {formErrors.phone && <p className="text-xs text-danger-600 mt-1">{formErrors.phone}</p>}
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Location</label>
                <ThemedSelect
                  value={form.location_id}
                  onChange={(e) => setForm({ ...form, location_id: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                >
                  <option value="">Select location</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </ThemedSelect>
                {locations.length === 0 && (
                  <p className="text-xs text-slate-500 mt-1">
                    No locations yet. Add them from Settings → Location Management.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Primary Branch</label>
                <ThemedSelect
                  value={form.branch_id}
                  onChange={(e) => {
                    const newBranch = e.target.value;
                    const cur = clients.find((c) => c.id === form.client_id);
                    const keepClient = !newBranch || !cur || cur.branch_id === newBranch;
                    // If the new primary was in additional, drop it from additional.
                    const additional = form.additional_branch_ids.filter((id) => id !== newBranch);
                    setForm({
                      ...form,
                      branch_id: newBranch,
                      additional_branch_ids: additional,
                      client_id: keepClient ? form.client_id : "",
                    });
                  }}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                >
                  <option value="">Head Office (default)</option>
                  {branchOptions.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </ThemedSelect>
                <p className="text-xs text-slate-500 mt-1">
                  Used for payroll routing, P&L attribution and cost ownership.
                </p>
              </div>
              <div className="col-span-2">
                <label className="block text-sm text-slate-700 mb-1">Additional Branches (visibility)</label>
                <div className="flex flex-wrap gap-2 p-2 border border-slate-200 rounded-md">
                  {branchOptions
                    .filter((b) => b.id !== form.branch_id)
                    .map((b) => {
                      const checked = form.additional_branch_ids.includes(b.id);
                      return (
                        <label
                          key={b.id}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer border ${
                            checked
                              ? "border-slate-900 bg-slate-50 text-slate-900"
                              : "border-slate-200 text-slate-600 hover:border-slate-300"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setForm({
                                ...form,
                                additional_branch_ids: checked
                                  ? form.additional_branch_ids.filter((id) => id !== b.id)
                                  : [...form.additional_branch_ids, b.id],
                              })
                            }
                            className="rounded border-slate-300"
                          />
                          {b.name}
                        </label>
                      );
                    })}
                  {branchOptions.filter((b) => b.id !== form.branch_id).length === 0 && (
                    <span className="text-xs text-slate-400">No other branches available.</span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Branched users in these branches can see this employee (read/edit) without owning the cost.
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Category *</label>
                <ThemedSelect
                  value={form.category}
                  onChange={(e) => {
                    const cat = e.target.value as EmployeeCategory;
                    setForm({ ...form, category: cat, client_id: cat === "client" ? form.client_id : "" });
                  }}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                >
                  <option value="client">Client</option>
                  <option value="office_staff">Office Staff</option>
                  <option value="reliever">Reliever</option>
                </ThemedSelect>
              </div>
              {form.category === "client" && (
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Client *</label>
                  <ThemedSelect
                    required
                    value={form.client_id}
                    onChange={(e) => onPickClient(form, setForm, e.target.value)}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  >
                    <option value="">Select client</option>
                    {clientsForBranch(form.branch_id).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </ThemedSelect>
                  {clientsForBranch(form.branch_id).length === 0 && (
                    <p className="text-xs text-slate-500 mt-1">
                      {form.branch_id
                        ? "No clients in this branch yet."
                        : "No clients yet. Add them from Settings → Client Management."}
                    </p>
                  )}
                </div>
              )}
              {form.category === "client" && form.client_id && (
                <div className="space-y-3">{renderAssignmentFields(form, setForm)}</div>
              )}
              <div>
                <label className="block text-sm text-slate-700 mb-1">Department</label>
                <input
                  type="text"
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="Enter department"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-sm text-slate-700 mb-2">Shift *</label>
                <div className="flex gap-3">
                  {(["day", "night", "evening"] as const).map((s) => (
                    <label
                      key={s}
                      className={`flex-1 flex items-center gap-2 px-4 py-2 border rounded-md cursor-pointer text-sm capitalize ${
                        form.shift === s
                          ? "border-slate-900 bg-slate-50"
                          : "border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <input
                        type="radio"
                        name="shift"
                        value={s}
                        checked={form.shift === s}
                        onChange={() => setForm({ ...form, shift: s })}
                      />
                      <span>{s} Shift</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200">
            <h4 className="text-sm text-slate-900 mb-4">Employment Details</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Base Salary (PKR)</label>
                <input
                  type="number"
                  value={form.base_salary}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm({ ...form, base_salary: v, per_day_salary: computePerDay(v) });
                  }}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="50000"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Per Day Salary (PKR)</label>
                <input
                  type="number"
                  disabled
                  value={form.per_day_salary}
                  readOnly
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50 text-slate-500 cursor-not-allowed"
                  placeholder="Auto = Base ÷ days in month"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Auto-computed: Base Salary ÷ {daysInCurrentMonth()} days this month.
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Allowance (PKR)</label>
                <input
                  type="number"
                  min={0}
                  value={form.allowance}
                  onChange={(e) => setForm({ ...form, allowance: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="0"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Always paid with salary, regardless of attendance.
                </p>
              </div>
              {form.category === "client" &&
                clients.find((c) => c.id === form.client_id)?.leave_carry_forward && (
                  <div>
                    <label className="block text-sm text-slate-700 mb-1">Opening Leaves</label>
                    <input
                      type="number"
                      min={0}
                      value={form.opening_leaves}
                      onChange={(e) => setForm({ ...form, opening_leaves: e.target.value })}
                      className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                      placeholder="0"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      One-time. Becomes the accumulated balance from this month forward
                      (overrides prior accrual), then rolls forward. Can't be changed later.
                    </p>
                  </div>
                )}
              <div>
                <label className="block text-sm text-slate-700 mb-1">Join Date</label>
                <input
                  type="date"
                  value={form.join_date}
                  onChange={(e) => setForm({ ...form, join_date: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Bank Name</label>
                <input
                  type="text"
                  value={form.bank_name}
                  onChange={(e) => setForm({ ...form, bank_name: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="e.g., Allied Bank"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Bank Account Number</label>
                <input
                  type="text"
                  value={form.bank_account}
                  onChange={(e) => setForm({ ...form, bank_account: e.target.value })}
                  onBlur={(e) => setFormErrors((p) => ({ ...p, bank_account: accountOrIbanError(e.target.value) }))}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="e.g., PK36SCBL0000001123456702"
                />
                {formErrors.bank_account && <p className="text-xs text-danger-600 mt-1">{formErrors.bank_account}</p>}
              </div>
              <div className="col-span-2">
                <label className="block text-sm text-slate-700 mb-1">IBAN (24 chars)</label>
                <input
                  type="text"
                  maxLength={24}
                  value={form.iban}
                  onChange={(e) => setForm({ ...form, iban: e.target.value.toUpperCase().replace(/\s+/g, "") })}
                  onBlur={(e) => setFormErrors((p) => ({ ...p, iban: validateIban(e.target.value) }))}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono"
                  placeholder="PKxx XXXX XXXX XXXX XXXX XXXX"
                />
                {formErrors.iban && <p className="text-xs text-danger-600 mt-1">{formErrors.iban}</p>}
                {form.iban && form.iban.length !== 24 && (
                  <p className="text-xs text-warning-700 mt-1">
                    Pakistani IBANs are 24 characters (currently {form.iban.length}).
                  </p>
                )}
              </div>
            </div>
          </div>

          <EmployeeHrSection
            form={form}
            setForm={setForm}
            employees={employees}
            errors={formErrors}
            onFieldBlur={(k, err) => setFormErrors((p) => ({ ...p, [k]: err }))}
          />

          <div className="pt-4 border-t border-slate-200">
            <h4 className="text-sm text-slate-900 mb-2">Recruitment Intake</h4>
            <ThemedSelect
              value={form.lifecycle_intake}
              onChange={(e) =>
                setForm({ ...form, lifecycle_intake: e.target.value as "" | "applicant" | "waitlisted" })
              }
              className="w-full md:w-1/2 px-4 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">Active hire (default)</option>
              <option value="applicant">Applicant</option>
              <option value="waitlisted">Waiting list</option>
            </ThemedSelect>
            <p className="text-xs text-slate-500 mt-1">
              Create as an applicant / waiting-list entry; promote later from the employee's Lifecycle panel.
            </p>
          </div>

          {renderPaperFormSections(form, setForm)}

          <div className="pt-4 border-t border-slate-200">
            <h4 className="text-sm text-slate-900 mb-4">Documents</h4>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-slate-700 mb-1">CNIC</label>
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    onChange={(e) => setForm({ ...form, cnic: e.target.files?.[0] })}
                    className="flex-1 px-4 py-2 border border-slate-200 rounded-md text-sm"
                  />
                  <Upload className="w-4 h-4 text-slate-400" strokeWidth={1.5} />
                </div>
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Police Verification</label>
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    onChange={(e) => setForm({ ...form, police_verification: e.target.files?.[0] })}
                    className="flex-1 px-4 py-2 border border-slate-200 rounded-md text-sm"
                  />
                  <Upload className="w-4 h-4 text-slate-400" strokeWidth={1.5} />
                </div>
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Other Documents</label>
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    multiple
                    onChange={(e) => setForm({ ...form, other: e.target.files ?? undefined })}
                    className="flex-1 px-4 py-2 border border-slate-200 rounded-md text-sm"
                  />
                  <Upload className="w-4 h-4 text-slate-400" strokeWidth={1.5} />
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting ? "Saving…" : "Add Employee"}
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isViewModalOpen}
        onClose={() => setIsViewModalOpen(false)}
        title="Employee Profile"
        size="lg"
      >
        {selectedEmployee && (
          <div className="space-y-6">
            <div className="flex justify-end">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => downloadFormPdf(selectedEmployee)}
              >
                <FileText className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Download Form PDF
              </Button>
            </div>
            <div>
              <h4 className="text-sm text-slate-900 mb-4">Basic Information</h4>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-slate-500 mb-1">Employee ID</p>
                  <p className="text-slate-900 font-mono">{selectedEmployee.employee_code}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Name</p>
                  <p className="text-slate-900">{selectedEmployee.full_name}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Phone</p>
                  <p className="text-slate-900">{selectedEmployee.phone ?? "—"}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Location</p>
                  <p className="text-slate-900">{selectedEmployee.location_name ?? "—"}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Branch</p>
                  <p className="text-slate-900">{selectedEmployee.branch_name ?? "—"}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Category</p>
                  <p className="text-slate-900 capitalize">
                    {(selectedEmployee.category ?? "client").replace("_", " ")}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Client</p>
                  <p className="text-slate-900">
                    {(selectedEmployee.category ?? "client") === "client"
                      ? selectedEmployee.client_name ?? "—"
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Department</p>
                  <p className="text-slate-900">{selectedEmployee.department ?? "—"}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Shift</p>
                  <p className="text-slate-900 capitalize">{selectedEmployee.shift}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Base Salary</p>
                  <p className="text-slate-900">
                    {selectedEmployee.base_salary != null
                      ? `PKR ${selectedEmployee.base_salary.toLocaleString()}`
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Per Day Salary</p>
                  <p className="text-slate-900">
                    {selectedEmployee.per_day_salary != null
                      ? `PKR ${selectedEmployee.per_day_salary.toLocaleString()}`
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Allowance</p>
                  <p className="text-slate-900">
                    {selectedEmployee.allowance
                      ? `PKR ${Number(selectedEmployee.allowance).toLocaleString()}`
                      : "—"}
                  </p>
                </div>
                {selectedEmployee.opening_leaves != null && (
                  <div>
                    <p className="text-slate-500 mb-1">Opening Leaves</p>
                    <p className="text-slate-900">
                      {selectedEmployee.opening_leaves}
                      {selectedEmployee.opening_leaves_month
                        ? ` (from ${formatDate(selectedEmployee.opening_leaves_month)})`
                        : ""}
                    </p>
                  </div>
                )}
                <div>
                  <p className="text-slate-500 mb-1">Join Date</p>
                  <p className="text-slate-900">{selectedEmployee.join_date ? formatDate(selectedEmployee.join_date) : "—"}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Bank Name</p>
                  <p className="text-slate-900">{selectedEmployee.bank_name ?? "—"}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Bank Account</p>
                  <p className="text-slate-900 font-mono">{selectedEmployee.bank_account ?? "—"}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Status</p>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs bg-success-50 text-success-700">
                    {selectedEmployee.status}
                  </span>
                </div>
              </div>
            </div>

            {codeHistory.length > 0 && (
              <div>
                <h4 className="text-sm text-slate-900 mb-2">Employee ID History</h4>
                {/* Only the most recent change is shown inline; older entries live
                    behind "View All Logs" so the panel doesn't grow unbounded. */}
                <CodeHistoryRow h={codeHistory[0]} />
                {codeHistory.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setHistoryModalOpen(true)}
                    className="mt-2 text-xs text-brand-600 hover:text-brand-700 underline"
                  >
                    View All Logs ({codeHistory.length})
                  </button>
                )}
              </div>
            )}

            <div className="pt-4 border-t border-slate-200">
              <h4 className="text-sm text-slate-900 mb-4">Documents</h4>
              {selectedDocs.length === 0 ? (
                <p className="text-sm text-slate-500">No documents uploaded yet.</p>
              ) : (
                <div className="space-y-2">
                  {selectedDocs.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between p-3 border border-slate-200 rounded-lg"
                    >
                      <div>
                        <p className="text-sm text-slate-900">{d.file_name}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{d.doc_type}</p>
                      </div>
                      {d.publicUrl && (
                        <a
                          href={d.publicUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm text-slate-700 hover:text-slate-900 underline"
                        >
                          View
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={historyModalOpen}
        onClose={() => setHistoryModalOpen(false)}
        title="Employee ID History"
        size="sm"
      >
        <ul className="space-y-3">
          {codeHistory.map((h) => (
            <li key={h.id} className="pb-3 border-b border-slate-100 last:border-0 last:pb-0">
              <CodeHistoryRow h={h} />
            </li>
          ))}
        </ul>
      </Modal>

      <Modal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        title="Edit Employee"
        size="lg"
      >
        {selectedEmployee && (
          <form className="space-y-6" onSubmit={handleEdit}>
            <IdentityVerificationPanel
              employee={selectedEmployee}
              onChanged={async () => {
                // Re-read the locked fields so the panel, the disabled inputs, and
                // editForm all reflect the amended/verified state. Keeping editForm
                // in step matters: a stale value would fail the DB identity lock on
                // the next ordinary save.
                const { data } = await supabase
                  .from("employees")
                  .select(
                    "identity_verified, identity_verified_at, full_name, father_or_husband_name, cnic_number, date_of_birth",
                  )
                  .eq("id", selectedEmployee.id)
                  .single();
                if (data) {
                  setSelectedEmployee({ ...selectedEmployee, ...(data as Partial<EmployeeRow>) } as EmployeeRow);
                  setEditForm((prev) => ({
                    ...prev,
                    full_name: (data as any).full_name ?? "",
                    father_or_husband_name: (data as any).father_or_husband_name ?? "",
                    cnic_number: (data as any).cnic_number ?? "",
                    date_of_birth: (data as any).date_of_birth ?? "",
                  }));
                }
                loadData();
              }}
            />
            <div>
              <h4 className="text-sm text-slate-900 mb-4">Basic Information</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Employee ID</label>
                  <input
                    type="text"
                    value={selectedEmployee.employee_code}
                    disabled
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50 text-slate-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Full Name</label>
                  <input
                    required
                    type="text"
                    disabled={!!selectedEmployee?.identity_verified}
                    value={editForm.full_name}
                    onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })}
                    onBlur={(e) => setEditFormErrors((p) => ({ ...p, full_name: validateFreeText(e.target.value) }))}
                    className={`w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent${selectedEmployee?.identity_verified ? " bg-slate-50 text-slate-500 cursor-not-allowed" : ""}`}
                  />
                  {editFormErrors.full_name && <p className="text-xs text-danger-600 mt-1">{editFormErrors.full_name}</p>}
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Phone Number</label>
                  <input
                    type="tel"
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                    onBlur={(e) => setEditFormErrors((p) => ({ ...p, phone: validatePhone(e.target.value) }))}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                  {editFormErrors.phone && <p className="text-xs text-danger-600 mt-1">{editFormErrors.phone}</p>}
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Location</label>
                  <ThemedSelect
                    value={editForm.location_id}
                    onChange={(e) => setEditForm({ ...editForm, location_id: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  >
                    <option value="">Select location</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </ThemedSelect>
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Primary Branch</label>
                  <ThemedSelect
                    value={editForm.branch_id}
                    onChange={(e) => {
                      const newBranch = e.target.value;
                      const cur = clients.find((c) => c.id === editForm.client_id);
                      const keepClient = !newBranch || !cur || cur.branch_id === newBranch;
                      const additional = editForm.additional_branch_ids.filter((id) => id !== newBranch);
                      setEditForm({
                        ...editForm,
                        branch_id: newBranch,
                        additional_branch_ids: additional,
                        client_id: keepClient ? editForm.client_id : "",
                      });
                    }}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  >
                    <option value="">Head Office (default)</option>
                    {branchOptions.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </ThemedSelect>
                  <p className="text-xs text-slate-500 mt-1">
                    Used for payroll routing and P&L attribution.
                  </p>
                </div>
                <div className="col-span-2">
                  <label className="block text-sm text-slate-700 mb-1">Additional Branches (visibility)</label>
                  <div className="flex flex-wrap gap-2 p-2 border border-slate-200 rounded-md">
                    {branchOptions
                      .filter((b) => b.id !== editForm.branch_id)
                      .map((b) => {
                        const checked = editForm.additional_branch_ids.includes(b.id);
                        return (
                          <label
                            key={b.id}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer border ${
                              checked
                                ? "border-slate-900 bg-slate-50 text-slate-900"
                                : "border-slate-200 text-slate-600 hover:border-slate-300"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setEditForm({
                                  ...editForm,
                                  additional_branch_ids: checked
                                    ? editForm.additional_branch_ids.filter((id) => id !== b.id)
                                    : [...editForm.additional_branch_ids, b.id],
                                })
                              }
                              className="rounded border-slate-300"
                            />
                            {b.name}
                          </label>
                        );
                      })}
                    {branchOptions.filter((b) => b.id !== editForm.branch_id).length === 0 && (
                      <span className="text-xs text-slate-400">No other branches available.</span>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Category</label>
                  <ThemedSelect
                    value={editForm.category}
                    onChange={(e) => {
                      const cat = e.target.value as EmployeeCategory;
                      setEditForm({ ...editForm, category: cat, client_id: cat === "client" ? editForm.client_id : "" });
                    }}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  >
                    <option value="client">Client</option>
                    <option value="office_staff">Office Staff</option>
                    <option value="reliever">Reliever</option>
                  </ThemedSelect>
                </div>
                {editForm.category === "client" && (
                  <div>
                    <label className="block text-sm text-slate-700 mb-1">Client</label>
                    <ThemedSelect
                      value={editForm.client_id}
                      onChange={(e) => onPickClient(editForm, setEditForm, e.target.value)}
                      className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                    >
                      <option value="">Select client</option>
                      {clientsForBranch(editForm.branch_id).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </ThemedSelect>
                  </div>
                )}
                {editForm.category === "client" && editForm.client_id && (
                  <div className="space-y-3">
                    {renderAssignmentFields(editForm, setEditForm, selectedEmployee?.id)}
                  </div>
                )}
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Department</label>
                  <input
                    type="text"
                    value={editForm.department}
                    onChange={(e) => setEditForm({ ...editForm, department: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Shift</label>
                  <ThemedSelect
                    value={editForm.shift}
                    onChange={(e) =>
                      setEditForm({ ...editForm, shift: e.target.value as "day" | "night" | "evening" })
                    }
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  >
                    <option value="day">Day</option>
                    <option value="night">Night</option>
                    <option value="evening">Evening</option>
                  </ThemedSelect>
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Base Salary (PKR)</label>
                  <input
                    type="number"
                    value={editForm.base_salary}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEditForm({ ...editForm, base_salary: v, per_day_salary: computePerDay(v) });
                    }}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Per Day Salary (PKR)</label>
                  <input
                    type="number"
                    disabled
                    readOnly
                    value={editForm.per_day_salary}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50 text-slate-500 cursor-not-allowed"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Auto-computed: Base Salary ÷ {daysInCurrentMonth()} days this month.
                  </p>
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Allowance (PKR)</label>
                  <input
                    type="number"
                    min={0}
                    value={editForm.allowance}
                    onChange={(e) => setEditForm({ ...editForm, allowance: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                    placeholder="0"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Always paid with salary, regardless of attendance.
                  </p>
                </div>
                {editForm.category === "client" &&
                  clients.find((c) => c.id === editForm.client_id)?.leave_carry_forward && (
                    <div>
                      <label className="block text-sm text-slate-700 mb-1">Opening Leaves</label>
                      <input
                        type="number"
                        min={0}
                        value={editForm.opening_leaves}
                        disabled={selectedEmployee?.opening_leaves != null}
                        readOnly={selectedEmployee?.opening_leaves != null}
                        onChange={(e) => setEditForm({ ...editForm, opening_leaves: e.target.value })}
                        className={
                          selectedEmployee?.opening_leaves != null
                            ? "w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50 text-slate-500 cursor-not-allowed"
                            : "w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                        }
                        placeholder="0"
                      />
                      <p className="text-xs text-slate-500 mt-1">
                        {selectedEmployee?.opening_leaves != null
                          ? `Locked — set once${
                              selectedEmployee.opening_leaves_month
                                ? `, effective ${formatDate(selectedEmployee.opening_leaves_month)}`
                                : ""
                            }.`
                          : "One-time. Becomes the accumulated balance from this month forward (overrides prior accrual), then rolls forward. Can't be changed later."}
                      </p>
                    </div>
                  )}
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Join Date</label>
                  <input
                    type="date"
                    value={editForm.join_date}
                    onChange={(e) => setEditForm({ ...editForm, join_date: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Bank Name</label>
                  <input
                    type="text"
                    value={editForm.bank_name}
                    onChange={(e) => setEditForm({ ...editForm, bank_name: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                    placeholder="e.g., Allied Bank"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Bank Account Number</label>
                  <input
                    type="text"
                    value={editForm.bank_account}
                    onChange={(e) => setEditForm({ ...editForm, bank_account: e.target.value })}
                    onBlur={(e) => setEditFormErrors((p) => ({ ...p, bank_account: accountOrIbanError(e.target.value) }))}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                    placeholder="e.g., PK36SCBL0000001123456702"
                  />
                  {editFormErrors.bank_account && <p className="text-xs text-danger-600 mt-1">{editFormErrors.bank_account}</p>}
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Status</label>
                  <ThemedSelect
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value as EmployeeRow["status"])}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  >
                    <option value="Active">Active</option>
                    <option value="On Leave">On Leave</option>
                    <option value="Inactive">Inactive</option>
                  </ThemedSelect>
                </div>
                <div className="col-span-2">
                  <label className="block text-sm text-slate-700 mb-1">IBAN (24 chars)</label>
                  <input
                    type="text"
                    maxLength={24}
                    value={editForm.iban}
                    onChange={(e) => setEditForm({ ...editForm, iban: e.target.value.toUpperCase().replace(/\s+/g, "") })}
                    onBlur={(e) => setEditFormErrors((p) => ({ ...p, iban: validateIban(e.target.value) }))}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono"
                    placeholder="PKxx XXXX XXXX XXXX XXXX XXXX"
                  />
                  {editFormErrors.iban && <p className="text-xs text-danger-600 mt-1">{editFormErrors.iban}</p>}
                </div>
              </div>
            </div>

            <EmployeeHrSection
              form={editForm}
              setForm={setEditForm}
              employees={employees}
              excludeEmployeeId={selectedEmployee?.id}
              errors={editFormErrors}
              onFieldBlur={(k, err) => setEditFormErrors((p) => ({ ...p, [k]: err }))}
              lockedIdentity={!!selectedEmployee?.identity_verified}
            />

            {renderPaperFormSections(editForm, setEditForm)}

            <EmployeeChildTables employeeId={selectedEmployee.id} />

            <EmployeeLifecyclePanel
              employee={selectedEmployee}
              onChanged={async () => {
                const { data } = await supabase
                  .from("employees")
                  .select(
                    "lifecycle_state, status, rehire_count, pending_termination_review, eligible_for_rehire, exit_date, exit_reason, blacklisted, police_verification_status, police_verification_date, nadra_verisys_status, nadra_verisys_date, orientation_done, weapons_certified, weapons_cert_expiry",
                  )
                  .eq("id", selectedEmployee.id)
                  .single();
                if (data) {
                  setSelectedEmployee({ ...selectedEmployee, ...(data as Partial<EmployeeRow>) } as EmployeeRow);
                }
                loadData();
              }}
            />

            <div className="pt-4 border-t border-slate-200">
              <h4 className="text-sm text-slate-900 mb-4">Add Documents</h4>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm text-slate-700 mb-1">CNIC</label>
                  <input
                    type="file"
                    onChange={(e) => setEditForm({ ...editForm, cnic: e.target.files?.[0] })}
                    className="flex-1 w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Police Verification</label>
                  <input
                    type="file"
                    onChange={(e) => setEditForm({ ...editForm, police_verification: e.target.files?.[0] })}
                    className="flex-1 w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Other Documents</label>
                  <input
                    type="file"
                    multiple
                    onChange={(e) => setEditForm({ ...editForm, other: e.target.files ?? undefined })}
                    className="flex-1 w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-4">
              <Button variant="primary" size="md" className="flex-1" disabled={editing}>
                {editing ? "Updating…" : "Update Employee"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsEditModalOpen(false)}>
                Cancel
              </Button>
              <button
                type="button"
                onClick={() => handleDelete(selectedEmployee)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm text-danger-700 hover:bg-danger-50 border border-danger-200"
              >
                <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                Delete
              </button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        isOpen={statusConfirmTarget !== null}
        onClose={() => setStatusConfirmTarget(null)}
        title="Confirm Status Change"
        size="sm"
      >
        {statusConfirmTarget && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Are you sure you want to mark{" "}
              <span className="text-slate-900 font-medium">
                {statusConfirmTarget.full_name}
              </span>{" "}
              ({statusConfirmTarget.employee_code}) as{" "}
              <span className="font-medium">
                {statusConfirmTarget.status === "Active" ? "Inactive" : "Active"}
              </span>
              ?
            </p>
            <div className="flex items-center gap-3 pt-2">
              <Button
                variant="primary"
                size="md"
                className="flex-1"
                onClick={confirmStatusToggle}
              >
                Yes, Mark {statusConfirmTarget.status === "Active" ? "Inactive" : "Active"}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => setStatusConfirmTarget(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function formatCnicInline(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 13);
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

// Header for the collapsible HR field groups. Declared at module scope (not nested inside
// EmployeeHrSection) so its component identity stays stable across renders.
function SectionHeader({
  open,
  onClick,
  title,
  hint,
}: {
  open: boolean;
  onClick: () => void;
  title: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 py-2 text-left text-sm text-slate-900 hover:text-brand-700"
    >
      {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
      <span className="flex-1">
        {title}
        {hint && <span className="text-xs text-slate-500 font-normal ml-2">{hint}</span>}
      </span>
    </button>
  );
}

// Collapsible HR/compliance fields appended to both Add and Edit employee
// forms. Spec section 3.3 + Appendix A.1.
// §11 identity lock: verify core identity, then amend individual fields only
// through a reasoned flow (audit-logged in the DB), or unverify with a reason.
// Core identity = full_name, father_or_husband_name, cnic_number, date_of_birth.
const IDENTITY_FIELDS: { key: string; label: string; type: "text" | "date" }[] = [
  { key: "full_name", label: "Full Name", type: "text" },
  { key: "father_or_husband_name", label: "Father / Husband Name", type: "text" },
  { key: "cnic_number", label: "CNIC Number", type: "text" },
  { key: "date_of_birth", label: "Date of Birth", type: "date" },
];

function IdentityVerificationPanel({
  employee,
  onChanged,
}: {
  employee: EmployeeRow;
  onChanged: () => void | Promise<void>;
}) {
  const [history, setHistory] = useState<EmployeeIdentityAmendment[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [amendKey, setAmendKey] = useState<string | null>(null);
  const [amendValue, setAmendValue] = useState("");
  const [amendReason, setAmendReason] = useState("");
  const [unverifyOpen, setUnverifyOpen] = useState(false);
  const [unverifyReason, setUnverifyReason] = useState("");

  const verified = !!employee.identity_verified;

  const loadHistory = useCallback(async () => {
    const { data } = await supabase
      .from("employee_identity_amendments")
      .select("*")
      .eq("employee_id", employee.id)
      .order("changed_at", { ascending: false });
    setHistory((data ?? []) as EmployeeIdentityAmendment[]);
  }, [employee.id]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true);
    setErr(null);
    const { error } = await fn();
    setBusy(false);
    if (error) {
      setErr(error.message);
      return false;
    }
    await loadHistory();
    await onChanged();
    return true;
  };

  const verify = () =>
    run(() => supabase.rpc("verify_employee_identity", { p_employee_id: employee.id }));

  const submitUnverify = async () => {
    if (!unverifyReason.trim()) {
      setErr("A reason is required to unverify.");
      return;
    }
    if (await run(() =>
      supabase.rpc("unverify_employee_identity", {
        p_employee_id: employee.id,
        p_reason: unverifyReason.trim(),
      }),
    )) {
      setUnverifyOpen(false);
      setUnverifyReason("");
    }
  };

  const startAmend = (key: string) => {
    setAmendKey(key);
    setAmendValue(String((employee as unknown as Record<string, unknown>)[key] ?? ""));
    setAmendReason("");
    setErr(null);
  };

  const submitAmend = async () => {
    if (!amendKey) return;
    if (!amendReason.trim()) {
      setErr("A reason is required to amend a verified identity field.");
      return;
    }
    if (await run(() =>
      supabase.rpc("amend_employee_identity", {
        p_employee_id: employee.id,
        p_field: amendKey,
        p_new_value: amendValue,
        p_reason: amendReason.trim(),
      }),
    )) {
      setAmendKey(null);
      setAmendValue("");
      setAmendReason("");
    }
  };

  return (
    <div className="border border-slate-200 rounded-md p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm text-slate-900">Identity Verification</h4>
          <p className="text-xs text-slate-500 mt-0.5">
            {verified
              ? "Core identity is locked — changes are logged amendments."
              : "Verify to lock name, father/husband, CNIC and date of birth."}
          </p>
        </div>
        {verified ? (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs bg-success-50 text-success-700 border border-success-200">
            Verified{employee.identity_verified_at ? ` · ${formatDate(employee.identity_verified_at.slice(0, 10))}` : ""}
          </span>
        ) : (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs bg-warning-50 text-warning-700 border border-warning-200">
            Not verified
          </span>
        )}
      </div>

      {err && <p className="text-xs text-danger-600 mt-2">{err}</p>}

      {!verified ? (
        <div className="mt-3">
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={verify}>
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Verify identity
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {IDENTITY_FIELDS.map((f) => {
            const current = String((employee as unknown as Record<string, unknown>)[f.key] ?? "") || "—";
            return (
              <div key={f.key} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{f.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-900 font-mono">{current}</span>
                    <button
                      type="button"
                      onClick={() => startAmend(f.key)}
                      className="text-xs text-brand-600 hover:text-brand-700 underline"
                    >
                      Amend
                    </button>
                  </div>
                </div>
                {amendKey === f.key && (
                  <div className="mt-2 p-2 bg-slate-50 rounded border border-slate-200 space-y-2">
                    <input
                      type={f.type}
                      value={amendValue}
                      onChange={(e) => setAmendValue(e.target.value)}
                      className={FIELD_CLS}
                      placeholder={`New ${f.label}`}
                    />
                    <input
                      type="text"
                      value={amendReason}
                      onChange={(e) => setAmendReason(e.target.value)}
                      className={FIELD_CLS}
                      placeholder="Reason for amendment (required)"
                    />
                    <div className="flex items-center gap-2">
                      <Button type="button" variant="primary" size="sm" disabled={busy} onClick={submitAmend}>
                        Save amendment
                      </Button>
                      <Button type="button" variant="secondary" size="sm" onClick={() => setAmendKey(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div className="pt-1">
            {unverifyOpen ? (
              <div className="p-2 bg-slate-50 rounded border border-slate-200 space-y-2">
                <input
                  type="text"
                  value={unverifyReason}
                  onChange={(e) => setUnverifyReason(e.target.value)}
                  className={FIELD_CLS}
                  placeholder="Reason for unverifying (required)"
                />
                <div className="flex items-center gap-2">
                  <Button type="button" variant="danger" size="sm" disabled={busy} onClick={submitUnverify}>
                    Confirm unverify
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setUnverifyOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setUnverifyOpen(true)}
                className="text-xs text-slate-500 hover:text-slate-700 underline"
              >
                Unverify identity
              </button>
            )}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <p className="text-xs text-slate-500 mb-2">Amendment history</p>
          <ul className="space-y-1.5">
            {history.map((h, i) => (
              <li key={i} className="text-xs text-slate-600 flex flex-wrap items-center gap-1.5">
                <span className="text-slate-500">{h.field}:</span>
                <span className="font-mono line-through text-slate-400">{h.old_value || "—"}</span>
                <span className="text-slate-400">→</span>
                <span className="font-mono text-slate-800">{h.new_value || "—"}</span>
                <span className="text-slate-400">
                  · {h.reason} · {formatDate(h.changed_at.slice(0, 10))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// §11 repeating sections (children / references / previous jobs / documents
// checklist). Edit-modal only — each row needs a persisted employee to hang off.
// The DB fills company_id on insert (trigger) and pre-seeds the 10 checklist rows.
const REFERENCE_SLOTS: { type: ReferenceType; label: string }[] = [
  { type: "uc_gazetted", label: "Reference 1 — UC / Gazetted Officer" },
  { type: "blood_relation", label: "Reference 2 — Blood Relation" },
];

function EmployeeChildTables({ employeeId }: { employeeId: string }) {
  const [children, setChildren] = useState<EmployeeChild[]>([]);
  const [refs, setRefs] = useState<EmployeeReference[]>([]);
  const [jobs, setJobs] = useState<EmployeePreviousJob[]>([]);
  const [checklist, setChecklist] = useState<EmployeeDocumentChecklistItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [newChild, setNewChild] = useState({ name: "", date_of_birth: "", gender: "" });

  const load = useCallback(async () => {
    const [c, r, j, d] = await Promise.all([
      supabase.from("employee_children").select("*").eq("employee_id", employeeId).order("created_at"),
      supabase.from("employee_references").select("*").eq("employee_id", employeeId),
      supabase.from("employee_previous_jobs").select("*").eq("employee_id", employeeId).order("seq"),
      supabase.from("employee_document_checklist").select("*").eq("employee_id", employeeId).order("doc_type"),
    ]);
    setChildren((c.data ?? []) as EmployeeChild[]);
    setRefs((r.data ?? []) as EmployeeReference[]);
    setJobs((j.data ?? []) as EmployeePreviousJob[]);
    setChecklist((d.data ?? []) as EmployeeDocumentChecklistItem[]);
  }, [employeeId]);

  useEffect(() => {
    load();
  }, [load]);

  const wrap = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await p;
    if (error) {
      setErr(error.message);
      return false;
    }
    setErr(null);
    await load();
    return true;
  };

  // --- Children ---
  const addChild = async () => {
    if (!newChild.name.trim()) return;
    if (
      await wrap(
        supabase.from("employee_children").insert({
          employee_id: employeeId,
          name: newChild.name.trim(),
          date_of_birth: newChild.date_of_birth || null,
          gender: newChild.gender || null,
        }),
      )
    ) {
      setNewChild({ name: "", date_of_birth: "", gender: "" });
    }
  };
  const deleteChild = (id: string) =>
    wrap(supabase.from("employee_children").delete().eq("id", id));

  // --- References (2 fixed slots, upsert on type) ---
  const refFor = (type: ReferenceType) => refs.find((r) => r.reference_type === type);
  const saveRef = (type: ReferenceType, patch: Partial<EmployeeReference>) => {
    const existing = refFor(type);
    return wrap(
      supabase.from("employee_references").upsert(
        {
          ...(existing ? { id: existing.id } : {}),
          employee_id: employeeId,
          reference_type: type,
          name: (patch.name ?? existing?.name ?? "").trim() || "—",
          cnic: patch.cnic ?? existing?.cnic ?? null,
          address: patch.address ?? existing?.address ?? null,
          contact: patch.contact ?? existing?.contact ?? null,
        },
        { onConflict: "employee_id,reference_type" },
      ),
    );
  };

  // --- Previous jobs (3 fixed slots, upsert on seq) ---
  const jobFor = (seq: number) => jobs.find((j) => j.seq === seq);
  const saveJob = (seq: number, patch: Partial<EmployeePreviousJob>) => {
    const existing = jobFor(seq);
    return wrap(
      supabase.from("employee_previous_jobs").upsert(
        {
          ...(existing ? { id: existing.id } : {}),
          employee_id: employeeId,
          seq,
          employer: patch.employer ?? existing?.employer ?? null,
          designation: patch.designation ?? existing?.designation ?? null,
          from_date: patch.from_date ?? existing?.from_date ?? null,
          to_date: patch.to_date ?? existing?.to_date ?? null,
          reason_for_leaving: patch.reason_for_leaving ?? existing?.reason_for_leaving ?? null,
        },
        { onConflict: "employee_id,seq" },
      ),
    );
  };

  // --- Checklist (rows pre-seeded; toggle received + notes) ---
  const setChecklistItem = (id: string, patch: Partial<EmployeeDocumentChecklistItem>) =>
    wrap(supabase.from("employee_document_checklist").update(patch).eq("id", id));

  return (
    <div className="pt-4 border-t border-slate-200 space-y-6">
      <h4 className="text-sm text-slate-900">Paper-Form Records</h4>
      {err && <p className="text-xs text-danger-600">{err}</p>}

      {/* Children */}
      <div>
        <p className="text-sm text-slate-700 mb-2">Children</p>
        {children.length > 0 && (
          <ul className="space-y-1 mb-2">
            {children.map((c) => (
              <li key={c.id} className="flex items-center justify-between text-sm text-slate-700">
                <span>
                  {c.name}
                  {c.date_of_birth ? ` · ${formatDate(c.date_of_birth)}` : ""}
                  {c.gender ? ` · ${c.gender}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => deleteChild(c.id)}
                  className="text-xs text-danger-600 hover:text-danger-700"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
          <input
            className={FIELD_CLS}
            placeholder="Child name"
            value={newChild.name}
            onChange={(e) => setNewChild({ ...newChild, name: e.target.value })}
          />
          <input
            type="date"
            className={FIELD_CLS}
            value={newChild.date_of_birth}
            onChange={(e) => setNewChild({ ...newChild, date_of_birth: e.target.value })}
          />
          <input
            className={FIELD_CLS + " w-24"}
            placeholder="Gender"
            value={newChild.gender}
            onChange={(e) => setNewChild({ ...newChild, gender: e.target.value })}
          />
          <Button type="button" variant="secondary" size="sm" onClick={addChild}>
            Add
          </Button>
        </div>
      </div>

      {/* References */}
      <div>
        <p className="text-sm text-slate-700 mb-2">References</p>
        <div className="space-y-3">
          {REFERENCE_SLOTS.map((slot) => {
            const r = refFor(slot.type);
            return (
              <div key={slot.type} className="border border-slate-200 rounded-md p-3">
                <p className="text-xs text-slate-500 mb-2">{slot.label}</p>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className={FIELD_CLS}
                    placeholder="Name"
                    defaultValue={r?.name ?? ""}
                    onBlur={(e) => saveRef(slot.type, { name: e.target.value })}
                  />
                  <input
                    className={FIELD_CLS}
                    placeholder="CNIC"
                    defaultValue={r?.cnic ?? ""}
                    onBlur={(e) => saveRef(slot.type, { cnic: e.target.value })}
                  />
                  <input
                    className={FIELD_CLS}
                    placeholder="Contact"
                    defaultValue={r?.contact ?? ""}
                    onBlur={(e) => saveRef(slot.type, { contact: e.target.value })}
                  />
                  <input
                    className={FIELD_CLS}
                    placeholder="Address"
                    defaultValue={r?.address ?? ""}
                    onBlur={(e) => saveRef(slot.type, { address: e.target.value })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Previous jobs */}
      <div>
        <p className="text-sm text-slate-700 mb-2">Previous Employment (up to 3)</p>
        <div className="space-y-3">
          {[1, 2, 3].map((seq) => {
            const j = jobFor(seq);
            return (
              <div key={seq} className="border border-slate-200 rounded-md p-3">
                <p className="text-xs text-slate-500 mb-2">Job {seq}</p>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className={FIELD_CLS}
                    placeholder="Employer"
                    defaultValue={j?.employer ?? ""}
                    onBlur={(e) => saveJob(seq, { employer: e.target.value })}
                  />
                  <input
                    className={FIELD_CLS}
                    placeholder="Designation"
                    defaultValue={j?.designation ?? ""}
                    onBlur={(e) => saveJob(seq, { designation: e.target.value })}
                  />
                  <input
                    type="date"
                    className={FIELD_CLS}
                    defaultValue={j?.from_date ?? ""}
                    onBlur={(e) => saveJob(seq, { from_date: e.target.value || null })}
                  />
                  <input
                    type="date"
                    className={FIELD_CLS}
                    defaultValue={j?.to_date ?? ""}
                    onBlur={(e) => saveJob(seq, { to_date: e.target.value || null })}
                  />
                  <input
                    className={FIELD_CLS + " col-span-2"}
                    placeholder="Reason for leaving"
                    defaultValue={j?.reason_for_leaving ?? ""}
                    onBlur={(e) => saveJob(seq, { reason_for_leaving: e.target.value })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Documents checklist */}
      <div>
        <p className="text-sm text-slate-700 mb-2">Documents Checklist</p>
        <ul className="space-y-1.5">
          {checklist.map((item) => (
            <li key={item.id} className="flex items-center gap-3 text-sm">
              <label className="flex items-center gap-2 flex-1 text-slate-700">
                <input
                  type="checkbox"
                  checked={item.received}
                  onChange={(e) => setChecklistItem(item.id, { received: e.target.checked })}
                />
                <span>{CHECKLIST_DOC_LABEL[item.doc_type]}</span>
              </label>
              <input
                className={FIELD_CLS + " max-w-[40%]"}
                placeholder="Notes"
                defaultValue={item.notes ?? ""}
                onBlur={(e) => setChecklistItem(item.id, { notes: e.target.value })}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function EmployeeHrSection({
  form,
  setForm,
  employees,
  excludeEmployeeId,
  errors,
  onFieldBlur,
  lockedIdentity = false,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  employees: EmployeeRow[];
  excludeEmployeeId?: string;
  // Inline validation wiring (shared by the add + edit forms).
  errors: Record<string, string | null>;
  onFieldBlur: (key: string, err: string | null) => void;
  // §11: once identity is verified, CNIC / DOB / father-name lock here and can
  // only change through the Identity Verification panel's amend flow.
  lockedIdentity?: boolean;
}) {
  const lockCls = lockedIdentity ? " bg-slate-50 text-slate-500 cursor-not-allowed" : "";
  const [openPersonal, setOpenPersonal] = useState(false);
  const [openEmergency, setOpenEmergency] = useState(false);
  const [openEmployment, setOpenEmployment] = useState(false);
  const [openLicences, setOpenLicences] = useState(false);

  const supervisorOptions = useMemo(
    () => employees.filter((e) => e.id !== excludeEmployeeId && e.status === "Active"),
    [employees, excludeEmployeeId],
  );

  return (
    <div className="pt-4 border-t border-slate-200">
      <h4 className="text-sm text-slate-900 mb-2">HR Details & Compliance</h4>
      <p className="text-xs text-slate-500 mb-3">
        Optional Pakistani-HR-compliant fields. Expiry dates feed the Compliance Calendar.
      </p>

      {/* Personal */}
      <div className="border-t border-slate-100">
        <SectionHeader open={openPersonal} onClick={() => setOpenPersonal((v) => !v)} title="Personal Information" />
        {openPersonal && (
          <div className="grid grid-cols-2 gap-3 pb-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">CNIC Number</label>
              <input
                type="text"
                maxLength={15}
                disabled={lockedIdentity}
                value={form.cnic_number}
                onChange={(e) => setForm({ ...form, cnic_number: formatCnicInline(e.target.value) })}
                onBlur={(e) => onFieldBlur("cnic_number", validateCnic(e.target.value))}
                className={"w-full px-3 py-2 border border-slate-200 rounded-md text-sm font-mono" + lockCls}
                placeholder="XXXXX-XXXXXXX-X"
              />
              {errors.cnic_number && <p className="text-xs text-danger-600 mt-1">{errors.cnic_number}</p>}
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Date of Birth</label>
              <input
                type="date"
                disabled={lockedIdentity}
                value={form.date_of_birth}
                onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
                className={"w-full px-3 py-2 border border-slate-200 rounded-md text-sm" + lockCls}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Father / Husband Name</label>
              <input
                type="text"
                disabled={lockedIdentity}
                value={form.father_or_husband_name}
                onChange={(e) => setForm({ ...form, father_or_husband_name: e.target.value })}
                className={"w-full px-3 py-2 border border-slate-200 rounded-md text-sm" + lockCls}
                placeholder="As per CNIC"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Blood Group</label>
              <ThemedSelect
                value={form.blood_group}
                onChange={(e) => setForm({ ...form, blood_group: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">—</option>
                {BLOOD_GROUPS.map((bg) => (
                  <option key={bg} value={bg}>{bg}</option>
                ))}
              </ThemedSelect>
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Permanent Address</label>
              <textarea
                rows={2}
                value={form.permanent_address}
                onChange={(e) => setForm({ ...form, permanent_address: e.target.value })}
                onBlur={(e) => onFieldBlur("permanent_address", validateFreeText(e.target.value))}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
              {errors.permanent_address && <p className="text-xs text-danger-600 mt-1">{errors.permanent_address}</p>}
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Current Address</label>
              <textarea
                rows={2}
                value={form.current_address}
                onChange={(e) => setForm({ ...form, current_address: e.target.value })}
                onBlur={(e) => onFieldBlur("current_address", validateFreeText(e.target.value))}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="Leave blank to default to permanent address"
              />
              {errors.current_address && <p className="text-xs text-danger-600 mt-1">{errors.current_address}</p>}
            </div>
          </div>
        )}
      </div>

      {/* Emergency Contact */}
      <div className="border-t border-slate-100">
        <SectionHeader
          open={openEmergency}
          onClick={() => setOpenEmergency((v) => !v)}
          title="Emergency Contact"
          hint="Required by labour regulations"
        />
        {openEmergency && (
          <div className="grid grid-cols-3 gap-3 pb-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Name</label>
              <input
                type="text"
                value={form.emergency_contact_name}
                onChange={(e) => setForm({ ...form, emergency_contact_name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Relation</label>
              <ThemedSelect
                value={form.emergency_contact_relation}
                onChange={(e) => setForm({ ...form, emergency_contact_relation: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">—</option>
                {EMERGENCY_CONTACT_RELATIONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Phone</label>
              <input
                type="tel"
                value={form.emergency_contact_phone}
                onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })}
                onBlur={(e) => onFieldBlur("emergency_contact_phone", validatePhone(e.target.value))}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="+92 …"
              />
              {errors.emergency_contact_phone && <p className="text-xs text-danger-600 mt-1">{errors.emergency_contact_phone}</p>}
            </div>
          </div>
        )}
      </div>

      {/* Employment specifics */}
      <div className="border-t border-slate-100">
        <SectionHeader open={openEmployment} onClick={() => setOpenEmployment((v) => !v)} title="Contract & Reporting" />
        {openEmployment && (
          <div className="grid grid-cols-2 gap-3 pb-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Contract Type</label>
              <ThemedSelect
                value={form.employee_contract_type}
                onChange={(e) =>
                  setForm({ ...form, employee_contract_type: e.target.value as FormState["employee_contract_type"] })
                }
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">—</option>
                <option value="permanent">Permanent</option>
                <option value="contract">Contract</option>
                <option value="probation">Probation</option>
                <option value="daily_wages">Daily Wages</option>
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Probation End Date</label>
              <input
                type="date"
                value={form.probation_end_date}
                onChange={(e) => setForm({ ...form, probation_end_date: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                disabled={form.employee_contract_type !== "probation"}
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Reporting To (supervisor)</label>
              <ThemedSelect
                value={form.reporting_to_employee_id}
                onChange={(e) => setForm({ ...form, reporting_to_employee_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">— Nobody —</option>
                {supervisorOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.full_name} ({e.employee_code})
                  </option>
                ))}
              </ThemedSelect>
            </div>
          </div>
        )}
      </div>

      {/* Licences & Compliance */}
      <div className="border-t border-slate-100">
        <SectionHeader
          open={openLicences}
          onClick={() => setOpenLicences((v) => !v)}
          title="Licences & Compliance"
          hint="Expiry dates feed Compliance Calendar"
        />
        {openLicences && (
          <div className="grid grid-cols-2 gap-3 pb-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Weapon Licence #</label>
              <input
                type="text"
                value={form.weapon_licence_number}
                onChange={(e) => setForm({ ...form, weapon_licence_number: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Weapon Licence Expiry</label>
              <input
                type="date"
                value={form.weapon_licence_expiry}
                onChange={(e) => setForm({ ...form, weapon_licence_expiry: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Guard Service Licence #</label>
              <input
                type="text"
                value={form.guard_service_licence_number}
                onChange={(e) => setForm({ ...form, guard_service_licence_number: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Guard Service Licence Expiry</label>
              <input
                type="date"
                value={form.guard_service_licence_expiry}
                onChange={(e) => setForm({ ...form, guard_service_licence_expiry: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Medical Fitness Expiry</label>
              <input
                type="date"
                value={form.medical_fitness_expiry}
                onChange={(e) => setForm({ ...form, medical_fitness_expiry: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">EOBI Registration #</label>
              <input
                type="text"
                value={form.eobi_registration_number}
                onChange={(e) => setForm({ ...form, eobi_registration_number: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="Once issued"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
