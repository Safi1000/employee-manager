import jsPDF from "jspdf";
import { formatDate } from "./date";
import {
  CHECKLIST_DOC_LABEL,
  type Employee,
  type EmployeeChild,
  type EmployeeReference,
  type EmployeePreviousJob,
  type EmployeeDocumentChecklistItem,
} from "./supabase";

// §11 — branded 2-page reproduction of the paper Employee Data Form, with the
// fingerprint grid and four approval signature blocks. Built with jsPDF, the
// same engine used for payslips/invoices, so no new dependency.

const MARGIN = 14;
const PAGE_W = 210; // A4 portrait mm
const CONTENT_W = PAGE_W - MARGIN * 2;

type FormData = {
  employee: Employee;
  companyName: string;
  children: EmployeeChild[];
  references: EmployeeReference[];
  jobs: EmployeePreviousJob[];
  checklist: EmployeeDocumentChecklistItem[];
};

export function generateEmployeeFormPdf(data: FormData) {
  const { employee: e, companyName, children, references, jobs, checklist } = data;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  const dash = (v: unknown) =>
    v === null || v === undefined || v === "" ? "—" : String(v);

  const sectionTitle = (title: string) => {
    if (y > 265) {
      doc.addPage();
      y = MARGIN;
    }
    doc.setFillColor(241, 245, 249);
    doc.rect(MARGIN, y, CONTENT_W, 6, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.text(title.toUpperCase(), MARGIN + 2, y + 4);
    y += 9;
  };

  // Two-column label:value grid. Each entry occupies half the content width.
  const grid = (rows: [string, unknown][]) => {
    const colW = CONTENT_W / 2;
    doc.setFontSize(8.5);
    for (let i = 0; i < rows.length; i += 2) {
      if (y > 280) {
        doc.addPage();
        y = MARGIN;
      }
      for (let c = 0; c < 2; c++) {
        const row = rows[i + c];
        if (!row) continue;
        const x = MARGIN + c * colW;
        doc.setFont("helvetica", "bold");
        doc.setTextColor(100, 116, 139);
        doc.text(`${row[0]}:`, x, y);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(15, 23, 42);
        const label = doc.getTextWidth(`${row[0]}: `);
        doc.text(doc.splitTextToSize(dash(row[1]), colW - label - 4), x + label, y);
      }
      y += 6;
    }
    y += 2;
  };

  // ---- Header ----
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(companyName, MARGIN, y + 4);
  doc.setFontSize(11);
  doc.setTextColor(71, 85, 105);
  doc.text("Employee Data Form", MARGIN, y + 10);
  // Photo box (top-right)
  doc.setDrawColor(203, 213, 225);
  doc.rect(PAGE_W - MARGIN - 28, y, 28, 34);
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text("PHOTO", PAGE_W - MARGIN - 20, y + 18);
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text(`Employee ID: ${dash(e.employee_code)}`, MARGIN, y + 16);
  doc.text(`Form Serial: ${dash(e.form_serial_no)}`, MARGIN, y + 21);
  doc.text(`Interview Date: ${e.interview_date ? formatDate(e.interview_date) : "—"}`, MARGIN, y + 26);
  y += 40;

  // ---- Personal ----
  sectionTitle("Personal");
  grid([
    ["Full Name", e.full_name],
    ["Father / Husband", e.father_or_husband_name],
    ["CNIC", e.cnic_number],
    ["CNIC Expiry", e.cnic_expiry ? formatDate(e.cnic_expiry) : "—"],
    ["Date of Birth", e.date_of_birth ? formatDate(e.date_of_birth) : "—"],
    ["Marital Status", e.marital_status],
    ["Blood Group", e.blood_group],
    ["Education", e.education],
    ["Height (cm)", e.height_cm],
    ["Weight (kg)", e.weight_kg],
    ["Build", e.build],
    ["Uniform Size", e.uniform_size],
    ["Shoe Size", e.shoe_size],
    ["Special Skills", e.special_skills],
  ]);

  // ---- Contact ----
  sectionTitle("Contact");
  grid([
    ["Phone", e.phone],
    ["Current Address", e.current_address],
    ["Permanent Address", e.permanent_address],
    ["Emergency 1", `${dash(e.emergency_contact_name)} (${dash(e.emergency_contact_relation)}) ${dash(e.emergency_contact_phone)}`],
    ["Emergency 2", `${dash(e.emergency_contact2_name)} (${dash(e.emergency_contact2_relation)}) ${dash(e.emergency_contact2_phone)}`],
  ]);

  // ---- Political / Locality ----
  sectionTitle("Political / Locality");
  grid([
    ["Post Office", e.post_office],
    ["Police Station", e.police_station],
    ["Area Nazim", e.area_nazim],
    ["Union Council", e.union_council],
  ]);

  // ---- Family ----
  sectionTitle("Family");
  grid([
    ["Spouse", e.spouse_name],
    ["Next of Kin", `${dash(e.next_of_kin_name)} (${dash(e.next_of_kin_relation)})`],
    ["NoK CNIC", e.next_of_kin_cnic],
    ["NoK Contact", e.next_of_kin_contact],
  ]);
  if (children.length > 0) {
    grid(children.map((c, i) => [`Child ${i + 1}`, `${c.name}${c.date_of_birth ? ` · ${formatDate(c.date_of_birth)}` : ""}${c.gender ? ` · ${c.gender}` : ""}`]));
  }

  // ---- Page 2 ----
  doc.addPage();
  y = MARGIN;

  // ---- Ex-service ----
  sectionTitle("Ex-Service");
  if (e.is_ex_serviceman) {
    grid([
      ["Army No.", e.army_number],
      ["Unit", e.service_unit],
      ["Rank", e.service_rank],
      ["Trade", e.service_trade],
      ["Join Date", e.service_join_date ? formatDate(e.service_join_date) : "—"],
      ["Discharge Date", e.service_discharge_date ? formatDate(e.service_discharge_date) : "—"],
      ["Discharging Officer", e.discharging_officer],
    ]);
  } else {
    grid([["Ex-serviceman", "No"]]);
  }

  // ---- Experience ----
  sectionTitle("Experience");
  grid([["Weapons Trained", e.weapons_trained]]);
  jobs
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .forEach((j) =>
      grid([
        [`Job ${j.seq} — Employer`, j.employer],
        ["Designation", j.designation],
        ["From", j.from_date ? formatDate(j.from_date) : "—"],
        ["To", j.to_date ? formatDate(j.to_date) : "—"],
        ["Reason for Leaving", j.reason_for_leaving],
      ]),
    );

  // ---- References ----
  sectionTitle("References");
  references.forEach((r) =>
    grid([
      [r.reference_type === "uc_gazetted" ? "UC / Gazetted" : "Blood Relation", r.name],
      ["CNIC", r.cnic],
      ["Contact", r.contact],
      ["Address", r.address],
    ]),
  );

  // ---- Internal office data ----
  sectionTitle("Internal Office Data");
  grid([
    ["Designation", e.designation],
    ["Project", e.project],
    ["Company ID Card", e.company_id_card_number],
    ["Social Security", e.social_security_status],
    ["Social Security No.", e.social_security_number],
    ["Insurance Provider", e.insurance_provider],
    ["Insurance No.", e.insurance_number],
    ["Remarks", e.remarks],
  ]);

  // ---- Documents checklist ----
  sectionTitle("Documents Checklist");
  doc.setFontSize(8.5);
  const colW = CONTENT_W / 2;
  checklist.forEach((item, i) => {
    if (y > 280) {
      doc.addPage();
      y = MARGIN;
    }
    const x = MARGIN + (i % 2) * colW;
    doc.setDrawColor(148, 163, 184);
    doc.rect(x, y - 3, 3.5, 3.5);
    if (item.received) {
      doc.setFont("helvetica", "bold");
      doc.text("X", x + 0.6, y - 0.3);
    }
    doc.setFont("helvetica", "normal");
    doc.setTextColor(15, 23, 42);
    doc.text(CHECKLIST_DOC_LABEL[item.doc_type], x + 6, y);
    if (i % 2 === 1) y += 6;
  });
  if (checklist.length % 2 === 1) y += 6;
  y += 4;

  // ---- Fingerprint grid ----
  sectionTitle("Fingerprints");
  const fingers = ["Thumb", "Index", "Middle", "Ring", "Little"];
  const boxW = CONTENT_W / 5;
  const drawHand = (label: string) => {
    if (y > 250) {
      doc.addPage();
      y = MARGIN;
    }
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(71, 85, 105);
    doc.text(label, MARGIN, y);
    y += 2;
    doc.setDrawColor(203, 213, 225);
    for (let i = 0; i < 5; i++) {
      const x = MARGIN + i * boxW;
      doc.rect(x, y, boxW - 2, 18);
      doc.setFontSize(6.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(148, 163, 184);
      doc.text(fingers[i], x + 1, y + 20.5);
    }
    y += 24;
  };
  drawHand("Left Hand");
  drawHand("Right Hand");

  // ---- Signature blocks (4) ----
  if (y > 250) {
    doc.addPage();
    y = MARGIN;
  }
  sectionTitle("Approvals");
  const sigLabels = ["Employee", "HR Officer", "Operations", "Approving Authority"];
  const sigW = CONTENT_W / 2;
  for (let i = 0; i < 4; i++) {
    const col = i % 2;
    const x = MARGIN + col * sigW;
    if (col === 0 && i > 0) y += 22;
    doc.setDrawColor(148, 163, 184);
    doc.line(x, y + 14, x + sigW - 8, y + 14);
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    doc.text(`${sigLabels[i]} — Signature & Date`, x, y + 18);
  }
  y += 22;

  // Footer note
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text(
    `Form signed on: ${e.form_signed_on ? formatDate(e.form_signed_on) : "____________"}   ·   Generated ${formatDate(new Date().toISOString().slice(0, 10))}`,
    MARGIN,
    288,
  );

  doc.save(`employee-form-${e.employee_code || e.id}.pdf`);
}
