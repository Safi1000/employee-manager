// The catalogue the employee export picker renders, and the only place a
// column's label, width and value live together.
//
// Before this file the export was fourteen hard-coded parallel arrays —
// `headers`, `rows.map`, `columnWidths` — three lists that had to agree by
// position and nothing that made them. Adding a column meant editing three
// places and counting; a picker that hides columns would have meant slicing
// three lists in step. One record per field removes the counting: pick the
// fields, and the header, the cell and the width travel together.
//
// A field is here ONLY if it is on the `Employee` TS type. The employees table
// carries a dozen more columns (home_contact_number, unit_type, separation_reason,
// the appraisal and probation pairs) that the type does not declare, and the page
// selects `*` so they are present at runtime. They are deliberately left out:
// offering a checkbox for a field the type does not know about buys an untyped
// cast per field and a silent blank column the day one is renamed.

import type { Employee } from "./supabase";
import { LIFECYCLE_STATE_LABEL } from "./supabase";
import { formatDate } from "./date";

export type EmployeeExportRow = Employee & {
  location_name: string | null;
  client_name: string | null;
  branch_name: string | null;
};

// The three values the page derives rather than reads. They need the clients
// list or a label map the catalogue has no business holding, so the page passes
// them in and the fields that want them stay declarative like the rest.
export type EmployeeExportContext = {
  /** Client-prefixed display code, e.g. AWT-008. */
  displayCode: (e: EmployeeExportRow) => string;
  /** Client name for a client-posted guard, else the category, e.g. "head office". */
  clientOrCategory: (e: EmployeeExportRow) => string;
  /** The lifecycle label the table's Status column shows. */
  statusLabel: (e: EmployeeExportRow) => string;
};

export type EmployeeExportField = {
  id: string;
  label: string;
  group: string;
  width: number;
  value: (e: EmployeeExportRow, ctx: EmployeeExportContext) => string | number;
};

/** CNIC as 00000-0000000-0. Also used by the employee table and detail view —
 *  one definition, because two would eventually disagree about the dashes. */
export function formatCnicInline(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 13);
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

// A spreadsheet cell wants an empty cell, not an em dash: `formatDate` renders
// "—" for null because a screen reads better with a placeholder, and a column
// of em dashes cannot be sorted, filtered or summed.
const date = (v: string | null | undefined): string => (v ? formatDate(v) : "");
const text = (v: string | null | undefined): string => v ?? "";
// Salary and measurement columns stay NUMERIC so Excel can total them. An empty
// string for null rather than 0 — a guard with no recorded salary has not been
// paid nothing, and a 0 would sum as though they had.
const num = (v: number | null | undefined): string | number => (v == null ? "" : Number(v));
const yesNo = (v: boolean | null | undefined): string => (v == null ? "" : v ? "Yes" : "No");
const titled = (v: string | null | undefined): string =>
  v ? v.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()) : "";

const G = {
  identity: "Identity",
  contact: "Contact & address",
  kin: "Family & emergency",
  posting: "Posting",
  employment: "Employment",
  pay: "Pay",
  bank: "Bank",
  compliance: "Vetting & compliance",
  service: "Ex-service & skills",
  kit: "Physical & kit",
  admin: "Form & admin",
} as const;

