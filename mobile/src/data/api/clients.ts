// Clients and contracts. Ports of web Clients.tsx (buildPayload / handleAdd /
// handleEdit / handleDelete), ContractEditorModal.tsx (save_contract, addendums,
// document), ContractRenewModal.tsx (renew_contract), ContractCyclesModal.tsx
// and Contracts.tsx (delete).
import { driveDelete, driveUpload, PickedFile, q, rpc, sb } from "./core";
import {
  CONTRACT_LINE_CATEGORY_LABEL, contractLinesCommitted, isPersonnelCategory, type ContractLineCategory, type RemitAccount, type TaxLine,
} from "../../lib/web/supabase";
import {
  hasInjectionPattern, validateBankAccount, validateCnic, validateEmail, validateEmployeeIdPrefix, validateFreeText, validateIban,
  validateNtn, validatePhone, validateStrn,
} from "../../lib/web/validation";

// ---------------------------------------------------------------- clients
export type ClientForm = {
  name: string; email: string; phone: string; industry: string; ntn: string; strn: string; filer_status: string;
  tax_profile: TaxLine[]; remit_accounts: RemitAccount[]; billing_type: string; invoice_group: string; branch_id: string;
  billing_address: string; authorised_signatory: string; signatory_cnic: string; employee_id_prefix: string;
  relationship_notes: string; relationship_rating: string;
};

export function clientFormFrom(row: any | null): ClientForm {
  const r = row ?? {};
  return {
    name: r.name ?? "", email: r.email ?? "", phone: r.phone ?? "", industry: r.industry ?? "", ntn: r.ntn ?? "", strn: r.strn ?? "",
    filer_status: r.filer_status ?? "", tax_profile: Array.isArray(r.tax_profile) ? r.tax_profile : [],
    remit_accounts: Array.isArray(r.remit_accounts) ? r.remit_accounts : [], billing_type: r.billing_type ?? "STANDARD",
    invoice_group: r.invoice_group ?? "FIXED", branch_id: r.branch_id ?? "", billing_address: r.billing_address ?? "",
    authorised_signatory: r.authorised_signatory ?? "", signatory_cnic: r.signatory_cnic ?? "", employee_id_prefix: r.employee_id_prefix ?? "",
    relationship_notes: r.relationship_notes ?? "", relationship_rating: r.relationship_rating ? String(r.relationship_rating) : "",
  };
}

const sanitizeTaxProfile = (rows: TaxLine[]): TaxLine[] =>
  rows.filter((t) => t.name.trim() !== "").map((t) => ({
    name: t.name.trim(), rate: Math.max(0, Number(t.rate) || 0), base: t.base, direction: t.direction,
    ...(t.component ? { component: t.component.trim() } : {}),
  }));

/** Drop empty remit rows; exactly one default when any exist (first wins). */
const sanitizeRemitAccounts = (rows: RemitAccount[]): RemitAccount[] => {
  const cleaned = rows.filter((r) => r.account_title.trim() !== "" || r.account_number.trim() !== "").map((r) => ({
    account_title: r.account_title.trim(), account_number: r.account_number.trim(), bank_name: r.bank_name.trim(), is_default: !!r.is_default,
  }));
  if (cleaned.length && !cleaned.some((r) => r.is_default)) cleaned[0]!.is_default = true;
  let seen = false;
  for (const r of cleaned) { if (r.is_default) { if (seen) r.is_default = false; seen = true; } }
  return cleaned;
};

const firstWithheldRate = (rows: TaxLine[]): number | null => {
  const w = rows.find((t) => t.direction === "WITHHELD" && Number(t.rate) > 0);
  return w ? Number(w.rate) : null;
};

const clientPayload = (f: ClientForm) => ({
  name: f.name.trim(), email: f.email.trim() || null, phone: f.phone.trim() || null, industry: f.industry || null,
  ntn: f.ntn.trim() || null, strn: f.strn.trim() || null, filer_status: f.filer_status || null,
  tax_profile: sanitizeTaxProfile(f.tax_profile), remit_accounts: sanitizeRemitAccounts(f.remit_accounts),
  billing_type: f.billing_type, invoice_group: f.invoice_group, withholding_tax_rate: firstWithheldRate(f.tax_profile),
  branch_id: f.branch_id || null, billing_address: f.billing_address.trim() || null, authorised_signatory: f.authorised_signatory.trim() || null,
  signatory_cnic: f.signatory_cnic.trim() || null, employee_id_prefix: f.employee_id_prefix.trim().toUpperCase() || null,
  relationship_notes: f.relationship_notes.trim() || null, relationship_rating: f.relationship_rating ? Number(f.relationship_rating) : null,
});

