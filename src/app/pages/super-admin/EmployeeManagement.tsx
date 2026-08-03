import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Plus, Search, Upload, AlertCircle, Loader2, X, Trash2, ChevronDown, ChevronRight as ChevronRightIcon, FileText, SlidersHorizontal, Image as ImageIcon, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import jsPDF from "jspdf";
import { generateEmployeeFormPdf, type FormApprovals } from "../../lib/employeeFormPdf";
import { generateIdCardPdf } from "../../lib/idCardPdf";
import { brandingFromCompany, type PdfBranding } from "../../lib/pdfBranding";
import EmployeeLifecyclePanel from "../../components/EmployeeLifecyclePanel";
import Header from "../../components/Header";
import { formatDate } from "../../lib/date";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import Tabs from "../../components/Tabs";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import { useRegion, withRegion } from "../../lib/region";
import { isSeparatedState, lifecycleStatusLabel } from "../../lib/employmentWindow";
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
  PK_BANKS,
  pkBankCode,
} from "../../lib/validation";
import { useAuth, hasPermission } from "../../lib/auth";
import { generateDischargeSheet } from "../../lib/dischargeSheetPdf";

export type EmployeeRow = Employee & {
  location_name: string | null;
  client_name: string | null;
  branch_name: string | null;
  additional_branch_ids: string[];
  doc_count: number;
};
type DocumentWithUrl = EmployeeDocument & { publicUrl: string | null };

// Filter options for the lifecycle dropdown, one per distinct LABEL. Two states
// (terminated / fired) share the label "Fired" — legacy and current naming for the
// same outcome — so listing raw keys showed "Fired" twice, with each entry hiding
// the rows belonging to the other. `states` holds every key behind one option.
const LIFECYCLE_FILTER_OPTIONS: {
  value: EmployeeLifecycleState;
  label: string;
  states: EmployeeLifecycleState[];
}[] = (() => {
  const byLabel = new Map<string, EmployeeLifecycleState[]>();
  for (const s of Object.keys(LIFECYCLE_STATE_LABEL) as EmployeeLifecycleState[]) {
    const label = LIFECYCLE_STATE_LABEL[s];
    const seen = byLabel.get(label);
    if (seen) seen.push(s);
    else byLabel.set(label, [s]);
  }
  return [...byLabel].map(([label, states]) => ({ value: states[0], label, states }));
})();

const LIFECYCLE_FILTER_STATES = new Map(
  LIFECYCLE_FILTER_OPTIONS.map((o) => [o.value, o.states]),
);

const CODE_HISTORY_REASON: Record<EmployeeCodeHistory["reason"], string> = {
  assigned: "assigned",
  reassigned: "reassigned",
  prefix_changed: "prefix changed",
};