export const EMPLOYEE_EXPORT_FIELDS: EmployeeExportField[] = [
  // ---- Identity ----
  { id: "display_code", label: "Employee ID", group: G.identity, width: 14, value: (e, c) => c.displayCode(e) },
  { id: "permanent_code", label: "Permanent Code", group: G.identity, width: 14, value: (e) => e.guard_code ?? e.employee_code },
  { id: "legacy_code", label: "Legacy Code", group: G.identity, width: 14, value: (e) => text(e.legacy_code) },
  { id: "full_name", label: "Name", group: G.identity, width: 24, value: (e) => e.full_name },
  { id: "father_or_husband_name", label: "Father / Husband", group: G.identity, width: 24, value: (e) => text(e.father_or_husband_name) },
  { id: "cnic_number", label: "CNIC", group: G.identity, width: 18, value: (e) => (e.cnic_number ? formatCnicInline(e.cnic_number) : "") },
  { id: "cnic_expiry", label: "CNIC Expiry", group: G.identity, width: 14, value: (e) => date(e.cnic_expiry) },
  { id: "date_of_birth", label: "Date of Birth", group: G.identity, width: 14, value: (e) => date(e.date_of_birth) },
  { id: "marital_status", label: "Marital Status", group: G.identity, width: 14, value: (e) => titled(e.marital_status) },
  { id: "blood_group", label: "Blood Group", group: G.identity, width: 12, value: (e) => text(e.blood_group) },
  { id: "education", label: "Education", group: G.identity, width: 20, value: (e) => text(e.education) },
  { id: "company_id_card_number", label: "Company ID Card", group: G.identity, width: 18, value: (e) => text(e.company_id_card_number) },

  // ---- Contact & address ----
  { id: "phone", label: "Phone", group: G.contact, width: 16, value: (e) => text(e.phone) },
  { id: "secondary_phone", label: "Secondary Phone", group: G.contact, width: 16, value: (e) => text(e.secondary_phone) },
  { id: "permanent_address", label: "Permanent Address", group: G.contact, width: 36, value: (e) => text(e.permanent_address) },
  { id: "current_address", label: "Current Address", group: G.contact, width: 36, value: (e) => text(e.current_address) },
  { id: "preferred_location", label: "Preferred Location", group: G.contact, width: 20, value: (e) => text(e.preferred_location) },
  { id: "post_office", label: "Post Office", group: G.contact, width: 18, value: (e) => text(e.post_office) },
  { id: "police_station", label: "Police Station", group: G.contact, width: 18, value: (e) => text(e.police_station) },
  { id: "union_council", label: "Union Council", group: G.contact, width: 18, value: (e) => text(e.union_council) },
  { id: "area_nazim", label: "Area Nazim", group: G.contact, width: 18, value: (e) => text(e.area_nazim) },

  // ---- Family & emergency ----
  { id: "emergency_contact_name", label: "Emergency Contact", group: G.kin, width: 22, value: (e) => text(e.emergency_contact_name) },
  { id: "emergency_contact_relation", label: "Emergency Relation", group: G.kin, width: 16, value: (e) => text(e.emergency_contact_relation) },
  { id: "emergency_contact_phone", label: "Emergency Phone", group: G.kin, width: 16, value: (e) => text(e.emergency_contact_phone) },
  { id: "emergency_contact2_name", label: "Emergency Contact 2", group: G.kin, width: 22, value: (e) => text(e.emergency_contact2_name) },
  { id: "emergency_contact2_relation", label: "Emergency Relation 2", group: G.kin, width: 16, value: (e) => text(e.emergency_contact2_relation) },
  { id: "emergency_contact2_phone", label: "Emergency Phone 2", group: G.kin, width: 16, value: (e) => text(e.emergency_contact2_phone) },
  { id: "spouse_name", label: "Spouse", group: G.kin, width: 22, value: (e) => text(e.spouse_name) },
  { id: "next_of_kin_name", label: "Next of Kin", group: G.kin, width: 22, value: (e) => text(e.next_of_kin_name) },
  { id: "next_of_kin_relation", label: "Next of Kin Relation", group: G.kin, width: 16, value: (e) => text(e.next_of_kin_relation) },
  { id: "next_of_kin_cnic", label: "Next of Kin CNIC", group: G.kin, width: 18, value: (e) => (e.next_of_kin_cnic ? formatCnicInline(e.next_of_kin_cnic) : "") },
  { id: "next_of_kin_contact", label: "Next of Kin Phone", group: G.kin, width: 16, value: (e) => text(e.next_of_kin_contact) },

  // ---- Posting ----
  { id: "location_name", label: "Location", group: G.posting, width: 18, value: (e) => text(e.location_name) },
  { id: "branch_name", label: "Branch", group: G.posting, width: 18, value: (e) => text(e.branch_name) },
  { id: "client_or_category", label: "Client / Category", group: G.posting, width: 20, value: (e, c) => c.clientOrCategory(e) },
  { id: "client_name", label: "Client", group: G.posting, width: 20, value: (e) => text(e.client_name) },
  { id: "category", label: "Category", group: G.posting, width: 16, value: (e) => titled(e.category) },
  { id: "department", label: "Department", group: G.posting, width: 18, value: (e) => text(e.department) },
  { id: "designation", label: "Designation", group: G.posting, width: 18, value: (e) => text(e.designation) },
  { id: "project", label: "Project", group: G.posting, width: 18, value: (e) => text(e.project) },
  { id: "shift", label: "Shift", group: G.posting, width: 8, value: (e) => e.shift },
  { id: "assignment_effective_from", label: "Posted From", group: G.posting, width: 14, value: (e) => date(e.assignment_effective_from) },
  { id: "assignment_effective_to", label: "Posted To", group: G.posting, width: 14, value: (e) => date(e.assignment_effective_to) },

  // ---- Employment ----
  { id: "status", label: "Status", group: G.employment, width: 12, value: (e, c) => c.statusLabel(e) },
  { id: "lifecycle_state", label: "Lifecycle State", group: G.employment, width: 16, value: (e) => LIFECYCLE_STATE_LABEL[e.lifecycle_state] ?? titled(e.lifecycle_state) },
  { id: "record_state", label: "Approval State", group: G.employment, width: 16, value: (e) => titled(e.record_state) },
  { id: "employee_contract_type", label: "Contract Type", group: G.employment, width: 16, value: (e) => titled(e.employee_contract_type) },
  { id: "join_date", label: "Join Date", group: G.employment, width: 14, value: (e) => date(e.join_date) },
  { id: "probation_end_date", label: "Probation Ends", group: G.employment, width: 14, value: (e) => date(e.probation_end_date) },
  { id: "last_working_day", label: "Last Working Day", group: G.employment, width: 16, value: (e) => date(e.last_working_day) },
  { id: "termination_date", label: "Termination Date", group: G.employment, width: 16, value: (e) => date(e.termination_date) },
  { id: "exit_date", label: "Exit Date", group: G.employment, width: 14, value: (e) => date(e.exit_date) },
  { id: "exit_reason", label: "Exit Reason", group: G.employment, width: 26, value: (e) => text(e.exit_reason) },
  { id: "eligible_for_rehire", label: "Eligible for Rehire", group: G.employment, width: 16, value: (e) => yesNo(e.eligible_for_rehire) },
  { id: "rehire_count", label: "Rehire Count", group: G.employment, width: 12, value: (e) => num(e.rehire_count) },
  { id: "blacklisted", label: "Blacklisted", group: G.employment, width: 12, value: (e) => yesNo(e.blacklisted) },
  { id: "blacklist_reason", label: "Blacklist Reason", group: G.employment, width: 26, value: (e) => text(e.blacklist_reason) },

  // ---- Pay ----
  { id: "base_salary", label: "Base Salary", group: G.pay, width: 14, value: (e) => num(e.base_salary) },
  { id: "allowance", label: "Allowance", group: G.pay, width: 14, value: (e) => num(e.allowance) },
  { id: "per_day_salary", label: "Per Day Salary", group: G.pay, width: 14, value: (e) => num(e.per_day_salary) },
  { id: "opening_leaves", label: "Opening Leaves", group: G.pay, width: 14, value: (e) => num(e.opening_leaves) },
  { id: "opening_leaves_month", label: "Opening Leaves From", group: G.pay, width: 18, value: (e) => date(e.opening_leaves_month) },

  // ---- Bank ----
  { id: "bank_name", label: "Bank", group: G.bank, width: 18, value: (e) => text(e.bank_name) },
  { id: "account_title", label: "Account Title", group: G.bank, width: 22, value: (e) => text(e.account_title) },
  { id: "bank_account", label: "Account No.", group: G.bank, width: 22, value: (e) => text(e.bank_account) },
  { id: "bank_branch_code", label: "Branch Code", group: G.bank, width: 14, value: (e) => text(e.bank_branch_code) },
  { id: "iban", label: "IBAN", group: G.bank, width: 28, value: (e) => text(e.iban) },

  // ---- Vetting & compliance ----
  { id: "eobi_registration_number", label: "EOBI Number", group: G.compliance, width: 18, value: (e) => text(e.eobi_registration_number) },
  { id: "social_security_status", label: "Social Security", group: G.compliance, width: 16, value: (e) => titled(e.social_security_status) },
  { id: "social_security_number", label: "Social Security No.", group: G.compliance, width: 18, value: (e) => text(e.social_security_number) },
  { id: "insurance_provider", label: "Insurance Provider", group: G.compliance, width: 20, value: (e) => text(e.insurance_provider) },
  { id: "insurance_number", label: "Insurance Number", group: G.compliance, width: 18, value: (e) => text(e.insurance_number) },
  { id: "weapon_licence_number", label: "Weapon Licence", group: G.compliance, width: 18, value: (e) => text(e.weapon_licence_number) },
  { id: "weapon_licence_expiry", label: "Weapon Licence Expiry", group: G.compliance, width: 18, value: (e) => date(e.weapon_licence_expiry) },
  { id: "guard_service_licence_number", label: "Guard Licence", group: G.compliance, width: 18, value: (e) => text(e.guard_service_licence_number) },
  { id: "guard_service_licence_expiry", label: "Guard Licence Expiry", group: G.compliance, width: 18, value: (e) => date(e.guard_service_licence_expiry) },
  { id: "medical_fitness_expiry", label: "Medical Fitness Expiry", group: G.compliance, width: 18, value: (e) => date(e.medical_fitness_expiry) },
  { id: "police_verification_status", label: "Police Verification", group: G.compliance, width: 16, value: (e) => titled(e.police_verification_status) },
  { id: "police_verification_date", label: "Police Verified On", group: G.compliance, width: 16, value: (e) => date(e.police_verification_date) },
  { id: "nadra_verisys_status", label: "NADRA Verisys", group: G.compliance, width: 16, value: (e) => titled(e.nadra_verisys_status) },
  { id: "nadra_verisys_date", label: "Verisys Date", group: G.compliance, width: 14, value: (e) => date(e.nadra_verisys_date) },
  { id: "orientation_done", label: "Orientation Done", group: G.compliance, width: 14, value: (e) => yesNo(e.orientation_done) },
  { id: "orientation_date", label: "Orientation Date", group: G.compliance, width: 14, value: (e) => date(e.orientation_date) },
  { id: "weapons_certified", label: "Weapons Certified", group: G.compliance, width: 14, value: (e) => yesNo(e.weapons_certified) },
  { id: "weapons_cert_expiry", label: "Weapons Cert Expiry", group: G.compliance, width: 18, value: (e) => date(e.weapons_cert_expiry) },
  { id: "refresher_due_date", label: "Refresher Due", group: G.compliance, width: 14, value: (e) => date(e.refresher_due_date) },
  { id: "identity_verified", label: "Identity Verified", group: G.compliance, width: 14, value: (e) => yesNo(e.identity_verified) },
  { id: "physical_copy_present", label: "Physical File", group: G.compliance, width: 14, value: (e) => yesNo(e.physical_copy_present) },

  // ---- Ex-service & skills ----
  { id: "is_ex_serviceman", label: "Ex-serviceman", group: G.service, width: 14, value: (e) => yesNo(e.is_ex_serviceman) },
  { id: "army_number", label: "Army Number", group: G.service, width: 16, value: (e) => text(e.army_number) },
  { id: "service_unit", label: "Unit", group: G.service, width: 16, value: (e) => text(e.service_unit) },
  { id: "service_rank", label: "Rank", group: G.service, width: 14, value: (e) => text(e.service_rank) },
  { id: "service_trade", label: "Trade", group: G.service, width: 14, value: (e) => text(e.service_trade) },
  { id: "service_join_date", label: "Service Joined", group: G.service, width: 14, value: (e) => date(e.service_join_date) },
  { id: "service_discharge_date", label: "Service Discharged", group: G.service, width: 16, value: (e) => date(e.service_discharge_date) },
  { id: "discharging_officer", label: "Discharging Officer", group: G.service, width: 20, value: (e) => text(e.discharging_officer) },
  { id: "weapons_trained", label: "Weapons Trained", group: G.service, width: 22, value: (e) => text(e.weapons_trained) },
  { id: "special_skills", label: "Special Skills", group: G.service, width: 22, value: (e) => text(e.special_skills) },

  // ---- Physical & kit ----
  { id: "height_cm", label: "Height (cm)", group: G.kit, width: 12, value: (e) => num(e.height_cm) },
  { id: "weight_kg", label: "Weight (kg)", group: G.kit, width: 12, value: (e) => num(e.weight_kg) },
  { id: "build", label: "Build", group: G.kit, width: 12, value: (e) => text(e.build) },
  { id: "uniform_size", label: "Uniform Size", group: G.kit, width: 12, value: (e) => text(e.uniform_size) },
  { id: "shoe_size", label: "Shoe Size", group: G.kit, width: 12, value: (e) => text(e.shoe_size) },

  // ---- Form & admin ----
  { id: "interview_date", label: "Interview Date", group: G.admin, width: 14, value: (e) => date(e.interview_date) },
  { id: "form_serial_no", label: "Form Serial", group: G.admin, width: 14, value: (e) => text(e.form_serial_no) },
  { id: "form_signed_on", label: "Form Signed On", group: G.admin, width: 14, value: (e) => date(e.form_signed_on) },
  { id: "referral_source", label: "Referral Source", group: G.admin, width: 18, value: (e) => text(e.referral_source) },
  { id: "referred_by_name", label: "Referred By", group: G.admin, width: 20, value: (e) => text(e.referred_by_name) },
  { id: "remarks", label: "Remarks", group: G.admin, width: 32, value: (e) => text(e.remarks) },
];

// The fourteen columns the export produced before it could be chosen, in their
// original order. They are the default tick so an export nobody customises is
// byte-for-byte the sheet this screen has always produced.
export const EMPLOYEE_EXPORT_DEFAULT_FIELD_IDS = [
  "display_code",
  "permanent_code",
  "full_name",
  "cnic_number",
  "phone",
  "location_name",
  "branch_name",
  "client_or_category",
  "shift",
  "status",
  "bank_name",
  "account_title",
  "bank_account",
  "iban",
];

/** Group order for the picker, derived from the catalogue so a new field in a
 *  new group appears without a second list to update. */
export const EMPLOYEE_EXPORT_GROUPS = (): { group: string; fields: EmployeeExportField[] }[] => {
  const out: { group: string; fields: EmployeeExportField[] }[] = [];
  for (const f of EMPLOYEE_EXPORT_FIELDS) {
    const last = out.find((g) => g.group === f.group);
    if (last) last.fields.push(f);
    else out.push({ group: f.group, fields: [f] });
  }
  return out;
};