/** computeClientErrors() + the prefix clash check. Returns field → message. */
export function clientErrors(f: ClientForm, others: { id: string; name: string; raw?: any }[], selfId: string | null) {
  const remitErr = (v: string) => (!v || !v.trim() ? null : validateBankAccount(v) === null || validateIban(v) === null ? null : "Enter a valid account number or IBAN");
  const errs: Record<string, string | null> = {
    name: f.name.trim() ? validateFreeText(f.name) : "Name is required.",
    email: validateEmail(f.email), phone: validatePhone(f.phone), ntn: validateNtn(f.ntn), strn: validateStrn(f.strn),
    signatory_cnic: validateCnic(f.signatory_cnic), billing_address: validateFreeText(f.billing_address),
    authorised_signatory: validateFreeText(f.authorised_signatory),
    employee_id_prefix: f.employee_id_prefix.trim() === "" ? "Client prefix is required." : validateEmployeeIdPrefix(f.employee_id_prefix),
    industry: f.industry.trim() === "" ? "Industry is required." : null,
  };
  f.remit_accounts.forEach((r, i) => { errs[`remit-${i}`] = remitErr(r.account_number); });
  const prefix = f.employee_id_prefix.trim().toUpperCase();
  const clash = prefix ? others.find((o) => o.id !== selfId && String(o.raw?.employee_id_prefix ?? "").toUpperCase() === prefix) : undefined;
  if (clash) errs.employee_id_prefix = `Prefix "${prefix}" is already used by ${clash.name}`;
  return Object.fromEntries(Object.entries(errs).filter(([, v]) => v)) as Record<string, string>;
}

export async function saveClient(id: string | null, f: ClientForm) {
  if (id) await q(sb().from("clients").update(clientPayload(f) as never).eq("id", id));
  else await q(sb().from("clients").insert(clientPayload(f) as never));
}

/** handleDelete(): refused while active employees are assigned. */
export async function deleteClient(id: string, name: string, activeEmployees: number) {
  if (activeEmployees > 0) throw new Error(`Cannot delete ${name}: ${activeEmployees} active employee(s) are assigned. Reassign them first.`);
  await q(sb().from("clients").delete().eq("id", id));
}

// ---------------------------------------------------------------- contracts
export type ContractFormState = {
  client_id: string; contract_type: "guard_deployment" | "services"; start_date: string; end_date: string; is_infinite: boolean;
  notice_period_days: string; allowed_leaves_per_month: string; eobi_deduction: boolean; eobi_amount: string;
  annual_escalation_pct: string; renewal_terms: string; status: "active" | "expired" | "terminated" | "draft"; termination_date: string;
};
export type LineDraft = {
  id?: string; site_key: string; shift_code: string; category: ContractLineCategory; label: string; location: string;
  committed_count: string; unit_rate: string; taxable: boolean;
};
export type SiteDraft = { key: string; id?: string; name: string; location: string; is_default: boolean };

export const NO_SITE = "";
let siteSeq = 0;
export const nextSiteKey = () => `site-${++siteSeq}`;
const num = (s: string) => Number(s) || 0;
export const isMeaningful = (l: LineDraft) => num(l.committed_count) > 0 || num(l.unit_rate) > 0;

export const blankContractForm = (clientId: string): ContractFormState => ({
  client_id: clientId, contract_type: "guard_deployment", start_date: new Date().toISOString().slice(0, 10), end_date: "", is_infinite: false,
  notice_period_days: "", allowed_leaves_per_month: "", eobi_deduction: false, eobi_amount: "", annual_escalation_pct: "",
  renewal_terms: "", status: "active", termination_date: "",
});

export const blankLine = (category: ContractLineCategory, siteKey = NO_SITE): LineDraft => ({
  site_key: siteKey, shift_code: isPersonnelCategory(category) ? "day" : "", category, label: CONTRACT_LINE_CATEGORY_LABEL[category],
  location: "", committed_count: "0", unit_rate: "0", taxable: true,
});