// One "OLD → NEW, reason · date" line. Shared by the inline latest-only view and
// the full "View All Logs" modal.
function CodeHistoryRow({ h }: { h: EmployeeCodeHistory }) {
  // A permanent-code transfer has old_code === new_code (the code doesn't change
  // on client reassignment anymore) — render just the code, not a "X → X" arrow.
  const codeChanged = !!h.old_code && h.old_code !== h.new_code;
  return (
    <div className="flex items-center gap-2 flex-wrap text-sm text-slate-700">
      {codeChanged ? (
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
  photo_url: string;
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
  photo_url: "",
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
  photo_url: f.photo_url || null,
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

// CNIC and Join Date are mandatory (see computeEmployeeErrors). Records created
// before that rule can still be missing them, and both matter downstream — the
// CNIC is the identity key, the join date opens the attendance window — so they
// are flagged in the list and countable from the headline tiles.
const isMissingKeyFields = (e: { cnic_number: string | null; join_date: string | null }): boolean =>
  !e.cnic_number?.trim() || !e.join_date;

// Human labels for the validated employee fields, keyed by their form key. Used
// by the in-modal error summary so a failed save names the exact fields.
const EMPLOYEE_FIELD_LABELS: Record<string, string> = {
  full_name: "Full Name",
  client_id: "Client",
  phone: "Phone Number",
  cnic_number: "CNIC Number",
  iban: "IBAN",
  bank_account: "Bank Account",
  emergency_contact_phone: "Emergency Contact Phone",
  permanent_address: "Permanent Address",
  current_address: "Current Address",
};

// Lists the fields that failed validation as clickable chips. Clicking one
// scrolls the matching input into view (by DOM id `${idPrefix}${fieldKey}`) and
// focuses it, so the operator is taken straight to what needs fixing.
function FieldErrorSummary({
  errors,
  idPrefix,
}: {
  errors: Record<string, string | null>;
  idPrefix: string;
}) {
  const bad = Object.entries(errors)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k);
  if (bad.length === 0) return null;
  const jump = (key: string) => {
    const el = document.getElementById(idPrefix + key) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // preventScroll so the smooth scroll above isn't overridden by focus().
    (el as HTMLInputElement).focus?.({ preventScroll: true });
  };
  return (
    <div className="rounded-md border border-danger-200 bg-danger-50 p-3">
      <p className="text-sm text-danger-700 mb-2">
        Please fix {bad.length} field{bad.length > 1 ? "s" : ""} before saving — tap to jump:
      </p>
      <div className="flex flex-wrap gap-2">
        {bad.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => jump(key)}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-danger-300 bg-white text-danger-700 hover:bg-danger-100 transition-colors"
          >
            {EMPLOYEE_FIELD_LABELS[key] ?? key}
            <span className="text-danger-400">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function EmployeeManagement() {
  const { profile, company } = useAuth();
  const { regionId } = useRegion();
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [contractLines, setContractLines] = useState<ContractLine[]>([]);
  // Phase 4: the ONLY way to move a guard between clients (or shifts) — a dated
  // posting change (close current row, open new). Never edited in place.
  const [changeClientTarget, setChangeClientTarget] = useState<EmployeeRow | null>(null);
  // §7.5: dated shift change — closes the old-shift posting, opens a new one.
  const [changeShiftTarget, setChangeShiftTarget] = useState<EmployeeRow | null>(null);
  // Category change (reliever / client / office_staff) — same dated-posting model.
  const [changeCategoryTarget, setChangeCategoryTarget] = useState<EmployeeRow | null>(null);
  // Phase 7 §9: separation / rehire.
  const [separationTarget, setSeparationTarget] = useState<EmployeeRow | null>(null);
  const [rehireTarget, setRehireTarget] = useState<EmployeeRow | null>(null);
  // Phase 8 §11.3: bulk document generation over the filtered set.
  const [bulkOpen, setBulkOpen] = useState(false);
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
  // Show only employees whose CNIC card has expired.
  const [expiredCardFilter, setExpiredCardFilter] = useState<"all" | "expired">("all");
  const [dupCnicFilter, setDupCnicFilter] = useState<"all" | "duplicate">("all");
  // Records missing a mandatory identity field (CNIC and/or Join Date). Driven
  // by the headline tile, which doubles as the toggle.
  const [missingKeyFilter, setMissingKeyFilter] = useState<"all" | "missing">("all");
  // Quick Active / Inactive tab split (Inactive = anything not currently Active).
  const [empTab, setEmpTab] = useState<"all" | "active" | "inactive">("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Sort by the NUMERIC part of the client-prefixed display code (= display_number
  // integer column). null = default load order (newest-first); asc = 001 first.
  const [sortDir, setSortDir] = useState<null | "asc" | "desc">(null);
  const activeFilterCount =
    (locationFilter !== "all" ? 1 : 0) +
    (clientFilter !== "all" ? 1 : 0) +
    (branchFilter !== "all" ? 1 : 0) +
    (categoryFilter !== "all" ? 1 : 0) +
    (shiftFilter !== "all" ? 1 : 0) +
    (statusFilter !== "all" ? 1 : 0) +
    (completenessFilter !== "all" ? 1 : 0) +
    (lifecycleFilter !== "all" ? 1 : 0) +
    (expiredCardFilter !== "all" ? 1 : 0) +
    (dupCnicFilter !== "all" ? 1 : 0) +
    (missingKeyFilter !== "all" ? 1 : 0);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeRow | null>(null);
  // Salary in force TODAY for the open profile, read from the effective-dated
  // salary history (same source payroll pays from) so the profile figure always
  // matches what today's pay would use; a future-dated raise flips on its date.
  // Falls back to the stored employees.base_salary when there is no history row.
  const [profilePay, setProfilePay] = useState<{ base: number | null; allowance: number | null } | null>(null);
  useEffect(() => {
    const id = selectedEmployee?.id;
    if (!id) { setProfilePay(null); return; }
    let alive = true;
    setProfilePay(null);
    supabase
      .rpc("effective_salary", { p_employee_id: id, p_as_of: todayIso() })
      .then(({ data }) => {
        if (!alive) return;
        const row = (data as { base_salary: number | null; allowance: number | null }[] | null)?.[0];
        setProfilePay(row ? { base: row.base_salary, allowance: row.allowance } : null);
      });
    return () => { alive = false; };
  }, [selectedEmployee?.id]);
  const [selectedDocs, setSelectedDocs] = useState<DocumentWithUrl[]>([]);
  const [codeHistory, setCodeHistory] = useState<EmployeeCodeHistory[]>([]);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  // Phase 3: tabbed record + computed completeness tiers + approval workflow.
  const [viewTab, setViewTab] = useState<"profile" | "compliance" | "history">("profile");
  const [completeness, setCompleteness] = useState<{
    tier1: boolean; tier2: boolean; tier3: boolean; tier4: boolean | null; armed: boolean;
  } | null>(null);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string | null>>({});
  const [editFormErrors, setEditFormErrors] = useState<Record<string, string | null>>({});
  // Whether a save was attempted with invalid fields — gates the in-modal
  // "fix these fields" summary so it only appears once the user tries to save.
  const [addSubmitAttempted, setAddSubmitAttempted] = useState(false);
  const [editSubmitAttempted, setEditSubmitAttempted] = useState(false);
  // Modal-scoped error for the Add form, so failures show INSIDE the modal
  // rather than in the page banner that sits behind it.
  const [addModalError, setAddModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Visual top-to-bottom order of validated fields, so a failed save jumps to
  // the FIRST problem field (its section auto-expands via forceOpen first).
  const EMPLOYEE_FIELD_ORDER = [
    "full_name",
    "client_id",
    "phone",
    "bank_account",
    "iban",
    "cnic_number",
    "permanent_address",
    "current_address",
    "emergency_contact_phone",
  ];
  const scrollToFirstError = (errs: Record<string, string | null>) => {
    const firstKey = EMPLOYEE_FIELD_ORDER.find((k) => errs[k]);
    if (!firstKey) return;
    // Let the section auto-expand (forceOpen) commit before scrolling.
    setTimeout(() => {
      const el = document.getElementById("empfield-" + firstKey) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      (el as HTMLInputElement).focus?.({ preventScroll: true });
    }, 60);
  };

  // Collapsible sections of the Add and Edit modals. Basic Information, Bank
  // Details and Identity Verification are deliberately NOT in here — they render
  // permanently open, so no validation error can hide behind a fold.
  const addSections = useSectionState();
  const editSections = useSectionState();

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

  // Phase 3: the client-prefixed DISPLAY code shown in the UI. Prefix is derived
  // LIVE from the guard's current client; falls back to the permanent guard_code
  // when there's no client or the client has no prefix.
  const displayCodeFor = (e: Pick<Employee, "client_id" | "display_number" | "guard_code" | "employee_code">): string => {
    const fallback = e.guard_code ?? e.employee_code;
    if (e.display_number == null || !e.client_id) return fallback;
    const prefix = clients.find((c) => c.id === e.client_id)?.employee_id_prefix;
    if (!prefix) return fallback;
    return `${prefix}-${String(e.display_number).padStart(3, "0")}`;
  };

  // Employees whose CNIC (compared on digits only, so "12345-6789012-3" and
  // "1234567890123" match) is shared by 2+ records. Informational flag for a
  // manager to review — nothing is auto-changed.
  const duplicateCnicIds = useMemo(() => {
    const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
    const counts = new Map<string, number>();
    for (const e of employees) {
      const d = digits(e.cnic_number);
      if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const ids = new Set<string>();
    for (const e of employees) {
      const d = digits(e.cnic_number);
      if (d && (counts.get(d) ?? 0) > 1) ids.add(e.id);
    }
    return ids;
  }, [employees]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Digits-only form of the query so a CNIC typed with or without dashes
    // ("12345-6789012-3" vs "1234567890123") matches the same way. Only used
    // when the query actually contains digits, so a name/text search is
    // unaffected (an empty digit-string would otherwise match every CNIC).
    const qDigits = q.replace(/\D/g, "");
    return employees.filter((e) => {
      if (
        q &&
        !e.full_name.toLowerCase().includes(q) &&
        !e.employee_code.toLowerCase().includes(q) &&
        // legacy client-prefixed code stays searchable so old WhatsApp msgs /
        // paper files still resolve to the guard.
        !(e.legacy_code ?? "").toLowerCase().includes(q) &&
        !displayCodeFor(e).toLowerCase().includes(q) &&
        !(e.phone ?? "").toLowerCase().includes(q) &&
        // CNIC (dash-insensitive, partial): every record sharing a CNIC matches,
        // so duplicates surface together.
        !(qDigits.length > 0 && (e.cnic_number ?? "").replace(/\D/g, "").includes(qDigits))
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
      if (lifecycleFilter !== "all") {
        // Match every state behind the chosen option, not just its representative
        // key, so "Fired" catches both terminated and fired records.
        const wanted = LIFECYCLE_FILTER_STATES.get(lifecycleFilter) ?? [lifecycleFilter];
        if (!wanted.includes(e.lifecycle_state)) return false;
      }
      if (expiredCardFilter === "expired" && !isCardExpired(e.cnic_expiry)) return false;
      if (dupCnicFilter === "duplicate" && !duplicateCnicIds.has(e.id)) return false;
      if (missingKeyFilter === "missing" && !isMissingKeyFields(e)) return false;
      if (empTab === "active" && e.status !== "Active") return false;
      if (empTab === "inactive" && e.status === "Active") return false;
      return true;
    });
  }, [employees, search, locationFilter, clientFilter, branchFilter, categoryFilter, shiftFilter, statusFilter, completenessFilter, lifecycleFilter, expiredCardFilter, dupCnicFilter, duplicateCnicIds, missingKeyFilter, empTab, branches]);

  // Numeric sort on the client-prefixed display code's number (display_number).
  // NUMERIC — orders 001,002…010,011 correctly, never a lexicographic "10<2".
  // Employees without a display_number (office staff / unposted) sink to the
  // bottom in both directions. null sortDir keeps the default load order.
  const sorted = useMemo(() => {
    if (!sortDir) return filtered;
    const num = (e: Employee) => (e.display_number == null ? null : Number(e.display_number));
    return [...filtered].sort((a, b) => {
      const na = num(a), nb = num(b);
      if (na == null && nb == null) return 0;
      if (na == null) return 1;   // nulls last
      if (nb == null) return -1;
      return sortDir === "asc" ? na - nb : nb - na;
    });
  }, [filtered, sortDir]);

  // Headline counts. Scope = the selected client when one is chosen, else the
  // whole roster (independent of search / tab so the totals stay stable). "Active"
  // is the live lifecycle; "Inactive" = everyone else (fired / left / on-leave…).
  const counts = useMemo(() => {
    const scope = clientFilter === "all"
      ? employees
      : employees.filter((e) => e.client_id === clientFilter);
    const active = scope.filter((e) => e.status === "Active").length;
    return {
      total: scope.length,
      active,
      inactive: scope.length - active,
      missingKeyFields: scope.filter(isMissingKeyFields).length,
    };
  }, [employees, clientFilter]);

  const countsClientName = useMemo(
    () => (clientFilter === "all" ? null : clients.find((c) => c.id === clientFilter)?.name ?? "Selected client"),
    [clientFilter, clients],
  );

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

  // Fire / Reactivate straight from the status badge (no Edit needed). Both
  // routes go through the lifecycle state machine (transition_employee_lifecycle)
  // so the Employees table, the Lifecycle & Compliance panel, and Exit Clearance
  // always agree — a change in one is immediately reflected in the others.
  const [statusTogglingId, setStatusTogglingId] = useState<string | null>(null);


  // Fire flow: outstanding-dues popup + required reason + rehire decision.
  type ExitGates = {
    outstanding_kit_count: number;
    outstanding_advance: number;
    open_incident_count: number;
    undisbursed_salary: number;
  };
  const [fireTarget, setFireTarget] = useState<EmployeeRow | null>(null);
  const [fireGates, setFireGates] = useState<ExitGates | null>(null);
  const [fireGatesLoading, setFireGatesLoading] = useState(false);
  const [fireReason, setFireReason] = useState("");
  const [fireEligible, setFireEligible] = useState(true);
  // Separation type + effective date (§9). Firing and Resignation behave
  // IDENTICALLY for the roster (both close the posting + set last_working_day);
  // they differ only in recorded reason and the default rehire eligibility.
  const [fireType, setFireType] = useState<"firing" | "resignation">("firing");
  const [fireDate, setFireDate] = useState<string>(todayIso());
  const [fireSubmitting, setFireSubmitting] = useState(false);
  const [fireError, setFireError] = useState<string | null>(null);

  // Export exactly what the table is showing — the same `filtered` rows, in the
  // same visible column order — so filters/search/tab carry into the export.
  const handleExport = () => {
    const statusLabel = lifecycleStatusLabel;
    const categoryOrClient = (e: EmployeeRow) =>
      (e.category ?? "client") === "client"
        ? e.client_name ?? ""
        : (e.category ?? "client").replace("_", " ");
    exportTable({
      fileName: "Employees.xlsx",
      sheetName: "Employees",
      title: "Employees",
      headers: ["Employee ID", "Permanent Code", "Name", "CNIC", "Phone", "Location", "Branch", "Client / Category", "Shift", "Status", "Bank", "Account No.", "IBAN"],
      rows: sorted.map((e) => [
        displayCodeFor(e),
        e.guard_code ?? e.employee_code,
        e.full_name,
        e.cnic_number ? formatCnicInline(e.cnic_number) : "",
        e.phone ?? "",
        e.location_name ?? "",
        e.branch_name ?? "",
        categoryOrClient(e),
        e.shift,
        statusLabel(e),
        e.bank_name ?? "",
        e.bank_account ?? "",
        e.iban ?? "",
      ]),
      columnWidths: [14, 14, 24, 18, 16, 18, 18, 20, 8, 10, 18, 22, 28],
    });
  };

  const isFired = (emp: EmployeeRow) => isSeparatedState(emp.lifecycle_state);

  const requestStatusToggle = (emp: EmployeeRow) => {
    if (isFired(emp)) {
      // Rehire relinks to the SAME record; only allowed when eligible (the RPC
      // enforces it too). Opens the dated Rehire flow (new posting from a date).
      if (emp.eligible_for_rehire === false) {
        setError("This guard is not eligible for rehire (set at their last separation).");
        return;
      }
      setRehireTarget(emp);
    } else if (emp.lifecycle_state === "active" || emp.lifecycle_state === "on_leave") {
      openFireModal(emp);
    }
    // Applicants / waitlisted are driven from the Lifecycle & Compliance panel,
    // not the fire toggle — so the badge is a no-op for them.
  };

  const openFireModal = async (emp: EmployeeRow) => {
    setFireTarget(emp);
    setFireReason("");
    setFireType("firing");
    setFireEligible(false); // firing defaults to NOT rehire-eligible
    setFireDate(todayIso());
    setFireError(null);
    setFireGates(null);
    setFireGatesLoading(true);
    const { data, error: gErr } = await supabase.rpc("employee_clearance_gates", {
      p_employee_id: emp.id,
    });
    setFireGatesLoading(false);
    if (gErr) {
      setFireError(gErr.message);
      return;
    }
    // A returns-table RPC comes back as an array of one row.
    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      setFireGates({
        outstanding_kit_count: Number(row.outstanding_kit_count ?? 0),
        outstanding_advance: Number(row.outstanding_advance ?? 0),
        open_incident_count: Number(row.open_incident_count ?? 0),
        undisbursed_salary: Number(row.undisbursed_salary ?? 0),
      });
    }
  };

  const confirmFire = async () => {
    if (!fireTarget) return;
    if (!fireReason.trim()) {
      setFireError("A reason is required.");
      return;
    }
    if (!fireDate) {
      setFireError("An effective (last working) date is required.");
      return;
    }
    setFireSubmitting(true);
    setFireError(null);
    // §9: record_separation sets last_working_day + termination_date, records the
    // reason + rehire flag, moves lifecycle_state, and CLOSES the active posting
    // (end_date = last working day). This is what removes the guard from the
    // roster from the day after — the old transition RPC did none of that.
    const reasonVal = fireType === "resignation" ? "resignation" : "termination_misconduct";
    const { error: sErr } = await supabase.rpc("record_separation", {
      p_guard: fireTarget.id,
      p_reason: reasonVal,
      p_last_working_day: fireDate,
      p_termination_date: fireDate,
      p_rehire_eligible: fireEligible,
      p_note: fireReason.trim(),
    });
    if (sErr) {
      setFireSubmitting(false);
      setFireError(sErr.message);
      return;
    }
    // Snapshot the exit clearance so the panel reflects the outstanding dues.
    await supabase.rpc("assess_clearance", { p_employee_id: fireTarget.id });
    setFireSubmitting(false);
    const firedId = fireTarget.id;
    const newState = fireType === "resignation" ? "left" : "fired";
    setFireTarget(null);
    if (selectedEmployee?.id === firedId) {
      setSelectedEmployee({ ...selectedEmployee, lifecycle_state: newState, status: "Inactive", eligible_for_rehire: fireEligible } as EmployeeRow);
    }
    await loadData();
  };

  // Phase 3D: advance/reverse the approval state machine. Reversal needs a reason.
  // Phase 3G: Archive replaces Delete — reason required, logged, never removes rows.
  const handleArchive = async (emp: EmployeeRow) => {
    const reason = window.prompt(`Archive ${emp.full_name} (${displayCodeFor(emp)})?\nEnter a reason (required):`);
    if (!reason || !reason.trim()) return;
    setError(null);
    const { error: aErr } = await supabase.rpc("archive_employee", {
      p_employee_id: emp.id,
      p_reason: reason.trim(),
    });
    if (aErr) { setError(aErr.message); return; }
    setIsEditModalOpen(false);
    setIsViewModalOpen(false);
    setSelectedEmployee(null);
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
  // First 4 digits of a plain account number are the branch code (informational
  // only). Skip the hint when the value looks like an IBAN, where those digits
  // are the check digits + start of the bank code, not a branch.
  const branchCodeHint = (v: string): string | null => {
    if (!/^[0-9\-\s]+$/.test(v.trim())) return null;
    const d = v.replace(/\D/g, "");
    return d.length >= 4 ? d.slice(0, 4) : null;
  };

  const accountOrIbanError = (v: string): string | null => {
    if (!v || v.trim() === "") return null;
    if (validateBankAccount(v) === null || validateIban(v) === null) return null;
    return "Enter a valid account number or IBAN";
  };

  // Inline field errors for an employee form (null = OK).
  // CNIC and Join Date are NOT required — both are only format-checked. They are
  // still flagged in the list (isMissingKeyFields) because attendance gating and
  // payroll depend on them, but nothing blocks a save without them.
  const computeEmployeeErrors = (f: FormState): Record<string, string | null> => ({
    full_name: validateFreeText(f.full_name),
    phone: validatePhone(f.phone),
    cnic_number: validateCnic(f.cnic_number),
    iban: validateIban(f.iban, pkBankCode(f.bank_name)),
    bank_account: accountOrIbanError(f.bank_account),
    emergency_contact_phone: validatePhone(f.emergency_contact_phone),
    permanent_address: validateFreeText(f.permanent_address),
    current_address: validateFreeText(f.current_address),
  });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddModalError(null);
    // Field-level validation: format errors PLUS required-empty checks. All of
    // these surface inline under the field + in the summary + auto-scroll, so the
    // user never gets a message hidden behind the modal.
    const errs = computeEmployeeErrors(form);
    if (!form.full_name.trim()) errs.full_name = "Full Name is required.";
    // CNIC must be unique across employees (compared on digits, so formatting
    // differences don't slip a duplicate through). Enforced on ADD only.
    const cnicDigits = form.cnic_number.replace(/\D/g, "");
    if (cnicDigits) {
      const dup = employees.find((e) => (e.cnic_number ?? "").replace(/\D/g, "") === cnicDigits);
      if (dup) {
        errs.cnic_number = isFired(dup)
          ? `This CNIC already belongs to ${dup.full_name} (${dup.employee_code}), who was separated. Use Rehire instead of adding a duplicate.`
          : `This CNIC is already registered to ${dup.full_name} (${dup.employee_code}). Duplicate CNICs are not allowed.`;
      }
    }
    if (Object.values(errs).some(Boolean)) {
      setFormErrors(errs);
      setAddSubmitAttempted(true);
      scrollToFirstError(errs);
      return;
    }
    // Non-field blockers → modal-scoped banner (inside the modal, always visible).
    // Guard codes are now permanent GGS-NNNNN (assigned at hiring), no longer
    // derived from the client prefix — so no prefix is required to add a guard.
    const slotErr = validateSlot(form);
    if (slotErr) {
      setAddModalError(slotErr);
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
          // "" is not a uuid — and since the client picker moved to Assignments &
          // Pay, client_id is ALWAYS "" here. Coalesce or Postgres rejects the row.
          client_id: form.category === "client" ? (form.client_id || null) : null,
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
      // The permanent guard code, the client-scoped display number, the dated
      // posting row and the opening salary are all issued on the FIRST client
      // assignment — done on Workforce ▸ Assignments & Pay, since this form no
      // longer collects a client. Until then the record sits unassigned with the
      // throwaway EMP-XXXX code the insert trigger minted.
      await uploadDocs(
        { id: newEmp.id, employee_code: newEmp.employee_code, full_name: newEmp.full_name },
        form,
      );
      await syncAdditionalBranches(newEmp.id, form.additional_branch_ids, form.branch_id);
      setForm(emptyForm);
      setFormErrors({});
      setAddModalError(null);
      setIsModalOpen(false);
      await loadData();
    } catch (err: any) {
      setAddModalError(err.message ?? String(err));
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
    setViewTab("profile");
    setCompleteness(null);
    setIsViewModalOpen(true);
    // Phase 3E: computed completeness tiers (never manually flagged).
    supabase
      .rpc("guard_completeness", { p_employee_id: emp.id })
      .then(({ data }) => data && setCompleteness(data as typeof completeness));
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
  // Phase 8 §11: build the four §4 approval blocks from the approval events,
  // resolving the approver's name + role. office_clerk stays a physical signature.
  const buildApprovals = async (employeeId: string): Promise<FormApprovals> => {
    const { data } = await supabase
      .from("employee_approval_events")
      .select("action, changed_at, approver:approved_by(full_name, role)")
      .eq("employee_id", employeeId)
      .order("changed_at");
    const out: FormApprovals = {};
    for (const ev of ((data ?? []) as any[])) {
      const name = ev.approver?.full_name ?? "";
      const role = ev.approver?.role ?? "";
      const date = String(ev.changed_at).slice(0, 10);
      if (ev.action === "ops_verify") {
        if (role === "ops_director") out.director_ops = { name, date };
        else out.manager_ops = { name, date };
      } else if (ev.action === "finance_approve") {
        out.director_finance = { name, date };
      }
    }
    return out;
  };

  const downloadFormPdf = async (emp: EmployeeRow) => {
    const [c, r, j, d, approvals] = await Promise.all([
      supabase.from("employee_children").select("*").eq("employee_id", emp.id).order("created_at"),
      supabase.from("employee_references").select("*").eq("employee_id", emp.id),
      supabase.from("employee_previous_jobs").select("*").eq("employee_id", emp.id).order("seq"),
      supabase.from("employee_document_checklist").select("*").eq("employee_id", emp.id).order("doc_type"),
      buildApprovals(emp.id),
    ]);
    generateEmployeeFormPdf({
      employee: emp,
      branding: brandingFromCompany(company),
      approvals,
      children: (c.data ?? []) as EmployeeChild[],
      references: (r.data ?? []) as EmployeeReference[],
      jobs: (j.data ?? []) as EmployeePreviousJob[],
      checklist: (d.data ?? []) as EmployeeDocumentChecklistItem[],
    });
  };

  const openEdit = (emp: EmployeeRow) => {
    editSections.reset();
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
      photo_url: (emp as { photo_url?: string | null }).photo_url ?? "",
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
    setEditSubmitAttempted(false);
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
      setEditSubmitAttempted(true);
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
    // Guard codes are permanent and no longer derived from the client prefix, so
    // moving a guard to another client neither requires a prefix nor changes the
    // code — see the transfer-logging block after the update.
    setEditing(true);
    setError(null);
    // Phase 3: if the guard's posting (client) changes, clear the old per-client
    // display_number in the SAME update so it can't collide with an existing
    // guard's number at the new client (the unique index excludes NULL); the new
    // number is then allocated by assign_display_number below.
    const nextClientId = editForm.category === "client" ? (editForm.client_id || null) : null;
    const postingChanged = nextClientId !== selectedEmployee.client_id;
    try {
      const { error: upErr } = await supabase
        .from("employees")
        .update({
          full_name: editForm.full_name.trim(),
          phone: editForm.phone.trim() || null,
          location_id: editForm.location_id || null,
          ...(postingChanged ? { display_number: null } : {}),
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
          // Salary is NOT written from the edit modal — it changes only through the
          // dated increment flow (set_employee_salary → employee_salary_history), so
          // base_salary/allowance/per_day are deliberately omitted here.
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
      // Guard codes (GGS-) are IMMUTABLE and untouched by a transfer. Phase 3:
      // moving to a different client allocates a BRAND-NEW client-scoped DISPLAY
      // number under the new client and records the DISPLAY transition
      // (HMC-024 → EMR-053) in the service log, so past references still resolve.
      const reassigned =
        editForm.category === "client" &&
        !!editForm.client_id &&
        editForm.client_id !== selectedEmployee.client_id;
      if (reassigned) {
        // Old display code, computed from the guard's PRIOR client + number.
        const oldDisplay = displayCodeFor(selectedEmployee);
        // Phase 4: a client move is a POSTING change — close the current dated
        // row and open a new one (never edited in place). change_client keeps
        // employees.client_id (the mirror) in step via its sync trigger.
        // (Interim reason; the dedicated "Change client" modal offers the full
        // reason picker — new hire / relief cover / return to pool / shift change.)
        const { error: moveErr } = await supabase.rpc("change_client", {
          p_guard_id: selectedEmployee.id,
          p_new_client_id: editForm.client_id,
          p_contract_line_id: editForm.contract_line_id || null,
          p_reason: "relief_cover",
        });
        if (moveErr) throw moveErr;
        // Allocate the new per-client number under the now-current client.
        const { data: newDisp, error: dispErr } = await supabase.rpc("assign_display_number", {
          p_employee_id: selectedEmployee.id,
        });
        if (dispErr) throw dispErr;
        const permanentCode = selectedEmployee.guard_code ?? selectedEmployee.employee_code;
        const newDisplay = (newDisp as string | null) ?? permanentCode;
        const { error: histErr } = await supabase.from("employee_code_history").insert({
          company_id: selectedEmployee.company_id,
          employee_id: selectedEmployee.id,
          old_code: oldDisplay,
          new_code: newDisplay,
          client_id: editForm.client_id,
          reason: "reassigned",
        });
        if (histErr) throw histErr;
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
      {/* Shared options for the bank-name type-to-filter inputs in both the Add
          and Edit modals. One datalist, referenced by list="pk-bank-list". */}
      <datalist id="pk-bank-list">
        {PK_BANKS.map((b) => (
          <option key={b.code} value={b.name} />
        ))}
      </datalist>
      <Header
        title="Employee Management"
        subtitle="Workforce roster, branches and document uploads"
        actions={
          <div className="flex items-center gap-2">
            <ExportButton onExport={handleExport} label="Export" />
            {/* Phase 8 §11.3: bulk-generate documents for the current filtered set. */}
            <Button variant="secondary" size="md" disabled={filtered.length === 0} onClick={() => setBulkOpen(true)}>
              <FileText className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Generate documents ({filtered.length})
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                setFormErrors({});
                setAddSubmitAttempted(false);
                setAddModalError(null);
                addSections.reset();
                setIsModalOpen(true);
              }}
            >
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Add Employee
            </Button>
          </div>
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

        {/* Headline counts — total registered / active / inactive. Scopes to the
            selected client when one is chosen (label shows the client name). */}
        <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: countsClientName ? `${countsClientName} — Registered` : "Registered", value: counts.total, tint: "text-foreground" },
            { label: "Active", value: counts.active, tint: "text-success-700 dark:text-success-500" },
            { label: "Inactive", value: counts.inactive, tint: "text-slate-500" },
          ].map((c) => (
            <div key={c.label} className="bg-card border border-border rounded-xl px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground truncate" title={c.label}>{c.label}</div>
              <div className={`mt-1 text-2xl font-bold ${c.tint}`}>{c.value}</div>
            </div>
          ))}
          {/* Missing mandatory identity fields — click to filter the list down
              to exactly those records so they can be fixed. */}
          <button
            type="button"
            onClick={() => setMissingKeyFilter((v) => (v === "missing" ? "all" : "missing"))}
            title="Records missing CNIC and/or Join Date — click to show only these"
            className={`text-left bg-card border rounded-xl px-4 py-3 transition-colors hover:bg-accent ${
              missingKeyFilter === "missing" ? "border-danger-500 ring-2 ring-danger-500/30" : "border-border"
            }`}
          >
            <div className="text-xs uppercase tracking-wide text-muted-foreground truncate">
              No CNIC / Join Date
            </div>
            <div
              className={`mt-1 text-2xl font-bold ${
                counts.missingKeyFields > 0 ? "text-danger-700 dark:text-danger-500" : "text-success-700 dark:text-success-500"
              }`}
            >
              {counts.missingKeyFields}
            </div>
          </button>
        </div>

        <div className="bg-card rounded-xl border border-border">
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex-1 min-w-[200px] relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, CNIC, phone, or employee ID..."
                  className="w-full pl-10 pr-4 py-2 border border-border rounded-md text-sm bg-input-background focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500"
                />
              </div>
              <button
                type="button"
                onClick={() => setFiltersOpen((v) => !v)}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-md border border-border text-foreground hover:bg-accent transition-colors"
              >
                <SlidersHorizontal className="w-4 h-4" strokeWidth={1.5} />
                Filters
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full bg-brand-500 text-[#241a06]">{activeFilterCount}</span>
                )}
                <ChevronDown className={`w-4 h-4 transition-transform ${filtersOpen ? "rotate-180" : ""}`} strokeWidth={1.5} />
              </button>
              {/* Sort by the display-code NUMBER. Cycles: off → 001 first (asc) →
                  highest first (desc) → off. Numeric so 010 follows 009, not 1. */}
              <button
                type="button"
                onClick={() => setSortDir((d) => (d === null ? "asc" : d === "asc" ? "desc" : null))}
                title="Sort by employee ID number"
                className={`inline-flex items-center gap-2 px-3 py-2 text-sm rounded-md border transition-colors ${
                  sortDir
                    ? "border-brand-500 bg-brand-500/15 text-brand-700 dark:text-brand-500 font-medium"
                    : "border-border text-foreground hover:bg-accent"
                }`}
              >
                {sortDir === "asc" ? <ArrowUp className="w-4 h-4" strokeWidth={1.5} />
                  : sortDir === "desc" ? <ArrowDown className="w-4 h-4" strokeWidth={1.5} />
                  : <ArrowUpDown className="w-4 h-4" strokeWidth={1.5} />}
                {sortDir === "asc" ? "ID 001→high" : sortDir === "desc" ? "ID high→001" : "Sort by ID"}
              </button>
              <Tabs
                className="ml-auto"
                value={empTab}
                onChange={setEmpTab}
                items={[
                  { value: "all", label: "All" },
                  { value: "active", label: "Active" },
                  { value: "inactive", label: "Fired" },
                ]}
              />
            </div>
            {filtersOpen && (
              <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-2">
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
                {LIFECYCLE_FILTER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </ThemedSelect>
              <ThemedSelect
                value={expiredCardFilter}
                onChange={(e) => setExpiredCardFilter(e.target.value as "all" | "expired")}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                title="CNIC card expiry"
              >
                <option value="all">All Cards</option>
                <option value="expired">Expired card only</option>
              </ThemedSelect>
              <ThemedSelect
                value={dupCnicFilter}
                onChange={(e) => setDupCnicFilter(e.target.value as "all" | "duplicate")}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                title="CNIC shared by more than one employee record"
              >
                <option value="all">All CNICs</option>
                <option value="duplicate">Duplicate CNIC only</option>
              </ThemedSelect>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-slate-50">
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground border-l-2 border-l-transparent">Employee ID</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Name</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Phone</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Client / Category</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Status</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sticky right-0 z-10 bg-slate-50 border-l border-border">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={6} className="px-6 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-10 text-center text-slate-500 text-sm">
                      No employees yet. Click "Add Employee" to create one.
                    </td>
                  </tr>
                )}
                {!loading &&
                  sorted.map((employee) => {
                    // Profile completeness is driven by the "Physical Copy Present"
                    // flag: incomplete → red row, complete → green row.
                    const incomplete = !employee.physical_copy_present;
                    // CNIC and Join Date are mandatory on the form now, so any
                    // record still missing them predates the rule and needs
                    // fixing — attendance and payroll both depend on them.
                    const missingKeyFields = [
                      !employee.cnic_number?.trim() ? "CNIC" : null,
                      !employee.join_date ? "Join Date" : null,
                    ].filter(Boolean) as string[];
                    return (
                    <tr
                      key={employee.id}
                      className="group border-b border-border transition-colors hover:bg-accent"
                      title={incomplete ? "Incomplete profile — physical document copies not on file" : "Complete profile"}
                    >
                      <td className={`px-6 py-3.5 text-sm font-mono border-l-2 ${incomplete ? "border-l-danger-500" : "border-l-transparent"}`}>
                        <span className={incomplete ? "text-danger-600 dark:text-danger-500" : "text-foreground"}>{displayCodeFor(employee)}</span>
                        <span className="block text-[11px] text-muted-foreground">{employee.guard_code ?? employee.employee_code}</span>
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
                          {isCardExpired(employee.cnic_expiry) && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-warning-700 dark:text-warning-500 bg-warning-50 border border-warning-200 px-1.5 py-0.5 rounded-md" title="CNIC card expired">
                              <AlertCircle className="w-3 h-3" strokeWidth={2} />
                              Card expired
                            </span>
                          )}
                          {missingKeyFields.length > 0 && (
                            <span
                              className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-danger-700 dark:text-danger-500 bg-danger-50 border border-danger-200 px-1.5 py-0.5 rounded-md"
                              title={`Missing ${missingKeyFields.join(" and ")} — required. Attendance can't be gated and payroll can't be trusted without ${missingKeyFields.length > 1 ? "them" : "it"}.`}
                            >
                              <AlertCircle className="w-3 h-3" strokeWidth={2} />
                              No {missingKeyFields.join(" / ")}
                            </span>
                          )}
                          {duplicateCnicIds.has(employee.id) && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-warning-700 dark:text-warning-500 bg-warning-50 border border-warning-200 px-1.5 py-0.5 rounded-md" title="Another employee record shares this CNIC — review and resolve manually">
                              <AlertCircle className="w-3 h-3" strokeWidth={2} />
                              Duplicate CNIC
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-3.5 text-sm text-muted-foreground tabular-nums">{employee.phone ?? "—"}</td>
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
                        {/* Plain status label — separation/rehire are explicit
                            actions in the row, not a click on this badge. */}
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border ${
                            isFired(employee)
                              ? "bg-danger-50 text-danger-700 dark:text-danger-500 border-danger-200"
                              : employee.status === "Active"
                              ? "bg-success-50 text-success-700 dark:text-success-500 border-success-200"
                              : employee.status === "On Leave"
                              ? "bg-warning-50 text-warning-700 dark:text-warning-500 border-warning-200"
                              : "bg-secondary text-muted-foreground border-border"
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${isFired(employee) ? "bg-danger-500" : employee.status === "Active" ? "bg-success-500" : employee.status === "On Leave" ? "bg-warning-500" : "bg-slate-400"}`} />
                          {lifecycleStatusLabel(employee)}
                        </span>
                      </td>
                      {/* Sticky column: the background MUST be fully opaque in
                          every state — a translucent tint (bg-accent/50) lets the
                          columns underneath show through while scrolling sideways. */}
                      <td className="px-6 py-3.5 sticky right-0 z-10 border-l border-border bg-card group-hover:bg-accent transition-colors">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openView(employee)}>
                            View
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(employee)}>
                            Edit
                          </Button>
                          {["active", "on_leave"].includes(employee.lifecycle_state) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger-600 hover:text-danger-700"
                              disabled={statusTogglingId === employee.id}
                              onClick={() => requestStatusToggle(employee)}
                            >
                              Fire
                            </Button>
                          )}
                          {isFired(employee) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={employee.eligible_for_rehire === false}
                              title={employee.eligible_for_rehire === false ? "Not eligible for rehire" : ""}
                              onClick={() => setRehireTarget(employee)}
                            >
                              Rehire
                            </Button>
                          )}
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

      <Modal isOpen={isModalOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsModalOpen(false)} title="Add Employee" size="lg">
        <form className="space-y-2" onSubmit={handleAdd}>
          {addModalError && (
            <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={2} />
              <div className="flex-1">{addModalError}</div>
              <button type="button" onClick={() => setAddModalError(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
          <FormSection
            label="Basic Information"
            collapsible={false}
            hasError={Boolean(formErrors.full_name || formErrors.phone)}
          >
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Full Name *</label>
                <input
                  type="text"
                  id="empfield-full_name"
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
                  id="empfield-phone"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  onBlur={(e) => setFormErrors((p) => ({ ...p, phone: validatePhone(e.target.value) }))}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="+92 300 1234567"
                />
                {formErrors.phone && <p className="text-xs text-danger-600 mt-1">{formErrors.phone}</p>}
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Recruitment Intake</label>
                <ThemedSelect
                  value={form.lifecycle_intake}
                  onChange={(e) =>
                    setForm({ ...form, lifecycle_intake: e.target.value as "" | "applicant" | "waitlisted" })
                  }
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="">Active hire (default)</option>
                  <option value="applicant">Applicant</option>
                  <option value="waitlisted">Waiting list</option>
                </ThemedSelect>
                <p className="text-xs text-slate-500 mt-1">
                  Create as an applicant / waiting-list entry; promote later from the employee's Lifecycle panel.
                </p>
              </div>
            </div>
          </FormSection>

          {/* Posting and pay (client, branch, shift, salary, joining date) are set
              on Workforce ▸ Assignments & Pay, where the whole client can be
              edited at once. A new hire lands in that page's "Unassigned" group. */}
          <div className="flex items-start gap-2 text-sm text-slate-600">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" strokeWidth={2} />
            <span>
              Client, location, branch, department, shift, salary and joining date are set on{" "}
              <span className="font-medium text-slate-800">Workforce ▸ Assignments &amp; Pay</span> once this
              record is saved.
            </span>
          </div>

          <FormSection
            label="Bank Details"
            collapsible={false}
            hasError={Boolean(formErrors.bank_account || formErrors.iban)}
          >
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Bank Name</label>
                <input
                  type="text"
                  list="pk-bank-list"
                  value={form.bank_name}
                  onChange={(e) => {
                    const bank_name = e.target.value;
                    setForm({ ...form, bank_name });
                    // Re-check the IBAN against the newly-selected bank's code.
                    setFormErrors((p) => ({ ...p, iban: validateIban(form.iban, pkBankCode(bank_name)) }));
                  }}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="Type to search…"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Bank Account Number</label>
                <input
                  type="text"
                  id="empfield-bank_account"
                  value={form.bank_account}
                  onChange={(e) => setForm({ ...form, bank_account: e.target.value })}
                  onBlur={(e) => setFormErrors((p) => ({ ...p, bank_account: accountOrIbanError(e.target.value) }))}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="e.g., 0010053029480016"
                />
                {formErrors.bank_account && <p className="text-xs text-danger-600 mt-1">{formErrors.bank_account}</p>}
                {branchCodeHint(form.bank_account) && (
                  <p className="text-xs text-slate-500 mt-1">Branch code: {branchCodeHint(form.bank_account)}</p>
                )}
              </div>
              <div className="col-span-2">
                <label className="block text-sm text-slate-700 mb-1">IBAN (24 chars — as issued by the bank)</label>
                <input
                  type="text"
                  maxLength={24}
                  id="empfield-iban"
                  value={form.iban}
                  onChange={(e) => setForm({ ...form, iban: e.target.value.toUpperCase().replace(/\s+/g, "") })}
                  onBlur={(e) => setFormErrors((p) => ({ ...p, iban: validateIban(e.target.value, pkBankCode(form.bank_name)) }))}
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
          </FormSection>

          <EmployeeHrSection
            form={form}
            setForm={setForm}
            employees={employees}
            errors={formErrors}
            onFieldBlur={(k, err) => setFormErrors((p) => ({ ...p, [k]: err }))}
            idPrefix="empfield-"
            forceOpen={addSubmitAttempted}
          />

          <FormSection
            label="Documents"
            open={addSections.isOpen("docs")}
            onToggle={() => addSections.toggle("docs")}
          >
            <div className="space-y-3">
              <PhysicalCopyToggle
                checked={form.physical_copy_present}
                onChange={(v) => setForm({ ...form, physical_copy_present: v })}
              />
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
          </FormSection>

          {addSubmitAttempted && <FieldErrorSummary errors={formErrors} idPrefix="empfield-" />}

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
            {/* Phase 3E/3D: computed completeness tiers + approval workflow,
                always visible above the tabs. */}
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {([
                  ["Created", completeness?.tier1, false],
                  ["Deployable", completeness?.tier2, false],
                  ["Payable", completeness?.tier3, false],
                  ["Armed post", completeness?.tier4 ?? false, !completeness?.armed],
                ] as const).map(([label, ok, na]) => (
                  <span
                    key={label}
                    className={`px-2.5 py-1 rounded-full text-xs border font-medium ${
                      na
                        ? "bg-slate-50 text-slate-400 border-slate-200"
                        : ok
                          ? "bg-success-50 text-success-700 border-success-200"
                          : "bg-slate-50 text-slate-500 border-slate-200"
                    }`}
                  >
                    {na ? "–" : ok ? "✓" : "○"} {label}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* Phase 7 §9: separation / rehire on the record. */}
                {["active", "on_leave"].includes(selectedEmployee.lifecycle_state) && (
                  <Button size="sm" variant="secondary" onClick={() => setSeparationTarget(selectedEmployee)}>Record separation</Button>
                )}
                {["left", "fired", "absconded"].includes(selectedEmployee.lifecycle_state) && (
                  <Button size="sm" variant="secondary"
                    disabled={selectedEmployee.eligible_for_rehire === false}
                    title={selectedEmployee.eligible_for_rehire === false ? "Not eligible for rehire" : ""}
                    onClick={() => setRehireTarget(selectedEmployee)}>Rehire</Button>
                )}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => downloadFormPdf(selectedEmployee)}
                  title="Download Form PDF"
                  aria-label="Download Form PDF"
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent border border-border transition-colors"
                >
                  <FileText className="w-4 h-4" strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={() => handleArchive(selectedEmployee)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-sm text-danger-700 hover:bg-danger-50 border border-danger-200"
                >
                  <Trash2 className="w-4 h-4" strokeWidth={1.5} /> Archive
                </button>
              </div>
              <Tabs
                value={viewTab}
                onChange={setViewTab}
                items={[
                  { value: "profile", label: "Profile" },
                  { value: "compliance", label: "Compliance" },
                  { value: "history", label: "History" },
                ]}
              />
            </div>

            {viewTab === "profile" && (
            <div>
              <h4 className="text-sm text-slate-900 mb-4">Basic Information</h4>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-slate-500 mb-1">Display Code</p>
                  <p className="text-slate-900 font-mono">{displayCodeFor(selectedEmployee)}</p>
                  <p className="text-xs text-slate-400 font-mono mt-0.5">
                    Guard code {selectedEmployee.guard_code ?? selectedEmployee.employee_code}
                    {selectedEmployee.legacy_code && <> · was {selectedEmployee.legacy_code}</>}
                  </p>
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
                  <p className="text-slate-500 mb-1">CNIC</p>
                  <p className="text-slate-900 font-mono">
                    {selectedEmployee.cnic_number ? formatCnicInline(selectedEmployee.cnic_number) : "—"}
                  </p>
                </div>
                {/* Phase 3H: Location deprecated — hidden from UI (column retained). */}
                <div>
                  <p className="text-slate-500 mb-1">Branch</p>
                  <p className="text-slate-900">{selectedEmployee.branch_name ?? "—"}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Category</p>
                  <p className="text-slate-900 capitalize">
                    {(selectedEmployee.category ?? "client").replace("_", " ")}
                  </p>
                  {["active", "on_leave"].includes(selectedEmployee.lifecycle_state) && (
                    <button
                      type="button"
                      className="text-xs text-brand-700 hover:underline mt-1"
                      onClick={() => setChangeCategoryTarget(selectedEmployee)}
                    >
                      Change category
                    </button>
                  )}
                </div>
                <div>
                  <p className="text-slate-500 mb-1">Client</p>
                  <p className="text-slate-900">
                    {(selectedEmployee.category ?? "client") === "client"
                      ? selectedEmployee.client_name ?? "—"
                      : "—"}
                  </p>
                  {(selectedEmployee.category ?? "client") === "client" && (
                    <button
                      type="button"
                      className="text-xs text-brand-700 hover:underline mt-1 disabled:text-slate-300"
                      onClick={() => setChangeClientTarget(selectedEmployee)}
                    >
                      Change client
                    </button>
                  )}
                </div>
                {/* Phase 3H: Department deprecated — hidden from UI (column retained). */}
                <div>
                  <p className="text-slate-500 mb-1">Shift</p>
                  <p className="text-slate-900 capitalize">{selectedEmployee.shift}</p>
                  {(selectedEmployee.category ?? "client") === "client"
                    && ["active", "on_leave"].includes(selectedEmployee.lifecycle_state) && (
                    <button
                      type="button"
                      className="text-xs text-brand-700 hover:underline mt-1 disabled:text-slate-300"
                      onClick={() => setChangeShiftTarget(selectedEmployee)}
                    >
                      Change shift
                    </button>
                  )}
                </div>
                {(() => {
                  // Prefer the salary effective today (history) over the stored
                  // column, so the profile matches what payroll would pay now.
                  const shownBase = profilePay?.base ?? selectedEmployee.base_salary;
                  const shownAllowance = profilePay?.allowance ?? selectedEmployee.allowance;
                  return (
                    <>
                      <div>
                        <p className="text-slate-500 mb-1">Base Salary</p>
                        <p className="text-slate-900">
                          {shownBase != null ? `PKR ${Number(shownBase).toLocaleString()}` : "—"}
                        </p>
                      </div>
                      {/* Phase 3H: stored Per Day Salary deprecated — hidden from UI; the
                          per-day rate is computed at runtime (rate ÷ days_in_month). */}
                      <div>
                        <p className="text-slate-500 mb-1">Allowance</p>
                        <p className="text-slate-900">
                          {shownAllowance ? `PKR ${Number(shownAllowance).toLocaleString()}` : "—"}
                        </p>
                      </div>
                    </>
                  );
                })()}
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
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                    isFired(selectedEmployee)
                      ? "bg-danger-50 text-danger-700"
                      : selectedEmployee.status === "Active"
                      ? "bg-success-50 text-success-700"
                      : selectedEmployee.status === "On Leave"
                      ? "bg-warning-50 text-warning-700"
                      : "bg-slate-100 text-slate-600"
                  }`}>
                    {lifecycleStatusLabel(selectedEmployee)}
                  </span>
                </div>
              </div>
            </div>
            )}

            {viewTab === "profile" && codeHistory.length > 0 && (
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

            {viewTab === "compliance" && (
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
            )}

            {viewTab === "history" && (
              <div className="space-y-3">
                {/* §8.8: month calendar is a correction-only Timesheet, reached
                    from the record here — not from the daily attendance flow. */}
                <a
                  href="/super-admin/attendance/timesheet"
                  className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"
                >
                  Open attendance timesheet (corrections) →
                </a>
                <ServiceHistoryTab employeeId={selectedEmployee.id} />
              </div>
            )}
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

      {changeClientTarget && (
        <ChangeClientModal
          guard={changeClientTarget}
          clients={clients}
          contractsForClient={contractsForClient}
          linesForContract={linesForContract}
          displayCode={displayCodeFor(changeClientTarget)}
          onClose={() => setChangeClientTarget(null)}
          onDone={async () => {
            setChangeClientTarget(null);
            await loadData();
          }}
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

      {separationTarget && (
        <SeparationModal
          guard={separationTarget}
          displayCode={displayCodeFor(separationTarget)}
          branding={brandingFromCompany(company)}
          onClose={() => setSeparationTarget(null)}
          onDone={async () => { setSeparationTarget(null); await loadData(); }}
          onError={setError}
        />
      )}

      {rehireTarget && (
        <RehireModal
          guard={rehireTarget}
          clients={clients}
          onClose={() => setRehireTarget(null)}
          onDone={async () => { setRehireTarget(null); await loadData(); }}
          onError={setError}
        />
      )}

      {bulkOpen && (
        <BulkGenerateModal
          employees={sorted}
          clients={clients}
          branding={brandingFromCompany(company)}
          displayFor={displayCodeFor}
          buildApprovals={buildApprovals}
          onClose={() => setBulkOpen(false)}
        />
      )}

      <Modal
        isOpen={isEditModalOpen}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => setIsEditModalOpen(false)}
        title="Edit Employee"
        size="lg"
      >
        {selectedEmployee && (
          <form className="space-y-2" onSubmit={handleEdit}>
            <FormSection label="Identity Verification" collapsible={false}>
            <IdentityVerificationPanel
              employee={selectedEmployee}
              physicalCopyPresent={editForm.physical_copy_present}
              onPhysicalCopyChange={(v) => setEditForm({ ...editForm, physical_copy_present: v })}
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
            </FormSection>

            <FormSection
              label="Basic Information"
              collapsible={false}
              hasError={Boolean(editFormErrors.full_name || editFormErrors.phone)}
            >
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
                    id="empeditfield-full_name"
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
                    id="empeditfield-phone"
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                    onBlur={(e) => setEditFormErrors((p) => ({ ...p, phone: validatePhone(e.target.value) }))}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                  {editFormErrors.phone && <p className="text-xs text-danger-600 mt-1">{editFormErrors.phone}</p>}
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
                {/* Posting and pay live on Workforce ▸ Assignments & Pay, where
                    a whole client's guards can be changed in one go instead of
                    fifty modals. Nothing here duplicates them. */}
                <div className="col-span-2 flex items-start gap-2 rounded-md border border-border bg-accent/40 px-3 py-2.5 text-sm text-slate-600">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" strokeWidth={2} />
                  <span className="flex-1">
                    Client, location, branch, department, shift, salary, allowance and joining date are
                    managed on{" "}
                    <Link to="/super-admin/assignments" className="font-medium text-brand-700 dark:text-brand-500 hover:underline">
                      Assignments &amp; Pay
                    </Link>
                    , one guard or a whole client at a time.
                  </span>
                </div>
              </div>
            </FormSection>

            {/* Its own section, permanently open, mirroring the Add form. */}
            <FormSection
              label="Bank Details"
              collapsible={false}
              hasError={Boolean(editFormErrors.bank_account || editFormErrors.iban)}
            >
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Bank Name</label>
                  <input
                    type="text"
                    list="pk-bank-list"
                    value={editForm.bank_name}
                    onChange={(e) => {
                      const bank_name = e.target.value;
                      setEditForm({ ...editForm, bank_name });
                      setEditFormErrors((p) => ({ ...p, iban: validateIban(editForm.iban, pkBankCode(bank_name)) }));
                    }}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                    placeholder="Type to search…"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Bank Account Number</label>
                  <input
                    type="text"
                    id="empeditfield-bank_account"
                    value={editForm.bank_account}
                    onChange={(e) => setEditForm({ ...editForm, bank_account: e.target.value })}
                    onBlur={(e) => setEditFormErrors((p) => ({ ...p, bank_account: accountOrIbanError(e.target.value) }))}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                    placeholder="e.g., 0010053029480016"
                  />
                  {editFormErrors.bank_account && <p className="text-xs text-danger-600 mt-1">{editFormErrors.bank_account}</p>}
                  {branchCodeHint(editForm.bank_account) && (
                    <p className="text-xs text-slate-500 mt-1">Branch code: {branchCodeHint(editForm.bank_account)}</p>
                  )}
                </div>
                <div className="col-span-2">
                  <label className="block text-sm text-slate-700 mb-1">IBAN (24 chars — as issued by the bank)</label>
                  <input
                    type="text"
                    maxLength={24}
                    id="empeditfield-iban"
                    value={editForm.iban}
                    onChange={(e) => setEditForm({ ...editForm, iban: e.target.value.toUpperCase().replace(/\s+/g, "") })}
                    onBlur={(e) => setEditFormErrors((p) => ({ ...p, iban: validateIban(e.target.value, pkBankCode(editForm.bank_name)) }))}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono"
                    placeholder="PKxx XXXX XXXX XXXX XXXX XXXX"
                  />
                  {editFormErrors.iban && <p className="text-xs text-danger-600 mt-1">{editFormErrors.iban}</p>}
                </div>
              </div>
            </FormSection>

            <EmployeeHrSection
              form={editForm}
              setForm={setEditForm}
              employees={employees}
              excludeEmployeeId={selectedEmployee?.id}
              errors={editFormErrors}
              onFieldBlur={(k, err) => setEditFormErrors((p) => ({ ...p, [k]: err }))}
              lockedIdentity={!!selectedEmployee?.identity_verified}
              idPrefix="empeditfield-"
              forceOpen={editSubmitAttempted}
            />

            <FormSection
              label="Family, References & Checklist"
              open={editSections.isOpen("children")}
              onToggle={() => editSections.toggle("children")}
            >
              <EmployeeChildTables employeeId={selectedEmployee.id} />
            </FormSection>

            <FormSection
              label="Lifecycle & Verification"
              open={editSections.isOpen("lifecycle")}
              onToggle={() => editSections.toggle("lifecycle")}
            >
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
            </FormSection>

            <FormSection
              label="Add Documents"
              open={editSections.isOpen("docs")}
              onToggle={() => editSections.toggle("docs")}
            >
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
            </FormSection>

            {editSubmitAttempted && <FieldErrorSummary errors={editFormErrors} idPrefix="empeditfield-" />}

            <div className="flex items-center gap-3 pt-4">
              <Button variant="primary" size="md" className="flex-1" disabled={editing}>
                {editing ? "Updating…" : "Update Employee"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsEditModalOpen(false)}>
                Cancel
              </Button>
              {/* Phase 3G: Delete is gone — Archive requires a reason, is logged,
                  and never removes rows. */}
              <button
                type="button"
                onClick={() => handleArchive(selectedEmployee)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm text-danger-700 hover:bg-danger-50 border border-danger-200"
              >
                <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                Archive
              </button>
            </div>
          </form>
        )}
      </Modal>
      {/* Separation modal — type + effective date + outstanding dues + reason. */}
      <Modal
        isOpen={fireTarget !== null}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => setFireTarget(null)}
        title="Fire / Resign guard"
        size="sm"
      >
        {fireTarget && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Separating{" "}
              <span className="text-slate-900 font-medium">{fireTarget.full_name}</span>{" "}
              ({fireTarget.employee_code}). Removes them from the roster from the day
              after the last working day; prior attendance stays intact.
            </p>

            {/* Separation type — both remove from the roster identically; they
                differ only in recorded reason + default rehire eligibility. */}
            <div>
              <span className="block text-sm text-slate-700 mb-1">Separation type</span>
              <div className="flex gap-2">
                {([["firing", "Firing"], ["resignation", "Resignation"]] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => { setFireType(val); setFireEligible(val === "resignation"); }}
                    className={`flex-1 px-3 py-2 rounded-md text-sm border transition-colors ${fireType === val ? "bg-brand-500 text-brand-950 border-brand-500 font-medium" : "border-border text-muted-foreground hover:bg-accent"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Effective date — Today or a picker. */}
            <div>
              <label className="block text-sm text-slate-700 mb-1">Effective (last working) date *</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFireDate(todayIso())}
                  className={`px-3 py-2 rounded-md text-sm border ${fireDate === todayIso() ? "bg-slate-100 border-slate-300 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                >
                  Today
                </button>
                <input
                  type="date"
                  value={fireDate}
                  onChange={(e) => setFireDate(e.target.value)}
                  className="flex-1 px-3 py-2 border border-slate-200 rounded-md text-sm"
                />
              </div>
            </div>

            {/* Outstanding dues — only shown when there is something outstanding. */}
            {fireGatesLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Checking outstanding dues…
              </div>
            ) : fireGates && (
              fireGates.undisbursed_salary > 0 ||
              fireGates.outstanding_advance > 0 ||
              fireGates.outstanding_kit_count > 0 ||
              fireGates.open_incident_count > 0
            ) ? (
              <div className="rounded-md border border-warning-200 bg-warning-50 p-3 space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-warning-800">
                  Outstanding before exit
                </p>
                <ul className="text-sm text-warning-900 space-y-1">
                  {fireGates.undisbursed_salary > 0 && (
                    <li className="flex justify-between gap-4">
                      <span>Salary not yet disbursed</span>
                      <span className="font-medium tabular-nums">{fireGates.undisbursed_salary.toLocaleString()}</span>
                    </li>
                  )}
                  {fireGates.outstanding_advance > 0 && (
                    <li className="flex justify-between gap-4">
                      <span>Advance outstanding</span>
                      <span className="font-medium tabular-nums">{fireGates.outstanding_advance.toLocaleString()}</span>
                    </li>
                  )}
                  {fireGates.outstanding_kit_count > 0 && (
                    <li className="flex justify-between gap-4">
                      <span>Equipment / kit not returned</span>
                      <span className="font-medium tabular-nums">{fireGates.outstanding_kit_count} item{fireGates.outstanding_kit_count === 1 ? "" : "s"}</span>
                    </li>
                  )}
                  {fireGates.open_incident_count > 0 && (
                    <li className="flex justify-between gap-4">
                      <span>Open incidents</span>
                      <span className="font-medium tabular-nums">{fireGates.open_incident_count}</span>
                    </li>
                  )}
                </ul>
                <p className="text-xs text-warning-700 pt-1">
                  These are recorded on the exit clearance; final dues can only be released once settled.
                </p>
              </div>
            ) : fireGates ? (
              <p className="text-sm text-success-700">No outstanding dues, kit, or open incidents.</p>
            ) : null}

            <div>
              <label className="block text-sm text-slate-700 mb-1">
                {fireType === "resignation" ? "Resignation note *" : "Reason for firing *"}
              </label>
              <textarea
                value={fireReason}
                onChange={(e) => setFireReason(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                placeholder={fireType === "resignation" ? "e.g. Resigned for personal reasons…" : "e.g. Repeated no-shows, misconduct…"}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={fireEligible} onChange={(e) => setFireEligible(e.target.checked)} />
              <span>Eligible for rehire</span>
            </label>

            {fireError && <p className="text-xs text-danger-600">{fireError}</p>}

            <div className="flex items-center gap-3 pt-2">
              <Button
                variant="danger"
                size="md"
                className="flex-1"
                disabled={fireSubmitting || fireGatesLoading}
                onClick={confirmFire}
              >
                {fireSubmitting ? "Saving…" : fireType === "resignation" ? "Confirm Resignation" : "Confirm Fire"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setFireTarget(null)}>
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
  physicalCopyPresent,
  onPhysicalCopyChange,
}: {
  employee: EmployeeRow;
  onChanged: () => void | Promise<void>;
  physicalCopyPresent: boolean;
  onPhysicalCopyChange: (v: boolean) => void;
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

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {!verified && (
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={verify}>
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Verify identity
          </Button>
        )}
        <PhysicalCopyToggle checked={physicalCopyPresent} onChange={onPhysicalCopyChange} />
      </div>

      {verified && (
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

// Phase 3F: History tab — the unified service-log timeline (lifecycle, approvals,
// postings, warnings, incidents, training) from the employee_service_history view.
function ServiceHistoryTab({ employeeId }: { employeeId: string }) {
  const [rows, setRows] = useState<
    { kind: string; title: string; detail: string | null; event_at: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    supabase
      .from("employee_service_history")
      .select("*")
      .eq("employee_id", employeeId)
      .order("event_at", { ascending: false })
      .then(({ data }) => {
        if (!alive) return;
        setRows((data ?? []) as typeof rows);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [employeeId]);
  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (rows.length === 0) return <p className="text-sm text-slate-500">No history yet.</p>;
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-3 text-sm border-b border-slate-100 pb-2 last:border-0">
          <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600 capitalize h-fit whitespace-nowrap">{r.kind}</span>
          <div className="min-w-0 flex-1">
            <p className="text-slate-900">{r.title}</p>
            {r.detail && <p className="text-xs text-slate-500">{r.detail}</p>}
            <p className="text-[11px] text-slate-400">{new Date(r.event_at).toLocaleDateString()}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// CNIC card expiry: expired when the expiry date is strictly before today.
// (ISO YYYY-MM-DD strings compare correctly lexicographically.)
const isCardExpired = (cnicExpiry?: string | null): boolean =>
  !!cnicExpiry && cnicExpiry < todayIso();

const fmtDate = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString();
};

// Phase 8 §11.3: bulk document generation. Generates one combined PDF for the
// whole filtered set (append-mode per guard), with progress and per-guard
// partial-failure handling — a failure is reported, the batch continues.
function BulkGenerateModal({
  employees, clients, branding, displayFor, buildApprovals, onClose,
}: {
  employees: EmployeeRow[];
  clients: Client[];
  branding: PdfBranding;
  displayFor: (e: EmployeeRow) => string;
  buildApprovals: (id: string) => Promise<FormApprovals>;
  onClose: () => void;
}) {
  const [docType, setDocType] = useState<"data_form" | "id_card">("data_form");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [failures, setFailures] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);

  const run = async () => {
    setRunning(true); setDone(0); setFailures([]); setFinished(false);
    const combined = new jsPDF({ unit: "mm", format: "a4" });
    let started = false;
    const fails: string[] = [];
    for (const emp of employees) {
      try {
        if (docType === "data_form") {
          const [c, r, j, d, approvals] = await Promise.all([
            supabase.from("employee_children").select("*").eq("employee_id", emp.id).order("created_at"),
            supabase.from("employee_references").select("*").eq("employee_id", emp.id),
            supabase.from("employee_previous_jobs").select("*").eq("employee_id", emp.id).order("seq"),
            supabase.from("employee_document_checklist").select("*").eq("employee_id", emp.id).order("doc_type"),
            buildApprovals(emp.id),
          ]);
          if (started) combined.addPage();
          generateEmployeeFormPdf({
            employee: emp, branding, approvals,
            children: (c.data ?? []) as EmployeeChild[],
            references: (r.data ?? []) as EmployeeReference[],
            jobs: (j.data ?? []) as EmployeePreviousJob[],
            checklist: (d.data ?? []) as EmployeeDocumentChecklistItem[],
            doc: combined,
          });
        } else {
          if (started) combined.addPage();
          generateIdCardPdf({
            branding,
            full_name: emp.full_name,
            guard_code: emp.guard_code ?? emp.employee_code,
            display_code: displayFor(emp),
            company_id_card_number: emp.company_id_card_number,
            designation: (emp as { designation?: string | null }).designation,
            client_name: emp.client_name,
            cnic_number: emp.cnic_number,
            photo_url: (emp as { photo_url?: string | null }).photo_url,
            doc: combined,
          });
        }
        started = true;
      } catch (e: any) {
        fails.push(`${emp.full_name}: ${e.message ?? String(e)}`);
      }
      setDone((n) => n + 1);
    }
    if (started) combined.save(`${docType === "data_form" ? "data-forms" : "id-cards"}-${employees.length}.pdf`);
    setFailures(fails); setFinished(true); setRunning(false);
  };

  void clients;
  return (
    <Modal isOpen onClose={onClose} size="sm" title={`Generate documents — ${employees.length} guard(s)`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>{finished ? "Close" : "Cancel"}</Button>
          <Button size="sm" onClick={run} disabled={running || employees.length === 0}>
            {running && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Generate
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block"><span className="text-sm text-slate-600">Document</span>
          <ThemedSelect value={docType} onChange={(e) => setDocType(e.target.value as "data_form" | "id_card")} disabled={running}
            className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-md text-sm">
            <option value="data_form">Employee Data Form (2-page)</option>
            <option value="id_card">Company ID Card</option>
          </ThemedSelect>
        </label>
        <p className="text-xs text-slate-500">
          One combined PDF for all {employees.length} guards in the current filter. Failures are reported without stopping the batch.
        </p>
        {(running || finished) && (
          <div>
            <div className="h-2 bg-slate-100 rounded overflow-hidden">
              <div className="h-2 bg-brand-500 transition-all" style={{ width: `${employees.length ? (done / employees.length) * 100 : 0}%` }} />
            </div>
            <p className="text-xs text-slate-500 mt-1">{done} / {employees.length} processed{finished ? " — done" : "…"}</p>
          </div>
        )}
        {finished && failures.length > 0 && (
          <div className="text-xs text-danger-700 bg-danger-50 border border-danger-200 rounded p-2 max-h-32 overflow-auto">
            <p className="font-medium mb-1">{failures.length} failed:</p>
            {failures.map((f, i) => <p key={i}>{f}</p>)}
          </div>
        )}
        {finished && failures.length === 0 && (
          <p className="text-xs text-success-700">All {employees.length} generated successfully.</p>
        )}
      </div>
    </Modal>
  );
}

// Phase 7 §9: Record separation — sets the two dates + reason, closes the active
// posting (RPC), moves lifecycle, generates the discharge sheet PDF and files it
// into guard_documents. NOTHING is deleted; the guard leaves rosters via the window.
const SEPARATION_REASONS: { value: string; label: string }[] = [
  { value: "resignation", label: "Resigned" },
  { value: "termination_misconduct", label: "Terminated — misconduct" },
  { value: "termination_performance", label: "Terminated — performance" },
  { value: "absconded", label: "Absconded" },
  { value: "retirement", label: "Retired" },
  { value: "deceased", label: "Deceased" },
  { value: "contract_end", label: "Contract ended" },
  { value: "medical_unfit", label: "Medically unfit" },
];

function SeparationModal({
  guard, displayCode, branding, onClose, onDone, onError,
}: {
  guard: EmployeeRow; displayCode: string; branding: PdfBranding;
  onClose: () => void; onDone: () => Promise<void>; onError: (m: string) => void;
}) {
  const [reason, setReason] = useState("resignation");
  const [lastWorkingDay, setLastWorkingDay] = useState(todayIso());
  const [terminationDate, setTerminationDate] = useState(todayIso());
  const [rehireEligible, setRehireEligible] = useState(true);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fail = (m: string) => { setErr(m); onError(m); };
  const inputCls = "mt-1 w-full px-3 py-2 border border-slate-200 rounded-md text-sm";

  const save = async () => {
    if (!note.trim()) { fail("A separation reason/note is required."); return; }
    setSaving(true);
    setErr(null);
    try {
      const { error: sepErr } = await supabase.rpc("record_separation", {
        p_guard: guard.id,
        p_reason: reason,
        p_last_working_day: lastWorkingDay,
        p_termination_date: terminationDate || null,
        p_rehire_eligible: rehireEligible,
        p_note: note.trim(),
      });
      if (sepErr) throw sepErr;
      // §9.4: generate the discharge sheet and file it into guard_documents.
      generateDischargeSheet({
        branding,
        full_name: guard.full_name,
        guard_code: guard.guard_code ?? guard.employee_code,
        display_code: displayCode,
        cnic_number: (guard as any).cnic_number,
        join_date: guard.join_date,
        last_working_day: lastWorkingDay,
        termination_date: terminationDate,
        separation_reason: SEPARATION_REASONS.find((r) => r.value === reason)?.label ?? reason,
        rehire_eligible: rehireEligible,
        note: note.trim(),
      });
      await supabase.from("guard_documents").upsert(
        {
          employee_id: guard.id, doc_type: "discharge_sheet", status: "on_file",
          issue_date: todayIso(), notes: "Generated on separation",
        },
        { onConflict: "employee_id,doc_type" },
      );
      await onDone();
    } catch (e: any) { fail(e.message ?? String(e)); setSaving(false); }
  };

  return (
    <Modal isOpen onClose={onClose} size="md" title={`Record separation — ${guard.full_name} (${displayCode})`}
      error={err} onDismissError={() => setErr(null)}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Record separation
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500">Closes the active posting and removes the guard from rosters after the last working day. Nothing is deleted — full history is retained.</p>
        <label className="block"><span className="text-sm text-slate-600">Reason</span>
          <ThemedSelect value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls}>
            {SEPARATION_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </ThemedSelect>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-sm text-slate-600">Last working day *</span>
            <input type="date" value={lastWorkingDay} onChange={(e) => setLastWorkingDay(e.target.value)} className={inputCls} />
          </label>
          <label className="block"><span className="text-sm text-slate-600">Termination date (HR)</span>
            <input type="date" value={terminationDate} onChange={(e) => setTerminationDate(e.target.value)} className={inputCls} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={rehireEligible} onChange={(e) => setRehireEligible(e.target.checked)} /> Eligible for rehire
        </label>
        <label className="block"><span className="text-sm text-slate-600">Reason / note *</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={inputCls} />
        </label>
      </div>
    </Modal>
  );
}

// Phase 7 §9.6: Rehire — relinks to the SAME record (same permanent code + history).
// Salary increments & history (edit modal). Reads the effective-dated
// employee_salary_history so past pay is visible with its effective dates, and
// records a new increment via set_employee_salary (the blessed RPC: writes history
// AND updates the live employee row when the change is in effect on/before today).
type SalaryHistoryRow = {
  effective_date: string;
  base_salary: number | null;
  allowance: number | null;
  per_day_salary: number | null;
  reason: string | null;
};
export function SalaryHistoryPanel({
  employeeId, currentBase, currentAllowance, onApplied,
}: {
  employeeId: string;
  currentBase: string;
  currentAllowance: string;
  onApplied: (base: number, allowance: number, perDay: number) => void;
}) {
  const [rows, setRows] = useState<SalaryHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [newBase, setNewBase] = useState(currentBase);
  const [newAllowance, setNewAllowance] = useState(currentAllowance);
  const [effDate, setEffDate] = useState(todayIso());
  const [reason, setReason] = useState("Increment");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("employee_salary_history")
      .select("effective_date, base_salary, allowance, per_day_salary, reason")
      .eq("employee_id", employeeId)
      .order("effective_date", { ascending: false });
    setRows((data ?? []) as SalaryHistoryRow[]);
    setLoading(false);
  }, [employeeId]);
  useEffect(() => { load(); }, [load]);

  const fmt = (n: number | null | undefined) =>
    n == null ? "—" : `PKR ${Number(n).toLocaleString()}`;

  const apply = async () => {
    const base = Number(newBase);
    if (!newBase || isNaN(base) || base <= 0) { setErr("Enter a valid new base salary."); return; }
    if (!effDate) { setErr("Pick an effective date."); return; }
    setSaving(true); setErr(null);
    const perDay = base / daysInCurrentMonth();
    const allowanceNum = newAllowance ? Math.max(0, Number(newAllowance)) : 0;
    const { error } = await supabase.rpc("set_employee_salary", {
      p_employee_id: employeeId,
      p_effective_date: effDate,
      p_base_salary: base,
      p_allowance: allowanceNum,
      p_per_day_salary: perDay,
      p_reason: reason.trim() || "Increment",
    });
    if (error) { setErr(error.message); setSaving(false); return; }
    await load();
    // If the raise is already in effect (on/before today), reflect it in the live
    // salary fields so the modal shows the new current salary.
    if (effDate <= todayIso()) onApplied(base, allowanceNum, perDay);
    setSaving(false);
    setOpen(false);
  };

  return (
    <div className="md:col-span-2 border border-slate-200 rounded-md p-3 bg-slate-50/50">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-slate-800">Salary increments &amp; history</h4>
        <button
          type="button"
          className="text-xs text-brand-700 hover:underline"
          onClick={() => { setNewBase(currentBase); setNewAllowance(currentAllowance); setOpen((o) => !o); setErr(null); }}
        >
          {open ? "Close" : "Add increment"}
        </button>
      </div>

      {open && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border border-slate-200 bg-white p-3">
          <div>
            <label className="block text-xs text-slate-600 mb-1">New base salary (PKR)</label>
            <input type="number" value={newBase} onChange={(e) => setNewBase(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Allowance (PKR)</label>
            <input type="number" min={0} value={newAllowance} onChange={(e) => setNewAllowance(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" placeholder="0" />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Effective date</label>
            <input type="date" value={effDate} onChange={(e) => setEffDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
            <p className="text-[11px] text-slate-500 mt-1">Applies from this date; earlier months keep the old salary.</p>
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Reason</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" placeholder="Increment" />
          </div>
          {err && <p className="sm:col-span-2 text-xs text-danger-600">{err}</p>}
          <div className="sm:col-span-2 flex justify-end">
            <Button size="sm" onClick={apply} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Apply increment
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 overflow-x-auto">
        {loading ? (
          <p className="text-xs text-slate-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-slate-500">No salary records yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th className="py-1.5 pr-3 font-medium">Effective date</th>
                <th className="py-1.5 pr-3 font-medium">Base</th>
                <th className="py-1.5 pr-3 font-medium">Allowance</th>
                <th className="py-1.5 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.effective_date} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-3 text-slate-800">
                    {fmtDate(r.effective_date)}
                    {i === 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">current</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-slate-800 font-mono">{fmt(r.base_salary)}</td>
                  <td className="py-1.5 pr-3 text-slate-600 font-mono">{fmt(r.allowance)}</td>
                  <td className="py-1.5 text-slate-500">{r.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RehireModal({
  guard, clients, onClose, onDone, onError,
}: {
  guard: EmployeeRow; clients: Client[];
  onClose: () => void; onDone: () => Promise<void>; onError: (m: string) => void;
}) {
  const [joinDate, setJoinDate] = useState(todayIso());
  const [clientId, setClientId] = useState(guard.client_id ?? "");
  // Salary is re-confirmed on rehire — often a returning guard comes back on a new
  // rate. Prefilled from their last salary; recorded effective from the join date.
  const [baseSalary, setBaseSalary] = useState(guard.base_salary != null ? String(guard.base_salary) : "");
  const [allowance, setAllowance] = useState(guard.allowance != null ? String(guard.allowance) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fail = (m: string) => { setErr(m); onError(m); };
  const inputCls = "mt-1 w-full px-3 py-2 border border-slate-200 rounded-md text-sm";
  const perDay = baseSalary ? computePerDay(baseSalary) : "";

  const save = async () => {
    if (!clientId) { fail("Select the client to rehire into."); return; }
    setSaving(true);
    setErr(null);
    try {
      const { error: rErr } = await supabase.rpc("rehire_guard", {
        p_guard: guard.id, p_join_date: joinDate, p_client_id: clientId,
      });
      if (rErr) throw rErr;
      // New client-prefixed display code for the new stint (permanent code kept).
      await supabase.rpc("assign_display_number", { p_employee_id: guard.id });
      // Record the (possibly new) salary effective from the rehire date, so this
      // stint pays the rehire rate and it lands in salary history.
      if (baseSalary) {
        const { error: salErr } = await supabase.rpc("set_employee_salary", {
          p_employee_id: guard.id,
          p_effective_date: joinDate,
          p_base_salary: Number(baseSalary),
          p_allowance: allowance ? Math.max(0, Number(allowance)) : 0,
          p_per_day_salary: Number(baseSalary) / daysInCurrentMonth(),
          p_reason: "Rehire",
        });
        if (salErr) throw salErr;
      }
      await onDone();
    } catch (e: any) { fail(e.message ?? String(e)); setSaving(false); }
  };

  return (
    <Modal isOpen onClose={onClose} size="sm" title={`Rehire — ${guard.full_name}`}
      error={err} onDismissError={() => setErr(null)}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Rehire
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Same person, same permanent code ({guard.guard_code ?? guard.employee_code}) and full history. Opens a new posting and reopens the employment window.
        </p>
        <label className="block"><span className="text-sm text-slate-600">Rehire (joining) date</span>
          <input type="date" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} className={inputCls} />
        </label>
        <label className="block"><span className="text-sm text-slate-600">Client</span>
          <ThemedSelect value={clientId} onChange={(e) => setClientId(e.target.value)} className={inputCls}>
            <option value="">— Select —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </ThemedSelect>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-sm text-slate-600">Base salary (PKR)</span>
            <input type="number" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} className={inputCls} placeholder="0" />
          </label>
          <label className="block"><span className="text-sm text-slate-600">Allowance (PKR)</span>
            <input type="number" min={0} value={allowance} onChange={(e) => setAllowance(e.target.value)} className={inputCls} placeholder="0" />
          </label>
        </div>
        {baseSalary && (
          <p className="text-[11px] text-slate-500">
            Per day (this month): PKR {Number(perDay).toLocaleString()} · recorded effective {fmtDate(joinDate)}.
          </p>
        )}
      </div>
    </Modal>
  );
}

// Phase 4: dedicated "Change client" action — the ONLY way to move a guard.
// Closes the current posting and opens a new dated one (never edits in place),
// wired to Phase-2 display-code renumbering. Same-client shift change keeps the
// number. The word "deployment" never appears here.
export function ChangeClientModal({
  guard,
  clients,
  contractsForClient,
  linesForContract,
  displayCode,
  onClose,
  onDone,
  onError,
}: {
  guard: EmployeeRow;
  clients: Client[];
  contractsForClient: (clientId: string) => Contract[];
  linesForContract: (contractId: string) => ContractLine[];
  displayCode: string;
  onClose: () => void;
  onDone: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [clientId, setClientId] = useState(guard.client_id ?? "");
  const [contractLineId, setContractLineId] = useState("");
  const [reason, setReason] = useState<
    "relief_cover" | "return_to_pool" | "separation" | "shift_change"
  >("relief_cover");
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fail = (m: string) => { setErr(m); onError(m); };

  const clientChanged = clientId !== (guard.client_id ?? "");
  const lines = clientId
    ? contractsForClient(clientId).flatMap((c) => linesForContract(c.id))
    : [];

  const save = async () => {
    if (!clientId) {
      fail("Select a client.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const { error: moveErr } = await supabase.rpc("change_client", {
        p_guard_id: guard.id,
        p_new_client_id: clientId,
        p_contract_line_id: contractLineId || null,
        p_reason: reason,
        p_effective_date: effectiveDate || null,
      });
      if (moveErr) throw moveErr;
      // Only a real client change renumbers the display code + logs the transition.
      if (clientChanged) {
        const { data: newDisp, error: dispErr } = await supabase.rpc("assign_display_number", {
          p_employee_id: guard.id,
        });
        if (dispErr) throw dispErr;
        const permanent = guard.guard_code ?? guard.employee_code;
        const { error: histErr } = await supabase.from("employee_code_history").insert({
          company_id: guard.company_id,
          employee_id: guard.id,
          old_code: displayCode,
          new_code: (newDisp as string | null) ?? permanent,
          client_id: clientId,
          reason: "reassigned",
        });
        if (histErr) throw histErr;
      }
      await onDone();
    } catch (e: any) {
      fail(e.message ?? String(e));
      setSaving(false);
    }
  };

  const inputCls = "mt-1 w-full px-3 py-2 border border-slate-200 rounded-md text-sm";
  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title="Change client"
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Moving {guard.full_name} ({displayCode}). This closes the current client record and opens a
          new dated one.{clientChanged && " A new client number will be issued."}
        </p>
        <label className="block">
          <span className="text-sm text-slate-600">Client</span>
          <ThemedSelect
            value={clientId}
            onChange={(e) => { setClientId(e.target.value); setContractLineId(""); }}
            className={inputCls}
          >
            <option value="">— Select —</option>
            {clients.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
          </ThemedSelect>
        </label>
        <label className="block">
          <span className="text-sm text-slate-600">Contract line (optional)</span>
          <ThemedSelect value={contractLineId} onChange={(e) => setContractLineId(e.target.value)} className={inputCls}>
            <option value="">— None —</option>
            {lines.map((l) => (<option key={l.id} value={l.id}>{l.label ?? l.category}</option>))}
          </ThemedSelect>
        </label>
        <label className="block">
          <span className="text-sm text-slate-600">Reason</span>
          <ThemedSelect value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} className={inputCls}>
            <option value="relief_cover">Relief cover</option>
            <option value="shift_change">Shift change (same client)</option>
            <option value="return_to_pool">Return to pool</option>
            <option value="separation">Separation</option>
          </ThemedSelect>
        </label>
        <label className="block">
          <span className="text-sm text-slate-600">Effective date</span>
          <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={inputCls} />
        </label>
      </div>
    </Modal>
  );
}

// Dedicated "Change category" action — move an employee between reliever, client
// and office staff. Mirrors Change client's dated-posting model: the change_category
// RPC closes any open posting at eff-1 and (for → client) opens a new dated one, so
// past attendance stays put and the new category applies from the effective date.
// The permanent code is untouched; leaving a client drops the client-prefixed
// display code. The transition is logged to employee_code_history (History tab).
const CHANGE_CATEGORY_LABEL: Record<EmployeeCategory, string> = {
  client: "Client",
  office_staff: "Office Staff",
  reliever: "Reliever",
};

export function ChangeCategoryModal({
  guard,
  clients,
  contractsForClient,
  linesForContract,
  displayCode,
  onClose,
  onDone,
  onError,
}: {
  guard: EmployeeRow;
  clients: Client[];
  contractsForClient: (clientId: string) => Contract[];
  linesForContract: (contractId: string) => ContractLine[];
  displayCode: string;
  onClose: () => void;
  onDone: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const currentCategory = (guard.category ?? "client") as EmployeeCategory;
  // The current category is never an option — you can only move to a different one.
  const categoryOptions = (["reliever", "client", "office_staff"] as EmployeeCategory[])
    .filter((c) => c !== currentCategory);
  const [category, setCategory] = useState<EmployeeCategory>(categoryOptions[0]);
  const [clientId, setClientId] = useState(guard.client_id ?? "");
  const [contractLineId, setContractLineId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fail = (m: string) => { setErr(m); onError(m); };

  const lines = clientId
    ? contractsForClient(clientId).flatMap((c) => linesForContract(c.id))
    : [];
  const movingToClient = category === "client";
  const changed =
    category !== currentCategory ||
    (movingToClient && clientId !== (guard.client_id ?? ""));

  const save = async () => {
    if (!changed) { fail("Pick a different category (or a different client)."); return; }
    if (movingToClient && !clientId) { fail("Select a client to move this employee to."); return; }
    setSaving(true);
    setErr(null);
    try {
      const { error: rpcErr } = await supabase.rpc("change_category", {
        p_guard_id: guard.id,
        p_new_category: category,
        p_new_client_id: movingToClient ? clientId : null,
        p_contract_line_id: movingToClient ? (contractLineId || null) : null,
        p_effective_date: effectiveDate || null,
      });
      if (rpcErr) throw rpcErr;

      // Preserve the transition in history. The permanent code is immutable; only
      // the display code changes (new client number on → client, permanent code
      // otherwise). old_code holds the PRIOR display, captured before the change.
      const permanent = guard.guard_code ?? guard.employee_code;
      let newDisplay = permanent;
      let logClientId: string | null = null;
      if (movingToClient) {
        const { data: newDisp, error: dispErr } = await supabase.rpc("assign_display_number", {
          p_employee_id: guard.id,
        });
        if (dispErr) throw dispErr;
        newDisplay = (newDisp as string | null) ?? permanent;
        logClientId = clientId;
      }
      const { error: histErr } = await supabase.from("employee_code_history").insert({
        company_id: guard.company_id,
        employee_id: guard.id,
        old_code: displayCode,
        new_code: newDisplay,
        client_id: logClientId,
        reason: `category: ${CHANGE_CATEGORY_LABEL[currentCategory]} → ${CHANGE_CATEGORY_LABEL[category]}`,
      });
      if (histErr) throw histErr;
      await onDone();
    } catch (e: any) {
      fail(e.message ?? String(e));
      setSaving(false);
    }
  };

  const inputCls = "mt-1 w-full px-3 py-2 border border-slate-200 rounded-md text-sm";
  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title="Change category"
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Moving {guard.full_name} ({displayCode}) from{" "}
          <span className="font-medium">{CHANGE_CATEGORY_LABEL[currentCategory]}</span>. Past attendance
          stays under the old posting; the new category applies from the effective date.
          {movingToClient && " A new client number will be issued."}
        </p>
        <label className="block">
          <span className="text-sm text-slate-600">Category</span>
          <ThemedSelect
            value={category}
            onChange={(e) => {
              const next = e.target.value as EmployeeCategory;
              setCategory(next);
              if (next !== "client") { setClientId(""); setContractLineId(""); }
              else if (!clientId) setClientId(guard.client_id ?? "");
            }}
            className={inputCls}
          >
            {categoryOptions.map((c) => (
              <option key={c} value={c}>{CHANGE_CATEGORY_LABEL[c]}</option>
            ))}
          </ThemedSelect>
        </label>
        {movingToClient && (
          <>
            <label className="block">
              <span className="text-sm text-slate-600">Client</span>
              <ThemedSelect
                value={clientId}
                onChange={(e) => { setClientId(e.target.value); setContractLineId(""); }}
                className={inputCls}
              >
                <option value="">— Select —</option>
                {clients.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </ThemedSelect>
            </label>
            <label className="block">
              <span className="text-sm text-slate-600">Contract line (optional)</span>
              <ThemedSelect value={contractLineId} onChange={(e) => setContractLineId(e.target.value)} className={inputCls}>
                <option value="">— None —</option>
                {lines.map((l) => (<option key={l.id} value={l.id}>{l.label ?? l.category}</option>))}
              </ThemedSelect>
            </label>
          </>
        )}
        <label className="block">
          <span className="text-sm text-slate-600">Effective date</span>
          <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={inputCls} />
        </label>
      </div>
    </Modal>
  );
}

// §7.5: dated shift change. Options are the guard's SITE's actual
// shift_definitions (Phase 1) — never a hardcoded list. Closes the current
// posting (day before the change) and opens a new one on the chosen shift from
// the change date; nothing is rewritten in place, so past attendance stays on
// the old shift and only dates from the change date forward are on the new one.
export function ChangeShiftModal({
  guard, displayCode, onClose, onDone, onError,
}: {
  guard: EmployeeRow; displayCode: string;
  onClose: () => void; onDone: () => Promise<void>; onError: (m: string) => void;
}) {
  const [shifts, setShifts] = useState<string[]>([]);
  const [loadingShifts, setLoadingShifts] = useState(true);
  const [newShift, setNewShift] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fail = (m: string) => { setErr(m); onError(m); };
  const inputCls = "mt-1 w-full px-3 py-2 border border-slate-200 rounded-md text-sm";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingShifts(true);
      // Resolve the guard's site: their current open posting, else the client's
      // default site. The shift list is whatever that site's shift_definitions say.
      let siteId: string | null = null;
      const { data: dep } = await supabase
        .from("deployments").select("site_id")
        .eq("guard_id", guard.id).is("end_date", null)
        .order("start_date", { ascending: false }).limit(1).maybeSingle();
      siteId = (dep as { site_id?: string } | null)?.site_id ?? null;
      if (!siteId && guard.client_id) {
        const { data: s } = await supabase
          .from("sites").select("id")
          .eq("client_id", guard.client_id).eq("is_default", true).limit(1).maybeSingle();
        siteId = (s as { id?: string } | null)?.id ?? null;
      }
      let codes: string[] = [];
      if (siteId) {
        const { data: sd } = await supabase
          .from("shift_definitions").select("shift_code, start_time")
          .eq("site_id", siteId).order("start_time", { ascending: true });
        codes = (sd ?? []).map((r: any) => r.shift_code as string);
      }
      // Ensure the current shift is always present so the list is never empty.
      if (!codes.includes(guard.shift)) codes = [...codes, guard.shift];
      if (cancelled) return;
      setShifts(codes);
      setNewShift(codes.find((c) => c !== guard.shift) ?? guard.shift);
      setLoadingShifts(false);
    })();
    return () => { cancelled = true; };
  }, [guard.id, guard.client_id, guard.shift]);

  const save = async () => {
    if (!newShift) { fail("Select a shift."); return; }
    if (newShift === guard.shift) { fail("Pick a different shift from the current one."); return; }
    if (!effectiveDate) { fail("An effective date is required."); return; }
    setSaving(true);
    setErr(null);
    try {
      const { error: cErr } = await supabase.rpc("change_guard_shift", {
        p_guard: guard.id, p_new_shift: newShift, p_effective_date: effectiveDate,
      });
      if (cErr) throw cErr;
      await onDone();
    } catch (e: any) { fail(e.message ?? String(e)); setSaving(false); }
  };

  return (
    <Modal isOpen onClose={onClose} size="sm" title={`Change shift — ${guard.full_name}`}
      error={err} onDismissError={() => setErr(null)}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving || loadingShifts}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Change shift
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          {guard.full_name} ({displayCode}) is currently on the{" "}
          <span className="font-medium capitalize">{guard.shift}</span> shift. From the effective
          date they move to the new shift; all attendance before that date stays on the old shift.
        </p>
        <label className="block"><span className="text-sm text-slate-600">New shift</span>
          <ThemedSelect value={newShift} onChange={(e) => setNewShift(e.target.value)} className={inputCls} disabled={loadingShifts}>
            {shifts.map((s) => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}{s === guard.shift ? " (current)" : ""}</option>
            ))}
          </ThemedSelect>
        </label>
        <label className="block"><span className="text-sm text-slate-600">Effective date</span>
          <div className="mt-1 flex items-center gap-2">
            <button type="button" onClick={() => setEffectiveDate(todayIso())}
              className={`px-3 py-2 rounded-md text-sm border ${effectiveDate === todayIso() ? "bg-slate-100 border-slate-300 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
              Today
            </button>
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)}
              className="flex-1 px-3 py-2 border border-slate-200 rounded-md text-sm" />
          </div>
        </label>
      </div>
    </Modal>
  );
}

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
  idPrefix = "",
  forceOpen = false,
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
  // Prefix for input DOM ids, so the parent's "jump to field" can target them.
  idPrefix?: string;
  // When true (a save was attempted with errors), sections holding an invalid
  // field auto-expand so the field — and the jump-to-field target — are visible.
  forceOpen?: boolean;
}) {
  const lockCls = lockedIdentity ? " bg-slate-50 text-slate-500 cursor-not-allowed" : "";
  const inputCls = "w-full px-3 py-2 border border-slate-200 rounded-md text-sm";

  // Text / textarea inputs bound to a string field on FormState.
  const txt = (
    key: keyof FormState,
    label: string,
    opts: { type?: string; placeholder?: string; format?: (v: string) => string; maxLength?: number } = {},
  ) => (
    <div>
      <label className="block text-sm text-slate-700 mb-1">{label}</label>
      <input
        type={opts.type ?? "text"}
        value={(form[key] as string) ?? ""}
        onChange={(e) => setForm({ ...form, [key]: opts.format ? opts.format(e.target.value) : e.target.value })}
        className={inputCls}
        placeholder={opts.placeholder}
        maxLength={opts.maxLength}
      />
    </div>
  );
  const area = (key: keyof FormState, label: string) => (
    <div className="col-span-2">
      <label className="block text-sm text-slate-700 mb-1">{label}</label>
      <textarea rows={2} value={(form[key] as string) ?? ""}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={inputCls} />
    </div>
  );

  const personalHasError = Boolean(errors.cnic_number || errors.permanent_address || errors.current_address);
  const emergencyHasError = Boolean(errors.emergency_contact_phone);
  const cardExpired = isCardExpired(form.cnic_expiry);

  const supervisorOptions = useMemo(
    () => employees.filter((e) => e.id !== excludeEmployeeId && e.status === "Active"),
    [employees, excludeEmployeeId],
  );

  // Collapsible sections (Licences & Compliance folded into Internal Office
  // Data). Shared by the Add and Edit modals via this one component. Nothing is
  // expanded on open — the form is long, so the user picks what to fill in.
  const HR_SECTIONS = [
    { id: "personal", label: "Personal Information" },
    { id: "emergency", label: "Emergency Contact" },
    { id: "contract", label: "Contract & Reporting" },
    { id: "exservice", label: "Ex-Service" },
    { id: "experience", label: "Experience" },
    { id: "office", label: "Internal Office Data" },
  ] as const;
  type HrSectionId = (typeof HR_SECTIONS)[number]["id"];
  const [openSections, setOpenSections] = useState<HrSectionId[]>([]);
  const isOpen = (id: HrSectionId) => openSections.includes(id);
  const toggleSection = (id: HrSectionId) =>
    setOpenSections((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // On a failed save, expand the section holding the first invalid field so the
  // error isn't hidden inside a collapsed panel.
  useEffect(() => {
    if (!forceOpen) return;
    setOpenSections((prev) => {
      const next = new Set<HrSectionId>(prev);
      if (personalHasError) next.add("personal");
      if (emergencyHasError) next.add("emergency");
      return next.size === prev.length ? prev : [...next];
    });
  }, [forceOpen, personalHasError, emergencyHasError]);

  // Photo stored as a data URL in photo_url (buckets are private; this keeps the
  // upload self-contained and works in the Add modal before an id exists). The
  // image is downscaled to ≤512px JPEG so the row (and the list select) stays light.
  const onPhoto = (file: File | null) => {
    if (!file) { setForm({ ...form, photo_url: "" }); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? "");
      const img = new window.Image();
      img.onload = () => {
        const max = 512;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { setForm({ ...form, photo_url: raw }); return; }
        ctx.drawImage(img, 0, 0, w, h);
        setForm({ ...form, photo_url: canvas.toDataURL("image/jpeg", 0.82) });
      };
      img.onerror = () => setForm({ ...form, photo_url: raw });
      img.src = raw;
    };
    reader.readAsDataURL(file);
  };

  return (
    <div>
      <h4 className="text-sm text-slate-900 mb-2 mt-2">Employee Details</h4>

      <div className="space-y-2">
      {/* ── Personal Information ─────────────────────────────────────────── */}
      <FormSection
        label={HR_SECTIONS[0].label}
        open={isOpen("personal")}
        hasError={personalHasError}
        onToggle={() => toggleSection("personal")}
      >
        <div className="space-y-4">
          {/* Photo */}
          <div>
            <label className="block text-sm text-slate-700 mb-1">Photo</label>
            <div className="flex items-center gap-3">
              {form.photo_url ? (
                <img src={form.photo_url} alt="Employee" className="w-16 h-16 rounded-md object-cover border border-slate-200" />
              ) : (
                <div className="w-16 h-16 rounded-md border border-dashed border-slate-300 flex items-center justify-center text-slate-300">
                  <ImageIcon className="w-6 h-6" />
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer w-max">
                  {form.photo_url ? "Replace photo" : "Upload photo"}
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => onPhoto(e.target.files?.[0] ?? null)} />
                </label>
                {form.photo_url && (
                  <button type="button" onClick={() => onPhoto(null)} className="text-xs text-danger-600 hover:underline w-max">Remove</button>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">CNIC Number</label>
              <input
                type="text"
                maxLength={15}
                id={idPrefix + "cnic_number"}
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
              <ThemedSelect value={form.blood_group} onChange={(e) => setForm({ ...form, blood_group: e.target.value })} className={inputCls}>
                <option value="">—</option>
                {BLOOD_GROUPS.map((bg) => <option key={bg} value={bg}>{bg}</option>)}
              </ThemedSelect>
            </div>

            {txt("cnic_expiry", "CNIC Expiry", { type: "date" })}
            {txt("education", "Education")}
            {cardExpired && (
              <div className="col-span-2 flex items-start gap-2 text-xs text-warning-800 bg-warning-50 border border-warning-200 rounded-md px-2.5 py-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-warning-600" strokeWidth={2} />
                <span>This CNIC is expired as of {fmtDate(form.cnic_expiry)} — you are adding/editing an employee with an expired card.</span>
              </div>
            )}

            <div>
              <label className="block text-sm text-slate-700 mb-1">Marital Status</label>
              <ThemedSelect value={form.marital_status}
                onChange={(e) => setForm({ ...form, marital_status: e.target.value as "" | MaritalStatus })} className={inputCls}>
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

            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Permanent Address</label>
              <textarea
                rows={2}
                id={idPrefix + "permanent_address"}
                value={form.permanent_address}
                onChange={(e) => setForm({ ...form, permanent_address: e.target.value })}
                onBlur={(e) => onFieldBlur("permanent_address", validateFreeText(e.target.value))}
                className={inputCls}
              />
              {errors.permanent_address && <p className="text-xs text-danger-600 mt-1">{errors.permanent_address}</p>}
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Current Address</label>
              <textarea
                rows={2}
                id={idPrefix + "current_address"}
                value={form.current_address}
                onChange={(e) => setForm({ ...form, current_address: e.target.value })}
                onBlur={(e) => onFieldBlur("current_address", validateFreeText(e.target.value))}
                className={inputCls}
                placeholder="Leave blank to default to permanent address"
              />
              {errors.current_address && <p className="text-xs text-danger-600 mt-1">{errors.current_address}</p>}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100">
            <h5 className="text-sm text-slate-900 mb-3">Family</h5>
            <div className="grid grid-cols-2 gap-3">
              {txt("spouse_name", "Spouse Name")}
              {txt("next_of_kin_name", "Next of Kin — Name")}
              {txt("next_of_kin_relation", "Next of Kin — Relation")}
              {txt("next_of_kin_cnic", "Next of Kin — CNIC", { format: formatCnicInline, maxLength: 15, placeholder: "XXXXX-XXXXXXX-X" })}
              {txt("next_of_kin_contact", "Next of Kin — Contact")}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100">
            <h5 className="text-sm text-slate-900 mb-3">Political / Locality</h5>
            <div className="grid grid-cols-2 gap-3">
              {txt("post_office", "Post Office")}
              {txt("police_station", "Police Station")}
              {txt("area_nazim", "Area Nazim")}
              {txt("union_council", "Union Council")}
            </div>
          </div>
        </div>
      </FormSection>

      {/* ── Emergency Contact ────────────────────────────────────────────── */}
      <FormSection
        label={HR_SECTIONS[1].label}
        open={isOpen("emergency")}
        hasError={emergencyHasError}
        onToggle={() => toggleSection("emergency")}
      >
        <div className="space-y-4">
          <div>
            <h5 className="text-sm text-slate-900 mb-3">Emergency Contact</h5>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Name</label>
                <input type="text" value={form.emergency_contact_name}
                  onChange={(e) => setForm({ ...form, emergency_contact_name: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Relation</label>
                <ThemedSelect value={form.emergency_contact_relation}
                  onChange={(e) => setForm({ ...form, emergency_contact_relation: e.target.value })} className={inputCls}>
                  <option value="">—</option>
                  {EMERGENCY_CONTACT_RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </ThemedSelect>
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Phone</label>
                <input type="tel" id={idPrefix + "emergency_contact_phone"} value={form.emergency_contact_phone}
                  onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })}
                  onBlur={(e) => onFieldBlur("emergency_contact_phone", validatePhone(e.target.value))}
                  className={inputCls} placeholder="+92 …" />
                {errors.emergency_contact_phone && <p className="text-xs text-danger-600 mt-1">{errors.emergency_contact_phone}</p>}
              </div>
            </div>
          </div>
          <div className="pt-3 border-t border-slate-100">
            <h5 className="text-sm text-slate-900 mb-3">Second Emergency Contact</h5>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {txt("emergency_contact2_name", "Name")}
              {txt("emergency_contact2_relation", "Relation")}
              {txt("emergency_contact2_phone", "Phone", { type: "tel" })}
            </div>
          </div>
        </div>
      </FormSection>

      {/* ── Contract & Reporting ─────────────────────────────────────────── */}
      <FormSection
        label={HR_SECTIONS[2].label}
        open={isOpen("contract")}
        onToggle={() => toggleSection("contract")}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Contract Type</label>
            <ThemedSelect value={form.employee_contract_type}
              onChange={(e) => setForm({ ...form, employee_contract_type: e.target.value as FormState["employee_contract_type"] })} className={inputCls}>
              <option value="">—</option>
              <option value="permanent">Permanent</option>
              <option value="contract">Contract</option>
              <option value="probation">Probation</option>
              <option value="daily_wages">Daily Wages</option>
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Probation End Date</label>
            <input type="date" value={form.probation_end_date}
              onChange={(e) => setForm({ ...form, probation_end_date: e.target.value })}
              className={inputCls} disabled={form.employee_contract_type !== "probation"} />
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Reporting To (supervisor)</label>
            <ThemedSelect value={form.reporting_to_employee_id}
              onChange={(e) => setForm({ ...form, reporting_to_employee_id: e.target.value })} className={inputCls}>
              <option value="">— Nobody —</option>
              {supervisorOptions.map((e) => <option key={e.id} value={e.id}>{e.full_name} ({e.employee_code})</option>)}
            </ThemedSelect>
          </div>
        </div>
      </FormSection>

      {/* ── Ex-Service (replaces the removed Licences & Compliance tab) ───── */}
      <FormSection
        label={HR_SECTIONS[3].label}
        open={isOpen("exservice")}
        onToggle={() => toggleSection("exservice")}
      >
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={form.is_ex_serviceman}
              onChange={(e) => setForm({ ...form, is_ex_serviceman: e.target.checked })} />
            <span>Ex-serviceman</span>
          </label>
          {form.is_ex_serviceman ? (
            <>
              {txt("army_number", "Army Number")}
              {txt("service_unit", "Unit")}
              {txt("service_rank", "Rank")}
              {txt("service_trade", "Trade")}
              {txt("service_join_date", "Join Date", { type: "date" })}
              {txt("service_discharge_date", "Discharge Date", { type: "date" })}
              {txt("discharging_officer", "Discharging Officer")}
            </>
          ) : (
            <p className="col-span-2 text-xs text-slate-500">Tick “Ex-serviceman” to record army service details.</p>
          )}
        </div>
      </FormSection>

      {/* ── Experience ───────────────────────────────────────────────────── */}
      <FormSection
        label={HR_SECTIONS[4].label}
        open={isOpen("experience")}
        onToggle={() => toggleSection("experience")}
      >
        <div className="grid grid-cols-2 gap-3">{area("weapons_trained", "Weapons Trained On")}</div>
      </FormSection>

      {/* ── Internal Office Data (+ folded Licences & Compliance) ─────────── */}
      <FormSection
        label={HR_SECTIONS[5].label}
        open={isOpen("office")}
        onToggle={() => toggleSection("office")}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {txt("interview_date", "Interview Date", { type: "date" })}
            {txt("form_serial_no", "Form Serial No.")}
            {txt("designation", "Designation")}
            {txt("project", "Project")}
            {txt("company_id_card_number", "Company ID Card No.")}
            <div>
              <label className="block text-sm text-slate-700 mb-1">Social Security Status</label>
              <ThemedSelect value={form.social_security_status}
                onChange={(e) => setForm({ ...form, social_security_status: e.target.value as "" | SocialSecurityStatus })} className={inputCls}>
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

          <div className="pt-3 border-t border-slate-100">
            <h5 className="text-sm text-slate-900 mb-3">Recruitment</h5>
            <div className="grid grid-cols-2 gap-3">
              {txt("referral_source", "Referral Source", { placeholder: "e.g. Walk-in, Advert, Referral" })}
              {txt("referred_by_name", "Referred By")}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100">
            <h5 className="text-sm text-slate-900 mb-1">Licences & Compliance</h5>
            <p className="text-xs text-slate-500 mb-3">Expiry dates feed the Compliance Calendar.</p>
            <div className="grid grid-cols-2 gap-3">
              {txt("weapon_licence_number", "Weapon Licence #")}
              {txt("weapon_licence_expiry", "Weapon Licence Expiry", { type: "date" })}
              {txt("guard_service_licence_number", "Guard Service Licence #")}
              {txt("guard_service_licence_expiry", "Guard Service Licence Expiry", { type: "date" })}
              {txt("medical_fitness_expiry", "Medical Fitness Expiry", { type: "date" })}
              {txt("eobi_registration_number", "EOBI Registration #", { placeholder: "Once issued" })}
            </div>
          </div>

        </div>
      </FormSection>
      </div>
    </div>
  );
}

/**
 * Open/close state for a modal's collapsible sections — the optional ones. The
 * panels that are filled on every save render permanently open instead and never
 * pass through here.
 */
function useSectionState() {
  const [open, setOpen] = useState<string[]>([]);
  const isOpen = useCallback((id: string) => open.includes(id), [open]);
  const toggle = useCallback(
    (id: string) => setOpen((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
    [],
  );
  const reset = useCallback(() => setOpen([]), []);
  return { isOpen, toggle, reset };
}

/**
 * "Physical copies on file" — the flag that drives the red/green completeness
 * state on the roster. Sits beside Verify identity in the edit form: both are
 * "is this record trustworthy yet?" questions, answered at the same moment.
 */
function PhysicalCopyToggle({
  checked, onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center gap-2 text-sm rounded-md border px-3 py-2 cursor-pointer ${
        checked
          ? "bg-success-50 border-success-200 text-success-800"
          : "bg-danger-50 border-danger-200 text-danger-800"
      }`}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Physical Copy Present
        <span className="block text-xs opacity-80">
          {checked ? "Profile marked complete." : "Profile is incomplete until the physical copies are on file."}
        </span>
      </span>
    </label>
  );
}

/** One collapsible panel in the Add / Edit Employee form. Collapsed by default. */
function FormSection({
  label, open, hasError, onToggle, collapsible = true, children,
}: {
  label: string;
  open?: boolean;
  hasError?: boolean;
  onToggle?: () => void;
  /** false = always shown, with no way to fold it away. */
  collapsible?: boolean;
  children: React.ReactNode;
}) {
  const errorTag = hasError ? (
    <span className="text-[10px] font-semibold uppercase tracking-wide text-danger-700 dark:text-danger-500 bg-danger-50 border border-danger-200 px-1.5 py-0.5 rounded-md">
      Needs attention
    </span>
  ) : null;

  // Sections you fill in on every save aren't worth a click to reach, and a
  // collapse control on them is just something to fight with.
  if (!collapsible) {
    return (
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5 text-sm bg-accent/60 text-foreground font-medium">
          <span className="flex-1">{label}</span>
          {errorTag}
        </div>
        <div className="px-3 pb-4 pt-3 border-t border-border">{children}</div>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left transition-colors ${
          open ? "bg-accent/60 text-foreground font-medium" : "text-slate-700 hover:bg-accent/40"
        }`}
      >
        <ChevronRightIcon
          className={`w-4 h-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          strokeWidth={1.75}
        />
        <span className="flex-1">{label}</span>
        {errorTag}
      </button>
      {open && <div className="px-3 pb-4 pt-3 border-t border-border">{children}</div>}
    </div>
  );
}
