import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Upload, AlertCircle, Loader2, X, Trash2, ChevronDown, ChevronRight as ChevronRightIcon } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import {
  supabase,
  EMPLOYEE_DOCS_BUCKET,
  BLOOD_GROUPS,
  EMERGENCY_CONTACT_RELATIONS,
  type Employee,
  type EmployeeDocument,
  type Location,
  type Client,
  type Branch,
  type EmployeeCategory,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type EmployeeRow = Employee & {
  location_name: string | null;
  client_name: string | null;
  branch_name: string | null;
  additional_branch_ids: string[];
  doc_count: number;
};
type DocumentWithUrl = EmployeeDocument & { publicUrl: string | null };

type FormState = {
  full_name: string;
  phone: string;
  location_id: string;
  client_id: string;
  branch_id: string;
  additional_branch_ids: string[];
  category: EmployeeCategory;
  department: string;
  shift: "day" | "night";
  base_salary: string;
  per_day_salary: string;
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
  cnic?: File;
  police_verification?: File;
  other?: FileList;
};

const emptyForm: FormState = {
  full_name: "",
  phone: "",
  location_id: "",
  client_id: "",
  branch_id: "",
  additional_branch_ids: [],
  category: "client",
  department: "",
  shift: "day",
  base_salary: "",
  per_day_salary: "",
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
};


const daysInCurrentMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
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
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | EmployeeCategory>("all");
  const [shiftFilter, setShiftFilter] = useState<"all" | "day" | "night">("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeRow | null>(null);
  const [selectedDocs, setSelectedDocs] = useState<DocumentWithUrl[]>([]);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const [editForm, setEditForm] = useState<FormState>(emptyForm);
  const [editStatus, setEditStatus] = useState<EmployeeRow["status"]>("Active");
  const [editing, setEditing] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    const [locRes, cliRes, brRes, empRes, docRes, ebRes] = await Promise.all([
      supabase.from("locations").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
      supabase
        .from("employees")
        .select("*, location:location_id(name), client:client_id(name), branch:branch_id(name)")
        .order("created_at", { ascending: false }),
      supabase.from("employee_documents").select("employee_id"),
      supabase.from("employee_branches").select("employee_id, branch_id"),
    ]);
    if (locRes.error) setError(locRes.error.message);
    if (cliRes.error) setError(cliRes.error.message);
    if (brRes.error) setError(brRes.error.message);
    if (empRes.error) setError(empRes.error.message);
    if (docRes.error) setError(docRes.error.message);
    setLocations(locRes.data ?? []);
    setClients(cliRes.data ?? []);
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

  useEffect(() => {
    loadData();
  }, []);

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
      branch_id: primary,
      additional_branch_ids: additional,
    });
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
        const inPrimary = e.branch_id === branchFilter;
        const inAdditional = (e.additional_branch_ids ?? []).includes(branchFilter);
        if (!inPrimary && !inAdditional) return false;
      }
      if (categoryFilter !== "all" && (e.category ?? "client") !== categoryFilter) return false;
      if (shiftFilter !== "all" && e.shift !== shiftFilter) return false;
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      return true;
    });
  }, [employees, search, locationFilter, clientFilter, branchFilter, categoryFilter, shiftFilter, statusFilter]);

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

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.full_name.trim()) return;
    if (form.category === "client" && !form.client_id) {
      setError("Select a client (or change category to Office Staff / Reliever).");
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
          branch_id: form.branch_id || null,
          category: form.category,
          department: form.department.trim() || null,
          shift: form.shift,
          base_salary: form.base_salary ? Number(form.base_salary) : null,
          per_day_salary: form.per_day_salary ? Number(form.per_day_salary) : null,
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
        })
        .select()
        .single();
      if (insErr) throw insErr;
      const newEmp = data as Employee;
      await uploadDocs(
        { id: newEmp.id, employee_code: newEmp.employee_code, full_name: newEmp.full_name },
        form,
      );
      await syncAdditionalBranches(newEmp.id, form.additional_branch_ids, form.branch_id);
      setForm(emptyForm);
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
    setIsViewModalOpen(true);
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

  const openEdit = (emp: EmployeeRow) => {
    setSelectedEmployee(emp);
    setEditStatus(emp.status);
    const baseStr = emp.base_salary != null ? String(emp.base_salary) : "";
    setEditForm({
      full_name: emp.full_name,
      phone: emp.phone ?? "",
      location_id: emp.location_id ?? "",
      client_id: emp.client_id ?? "",
      branch_id: emp.branch_id ?? "",
      additional_branch_ids: [...(emp.additional_branch_ids ?? [])],
      category: (emp.category ?? "client") as EmployeeCategory,
      department: emp.department ?? "",
      shift: emp.shift,
      base_salary: baseStr,
      per_day_salary: computePerDay(baseStr),
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
    });
    setIsEditModalOpen(true);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmployee) return;
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
          branch_id: editForm.branch_id || null,
          category: editForm.category,
          department: editForm.department.trim() || null,
          shift: editForm.shift,
          status: editStatus,
          base_salary: editForm.base_salary ? Number(editForm.base_salary) : null,
          per_day_salary: editForm.per_day_salary ? Number(editForm.per_day_salary) : null,
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
        })
        .eq("id", selectedEmployee.id);
      if (upErr) throw upErr;
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
            <div className="flex items-center gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, phone, or employee ID..."
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <select
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
              </select>
              <ClientFilterSelect
                clients={clients}
                value={clientFilter}
                onChange={setClientFilter}
                allValue="all"
              />
              <select
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
              </select>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as "all" | EmployeeCategory)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Categories</option>
                <option value="client">Client</option>
                <option value="office_staff">Office Staff</option>
                <option value="reliever">Reliever</option>
              </select>
              <select
                value={shiftFilter}
                onChange={(e) => setShiftFilter(e.target.value as "all" | "day" | "night")}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Shifts</option>
                <option value="day">Day</option>
                <option value="night">Night</option>
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Status</option>
                <option value="Active">Active</option>
                <option value="On Leave">On Leave</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Employee ID</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Name</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Phone</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Branch</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Client / Category</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Shift</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
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
                    const noDocs = (employee.doc_count ?? 0) === 0;
                    return (
                    <tr
                      key={employee.id}
                      className={`transition-colors ${noDocs ? "bg-danger-50 hover:bg-danger-100" : "hover:bg-slate-50"}`}
                      title={noDocs ? "No documents uploaded for this employee" : undefined}
                    >
                      <td className="px-6 py-4 text-sm font-mono">
                        <span className={noDocs ? "text-danger-700" : "text-slate-600"}>{employee.employee_code}</span>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-900">
                        <div className="flex items-center gap-2">
                          {employee.full_name}
                          {noDocs && (
                            <span className="inline-flex items-center text-[10px] uppercase tracking-wider text-danger-700 bg-danger-100 px-1.5 py-0.5 rounded">
                              <AlertCircle className="w-3 h-3 mr-0.5" strokeWidth={2} />
                              No docs
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{employee.phone ?? "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{employee.location_name ?? "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{employee.branch_name ?? "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {(employee.category ?? "client") === "client" ? (
                          employee.client_name ?? "—"
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-700 capitalize">
                            {(employee.category ?? "client").replace("_", " ")}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs capitalize ${
                            employee.shift === "day"
                              ? "bg-warning-50 text-warning-700"
                              : "bg-indigo-50 text-indigo-700"
                          }`}
                        >
                          {employee.shift}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                            employee.status === "Active"
                              ? "bg-success-50 text-success-700"
                              : employee.status === "On Leave"
                              ? "bg-warning-50 text-warning-700"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {employee.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => openView(employee)}>
                          View
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(employee)}>
                          Edit
                        </Button>
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
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="Enter full name"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Phone Number</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="+92 300 1234567"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Location</label>
                <select
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
                </select>
                {locations.length === 0 && (
                  <p className="text-xs text-slate-500 mt-1">
                    No locations yet. Add them from Settings → Location Management.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Primary Branch</label>
                <select
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
                </select>
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
                <select
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
                </select>
              </div>
              {form.category === "client" && (
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Client *</label>
                  <select
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
                  </select>
                  {clientsForBranch(form.branch_id).length === 0 && (
                    <p className="text-xs text-slate-500 mt-1">
                      {form.branch_id
                        ? "No clients in this branch yet."
                        : "No clients yet. Add them from Settings → Client Management."}
                    </p>
                  )}
                </div>
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
                  {(["day", "night"] as const).map((s) => (
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
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  placeholder="e.g., PK36SCBL0000001123456702"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-sm text-slate-700 mb-1">IBAN (24 chars)</label>
                <input
                  type="text"
                  maxLength={24}
                  value={form.iban}
                  onChange={(e) => setForm({ ...form, iban: e.target.value.toUpperCase().replace(/\s+/g, "") })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono"
                  placeholder="PKxx XXXX XXXX XXXX XXXX XXXX"
                />
                {form.iban && form.iban.length !== 24 && (
                  <p className="text-xs text-warning-700 mt-1">
                    Pakistani IBANs are 24 characters (currently {form.iban.length}).
                  </p>
                )}
              </div>
            </div>
          </div>

          <EmployeeHrSection form={form} setForm={setForm} employees={employees} />

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
                  <p className="text-slate-500 mb-1">Join Date</p>
                  <p className="text-slate-900">{selectedEmployee.join_date ?? "—"}</p>
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
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        title="Edit Employee"
        size="lg"
      >
        {selectedEmployee && (
          <form className="space-y-6" onSubmit={handleEdit}>
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
                    value={editForm.full_name}
                    onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Phone Number</label>
                  <input
                    type="tel"
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Location</label>
                  <select
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
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Primary Branch</label>
                  <select
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
                  </select>
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
                  <select
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
                  </select>
                </div>
                {editForm.category === "client" && (
                  <div>
                    <label className="block text-sm text-slate-700 mb-1">Client</label>
                    <select
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
                    </select>
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
                  <select
                    value={editForm.shift}
                    onChange={(e) =>
                      setEditForm({ ...editForm, shift: e.target.value as "day" | "night" })
                    }
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  >
                    <option value="day">Day</option>
                    <option value="night">Night</option>
                  </select>
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
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                    placeholder="e.g., PK36SCBL0000001123456702"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Status</label>
                  <select
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value as EmployeeRow["status"])}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  >
                    <option value="Active">Active</option>
                    <option value="On Leave">On Leave</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-sm text-slate-700 mb-1">IBAN (24 chars)</label>
                  <input
                    type="text"
                    maxLength={24}
                    value={editForm.iban}
                    onChange={(e) => setEditForm({ ...editForm, iban: e.target.value.toUpperCase().replace(/\s+/g, "") })}
                    className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono"
                    placeholder="PKxx XXXX XXXX XXXX XXXX XXXX"
                  />
                </div>
              </div>
            </div>

            <EmployeeHrSection form={editForm} setForm={setEditForm} employees={employees} excludeEmployeeId={selectedEmployee?.id} />

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
    </>
  );
}

function formatCnicInline(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 13);
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

// Collapsible HR/compliance fields appended to both Add and Edit employee
// forms. Spec section 3.3 + Appendix A.1.
function EmployeeHrSection({
  form,
  setForm,
  employees,
  excludeEmployeeId,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  employees: EmployeeRow[];
  excludeEmployeeId?: string;
}) {
  const [openPersonal, setOpenPersonal] = useState(false);
  const [openEmergency, setOpenEmergency] = useState(false);
  const [openEmployment, setOpenEmployment] = useState(false);
  const [openLicences, setOpenLicences] = useState(false);

  const supervisorOptions = useMemo(
    () => employees.filter((e) => e.id !== excludeEmployeeId && e.status === "Active"),
    [employees, excludeEmployeeId],
  );

  const SectionHeader = ({
    open,
    onClick,
    title,
    hint,
  }: {
    open: boolean;
    onClick: () => void;
    title: string;
    hint?: string;
  }) => (
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
                value={form.cnic_number}
                onChange={(e) => setForm({ ...form, cnic_number: formatCnicInline(e.target.value) })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm font-mono"
                placeholder="XXXXX-XXXXXXX-X"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Date of Birth</label>
              <input
                type="date"
                value={form.date_of_birth}
                onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Father / Husband Name</label>
              <input
                type="text"
                value={form.father_or_husband_name}
                onChange={(e) => setForm({ ...form, father_or_husband_name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="As per CNIC"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Blood Group</label>
              <select
                value={form.blood_group}
                onChange={(e) => setForm({ ...form, blood_group: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">—</option>
                {BLOOD_GROUPS.map((bg) => (
                  <option key={bg} value={bg}>{bg}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Permanent Address</label>
              <textarea
                rows={2}
                value={form.permanent_address}
                onChange={(e) => setForm({ ...form, permanent_address: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Current Address</label>
              <textarea
                rows={2}
                value={form.current_address}
                onChange={(e) => setForm({ ...form, current_address: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="Leave blank to default to permanent address"
              />
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
              <select
                value={form.emergency_contact_relation}
                onChange={(e) => setForm({ ...form, emergency_contact_relation: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">—</option>
                {EMERGENCY_CONTACT_RELATIONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Phone</label>
              <input
                type="tel"
                value={form.emergency_contact_phone}
                onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="+92 …"
              />
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
              <select
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
              </select>
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
              <select
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
              </select>
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