/** The editor's load: the client's sites, the contract's lines and addendums, split-by-site derived from the lines. */
export async function loadContractEditor(contract: any | null, clientId: string) {
  const siteRows = clientId ? await q<any[]>(sb().from("sites").select("*").eq("client_id", clientId).order("name")) : [];
  const sites: SiteDraft[] = siteRows.map((r) => ({ key: nextSiteKey(), id: r.id, name: r.name, location: r.location ?? "", is_default: !!r.is_default }));
  const keyById = new Map(sites.map((d) => [d.id!, d.key]));
  const form: ContractFormState = contract ? {
    client_id: contract.client_id, contract_type: contract.contract_type, start_date: contract.start_date, end_date: contract.end_date ?? "",
    is_infinite: !!contract.is_infinite, notice_period_days: contract.notice_period_days != null ? String(contract.notice_period_days) : "",
    allowed_leaves_per_month: contract.allowed_leaves_per_month != null ? String(contract.allowed_leaves_per_month) : "",
    eobi_deduction: !!contract.eobi_deduction, eobi_amount: contract.eobi_amount != null ? String(contract.eobi_amount) : "",
    annual_escalation_pct: contract.annual_escalation_pct != null ? String(contract.annual_escalation_pct) : "",
    renewal_terms: contract.renewal_terms ?? "", status: contract.status, termination_date: contract.termination_date ?? "",
  } : blankContractForm(clientId);
  let lines: LineDraft[] = [];
  let hasSites = false;
  let addendums: any[] = [];
  if (contract) {
    const rows = await q<any[]>(sb().from("contract_lines").select("*").eq("contract_id", contract.id).order("created_at", { ascending: true }));
    lines = rows.length ? rows.map((l) => ({
      id: l.id, site_key: l.site_id ? keyById.get(l.site_id) ?? NO_SITE : NO_SITE,
      shift_code: l.shift_code ?? (isPersonnelCategory(l.category) ? "day" : ""), category: l.category,
      label: l.label ?? CONTRACT_LINE_CATEGORY_LABEL[l.category as ContractLineCategory], location: l.location ?? "",
      committed_count: String(l.committed_count), unit_rate: String(l.unit_rate), taxable: !!l.taxable,
    })) : [blankLine(form.contract_type === "services" ? "WEAPON" : "SR_SUPERVISOR")];
    hasSites = form.contract_type !== "services" && rows.some((l) => !!l.site_id);
    if (hasSites && sites.length) lines = lines.map((l) => (l.site_key === NO_SITE ? { ...l, site_key: sites[0]!.key } : l));
    addendums = await q<any[]>(sb().from("contract_addendums").select("*").eq("contract_id", contract.id).order("effective_from", { ascending: false }));
  } else {
    lines = [blankLine("SR_SUPERVISOR")];
  }
  return { form, sites, lines, hasSites, loadedSiteIds: siteRows.map((r) => r.id as string), addendums };
}

