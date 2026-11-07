import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useRegion, withRegion } from "../lib/region";
import { guardDisplayCode } from "../lib/guardCode";
import { generateStaffReportPdf, type StaffRecord } from "../lib/staffReportPdf";

/**
 * "Staff report" (6 Nov 2026) — the Daily / Attendance report's companion for
 * the Employees and Assignments & Pay pages: every active employee, client by
 * client, with what is missing and what needs attention. Reads; writes nothing.
 * Follows the region chosen in the top bar.
 */
export default function StaffReportButton({ size = "md" }: { size?: "sm" | "md" }) {
  const { company, profile } = useAuth();
  const { regionId, region } = useRegion();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const cols = "id, full_name, employee_code, guard_code, display_number, client_id, category, designation, join_date, phone, cnic_number, cnic_expiry, date_of_birth, emergency_contact_phone, bank_account, iban, cash_payment_flag, police_verification_status, nadra_verisys_status, guard_service_licence_expiry, weapon_licence_expiry, medical_fitness_expiry, weapons_cert_expiry, probation_end_date, pending_termination_review, client:client_id(name, employee_id_prefix)";
      const all: any[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await withRegion(
          supabase.from("employees").select(cols).eq("lifecycle_state", "active").order("full_name").range(from, from + 999),
          regionId,
        );
        if (error) throw error;
        all.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      const ids = all.map((e) => e.id);
      const docs = new Map<string, Record<string, boolean>>();
      for (let i = 0; i < ids.length; i += 300) {
        const { data, error } = await supabase.from("guard_documents").select("employee_id, doc_type, status").in("employee_id", ids.slice(i, i + 300));
        if (error) throw error;
        for (const d of (data ?? []) as { employee_id: string; doc_type: string; status: string }[]) {
          const m = docs.get(d.employee_id) ?? {};
          m[d.doc_type] = d.status === "on_file";
          docs.set(d.employee_id, m);
        }
      }
      const records: StaffRecord[] = all.map((e) => ({
        id: e.id,
        name: e.full_name ?? "",
        code: guardDisplayCode(e, e.client?.employee_id_prefix ?? null),
        group: e.category === "office_staff" ? "Office staff" : e.category === "reliever" ? "Relievers" : e.client?.name ?? "Not posted",
        designation: e.designation ?? null,
        joinDate: e.join_date ?? null,
        phone: e.phone || null,
        cnic: e.cnic_number || null,
        cnicExpiry: e.cnic_expiry ?? null,
        dob: e.date_of_birth ?? null,
        emergencyPhone: e.emergency_contact_phone || null,
        hasBank: !!(e.bank_account || e.iban),
        cashPaid: !!e.cash_payment_flag,
        policeVerification: e.police_verification_status ?? null,
        nadraVerisys: e.nadra_verisys_status ?? null,
        guardLicenceExpiry: e.guard_service_licence_expiry ?? null,
        weaponLicenceExpiry: e.weapon_licence_expiry ?? null,
        medicalExpiry: e.medical_fitness_expiry ?? null,
        weaponsCertExpiry: e.weapons_cert_expiry ?? null,
        probationEnd: e.probation_end_date ?? null,
        pendingTerminationReview: !!e.pending_termination_review,
        docs: docs.get(e.id) ?? null,
      }));

      // Contracted guards per client (active contracts' committed lines, else their guard count).
      const clientIds = [...new Set(all.map((e) => e.client_id).filter(Boolean))] as string[];
      const contracted = new Map<string, number>();
      if (clientIds.length) {
        const { data } = await supabase.from("contracts")
          .select("client_id, status, end_date, termination_date, number_of_guards, contract_lines(committed_count), contract_addendums(change_type, count_delta, effective_from), client:client_id(name)")
          .in("client_id", clientIds).eq("status", "active");
        const today = new Date().toISOString().slice(0, 10);
        for (const c of (data ?? []) as any[]) {
          if ((c.end_date && c.end_date < today) || (c.termination_date && c.termination_date < today)) continue;
          const lines = (c.contract_lines ?? []).reduce((t: number, l: any) => t + Number(l.committed_count ?? 0), 0);
          // Headcount addendums in force today count too (7 Nov 2026).
          const delta = (c.contract_addendums ?? []).filter((a: any) => a.effective_from <= today)
            .reduce((t: number, a: any) => t + (a.change_type === "ADD_HEADCOUNT" ? Number(a.count_delta ?? 0) : a.change_type === "REDUCE_HEADCOUNT" ? -Number(a.count_delta ?? 0) : 0), 0);
          const n = (lines > 0 ? lines : Number(c.number_of_guards ?? 0)) + delta;
          const name = c.client?.name;
          if (name && n) contracted.set(name, (contracted.get(name) ?? 0) + n);
        }
      }

      generateStaffReportPdf({
        company, records, contracted,
        regionLabel: region && !region.is_head_office ? region.name : null,
        extractedBy: profile?.full_name ?? "",
      });
    } catch (e: any) {
      setErr(e?.message ? friendlyDbError(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-end">
      <Button variant="secondary" size={size} onClick={() => void run()} disabled={busy} title="Client-wise staff report: what is missing and what needs attention (PDF)">
        {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" strokeWidth={1.5} />}
        Staff report
      </Button>
      {err && <span className="text-xs text-danger-600 mt-1 max-w-xs text-right">{err}</span>}
    </span>
  );
}