/** handleSubmit() checks, then persistContract(): ONE save_contract call, then the document. */
export async function saveContract(args: {
  contractId: string | null; form: ContractFormState; lines: LineDraft[]; sites: SiteDraft[]; hasSites: boolean; loadedSiteIds: string[];
  file: PickedFile | null; existingDriveFileId: string | null; company: { id: string; name: string };
}) {
  const { form, lines, sites, hasSites } = args;
  if (!form.client_id) throw new Error("Select a client.");
  if (form.status === "terminated" && !form.termination_date) throw new Error("A termination date is required when the contract status is Terminated.");
  if (hasInjectionPattern(form.renewal_terms)) throw new Error("Special characters are not allowed in Renewal Terms.");
  if (lines.some((l) => hasInjectionPattern(l.label) || hasInjectionPattern(l.location))) throw new Error("Special characters are not allowed in contract line label/notes.");
  if (hasSites) {
    if (sites.some((x) => hasInjectionPattern(x.name) || hasInjectionPattern(x.location))) throw new Error("Special characters are not allowed in a site name or location.");
    if (sites.some((x) => !x.name.trim() && lines.some((l) => l.site_key === x.key && isMeaningful(l)))) throw new Error("Name every site — a site with no name cannot be saved, and its lines would be lost.");
    if (lines.some((l) => l.site_key === NO_SITE && isMeaningful(l))) throw new Error("Every contract line must sit under a site while “Split by site” is Yes.");
  }
  const shiftTotals: Record<string, number> = { day: 0, evening: 0, night: 0 };
  for (const l of lines) {
    if (!isPersonnelCategory(l.category) || !l.shift_code) continue;
    shiftTotals[l.shift_code] = (shiftTotals[l.shift_code] ?? 0) + Math.max(0, Math.floor(num(l.committed_count)));
  }
  const totalCommitted = contractLinesCommitted(lines.map((l) => ({ committed_count: num(l.committed_count) })));
  const guard = lines.find((l) => l.category === "GUARD" && isMeaningful(l)) ?? lines.find((l) => isMeaningful(l));
  const contractPayload = {
    client_id: form.client_id, contract_type: form.contract_type, start_date: form.start_date,
    end_date: form.is_infinite ? null : form.end_date || null, is_infinite: form.is_infinite,
    notice_period_days: form.is_infinite && form.notice_period_days !== "" ? Math.max(1, Math.floor(num(form.notice_period_days))) : null,
    number_of_guards: totalCommitted, day_guards: shiftTotals.day, night_guards: shiftTotals.night, evening_guards: shiftTotals.evening,
    rate_per_guard_per_month: num(guard?.unit_rate ?? "0"),
    allowed_leaves_per_month: form.allowed_leaves_per_month === "" ? null : Math.max(0, Math.floor(num(form.allowed_leaves_per_month))),
    eobi_deduction: form.eobi_deduction, eobi_amount: form.eobi_deduction && form.eobi_amount !== "" ? Number(form.eobi_amount) : null,
    annual_escalation_pct: form.annual_escalation_pct === "" ? null : Number(form.annual_escalation_pct),
    renewal_terms: form.renewal_terms.trim() || null, status: form.status,
    termination_date: form.status === "terminated" ? form.termination_date || null : null,
  };
  const namedSites = hasSites ? sites.filter((x) => x.name.trim()).map((x) => ({ key: x.key, id: x.id ?? null, name: x.name.trim(), location: x.location.trim(), is_default: x.is_default })) : [];
  const namedKeys = new Set(namedSites.map((x) => x.key));
  const kept = new Set(namedSites.map((x) => x.id).filter(Boolean) as string[]);
  const removedSiteIds = hasSites ? args.loadedSiteIds.filter((id) => !kept.has(id)) : [];
  const payloadLines = lines.filter((l) => isMeaningful(l) && (!hasSites || namedKeys.has(l.site_key))).map((l) => ({
    id: l.id ?? null, site_key: hasSites ? l.site_key : NO_SITE, shift_code: isPersonnelCategory(l.category) ? l.shift_code || "" : "",
    category: l.category, label: l.label.trim() || CONTRACT_LINE_CATEGORY_LABEL[l.category], location: l.location.trim(),
    committed_count: Math.max(0, Math.floor(num(l.committed_count))), unit_rate: Math.max(0, num(l.unit_rate)), taxable: l.taxable,
  }));
  const saved = await rpc<{ contract_id: string; contract_code: string }>("save_contract", {
    p_contract_id: args.contractId, p_client_id: form.client_id, p_contract: contractPayload, p_use_sites: hasSites,
    p_sites: namedSites, p_removed_site_ids: removedSiteIds, p_lines: payloadLines,
  });
  if (args.file) {
    try {
      await uploadContractDocument(saved.contract_id, saved.contract_code, args.file, args.existingDriveFileId, args.company);
    } catch (e) {
      throw new Error(`${saved.contract_code} was saved, but the document upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return saved;
}

/** How many contracts this client already has — the editor asks before a second one. */
export async function contractCount(clientId: string) {
  const { count, error } = await sb().from("contracts").select("id", { count: "exact", head: true }).eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function uploadContractDocument(contractId: string, code: string, file: PickedFile, existingDriveFileId: string | null, company: { id: string; name: string }) {
  if (!company.id || !company.name) throw new Error("Company not loaded — refresh and try again.");
  const up = await driveUpload(file, { category: "contracts", company_id: company.id, company_name: company.name, entity_id: contractId, entity_code: code, entity_name: code });
  if (existingDriveFileId) await driveDelete(existingDriveFileId);
  await q(sb().from("contracts").update({ drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url, contract_file_name: up.file_name ?? file.name } as never).eq("id", contractId));
}

export type AddendumForm = {
  site_key: string; category: ContractLineCategory; change_type: "ADD_HEADCOUNT" | "REDUCE_HEADCOUNT" | "RATE_CHANGE" | "EXTEND_END_DATE";
  count_delta: string; new_rate: string; new_end_date: string; new_is_infinite: boolean; effective_from: string; line_id: string;
  line_rate: string; line_notes: string; line_taxable: boolean; source: string; reference: string;
};
export const blankAddendum = (): AddendumForm => ({
  site_key: NO_SITE, category: "GUARD", change_type: "ADD_HEADCOUNT", count_delta: "1", new_rate: "", new_end_date: "", new_is_infinite: false,
  effective_from: "", line_id: "", line_rate: "", line_notes: "", line_taxable: true, source: "SIGNED_CONTRACT", reference: "",
});

/** handleAddAddendum(): every addendum is a dated change; add-headcount carries its own line fields. */
export async function addAddendum(contract: { id: string; contract_code: string }, f: AddendumForm, siteId: string | null, line: LineDraft | undefined, file: PickedFile | null, company: { id: string; name: string }) {
  const isRenewal = f.change_type === "EXTEND_END_DATE";
  const isRate = f.change_type === "RATE_CHANGE";
  const isAdd = f.change_type === "ADD_HEADCOUNT";
  const count = Math.floor(num(f.count_delta));
  if (hasInjectionPattern(f.reference) || hasInjectionPattern(f.line_notes)) throw new Error("Special characters are not allowed in the addendum notes or reference.");
  if (!f.effective_from) throw new Error("Pick the date this addendum takes effect.");
  if (isRenewal && !f.new_is_infinite && !f.new_end_date) throw new Error("Set a new end date for the renewal, or tick “no end date”.");
  if (!isRenewal && !isRate && !(count > 0)) throw new Error("Enter the headcount — at least 1.");
  if (isAdd && !(num(f.line_rate) > 0)) throw new Error("Enter the rate / month.");
  if (isRate && !(num(f.new_rate) > 0)) throw new Error("Enter the new rate / month.");
  if ((isRate || f.change_type === "REDUCE_HEADCOUNT") && !line) throw new Error("Pick which line this changes.");
  const ins = await q<any>(sb().from("contract_addendums").insert({
    contract_id: contract.id, contract_line_id: line?.id ?? null, category: isAdd ? f.category : null, site_id: isAdd ? siteId : null,
    unit_rate: isAdd ? num(f.line_rate) : null, taxable: isAdd ? f.line_taxable : null, notes: isAdd ? f.line_notes.trim() || null : null,
    change_type: f.change_type, count_delta: isRate || isRenewal ? 0 : count, new_rate: isRate ? num(f.new_rate) : null,
    new_end_date: isRenewal && !f.new_is_infinite ? f.new_end_date : null, new_is_infinite: isRenewal ? f.new_is_infinite : false,
    effective_from: f.effective_from, shift_code: null, source: f.source, reference: f.reference.trim() || null,
  } as never).select().single());
  if (file) {
    const up = await driveUpload(file, { category: "contracts", company_id: company.id, company_name: company.name, entity_id: contract.id, entity_code: contract.contract_code, entity_name: contract.contract_code });
    await q(sb().from("contract_addendums").update({ drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url, reference_file_name: up.file_name ?? file.name } as never).eq("id", ins.id));
  }
}

/** ContractRenewModal submit(). Default window: day after the current end, for one year. */
export function renewalDefaults(endDate: string | null) {
  const base = endDate ? new Date(`${endDate}T00:00:00Z`) : new Date();
  if (endDate) base.setUTCDate(base.getUTCDate() + 1);
  const start = base.toISOString().slice(0, 10);
  const end = new Date(base);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return { start, end: end.toISOString().slice(0, 10) };
}
export async function renewContract(id: string, start: string, end: string, infinite: boolean) {
  if (!start) throw new Error("Pick the date the renewed contract starts.");
  if (!infinite && !end) throw new Error("Pick the date the renewed contract ends, or tick “no end date”.");
  if (!infinite && end < start) throw new Error("The end date can't be before the start date.");
  await rpc("renew_contract", { p_contract_id: id, p_start_date: start, p_end_date: infinite ? null : end, p_is_infinite: infinite });
}

/** deleteContract(): lines/addendums go with it; a renewal-pipeline reference refuses. */
export async function deleteContract(id: string) {
  const { error } = await sb().from("contracts").delete().eq("id", id);
  if (error) throw new Error(/renewal_pipeline|foreign key|violates/i.test(error.message) ? "This contract is referenced by the renewal pipeline — remove it there first." : error.message);
}

// ---------- cycles ----------
export async function loadCycles(contractId: string) {
  const [e, pb, pp] = await Promise.all([
    q<any[]>(sb().from("contract_cycle_events").select("*").eq("contract_id", contractId).order("effective_from")),
    rpc<any[]>("contract_periods", { p_contract_id: contractId, p_kind: "billing" }),
    rpc<any[]>("contract_periods", { p_contract_id: contractId, p_kind: "payroll" }),
  ]);
  return { events: e, billing: pb ?? [], payroll: pp ?? [] };
}
export async function addCycleEvent(contractId: string, kind: "billing" | "payroll", effectiveFrom: string, anchorDay: string, note: string) {
  if (!effectiveFrom) throw new Error("Pick the date the new cycle starts.");
  await q(sb().from("contract_cycle_events").insert({ contract_id: contractId, cycle_kind: kind, effective_from: effectiveFrom, anchor_day: Number(anchorDay), note: note.trim() || null } as never));
}
export const deleteCycleEvent = (id: string) => q(sb().from("contract_cycle_events").delete().eq("id", id));
