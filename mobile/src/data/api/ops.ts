// Operations writes: incidents and client complaints (web Incidents.tsx,
// ClientComplaints.tsx), same payloads and order.
import { driveDelete, driveUpload, PickedFile, q, sb, todayIso } from "./core";

export type IncidentForm = {
  occurred_at: string; client_id: string; post_id: string; severity: string; category: string; description: string;
  client_notified: boolean; client_notified_at: string; action_taken: string; status: string; guard_ids: string[];
};

const payload = (f: IncidentForm) => ({
  occurred_at: new Date(f.occurred_at).toISOString(),
  client_id: f.client_id || null,
  post_id: f.post_id || null,
  severity: f.severity,
  category: f.category,
  description: f.description.trim() || null,
  client_notified: f.client_notified,
  client_notified_at: f.client_notified && f.client_notified_at ? f.client_notified_at : null,
  action_taken: f.action_taken.trim() || null,
  status: f.status,
});

/** syncGuards(): wipe the junction rows, re-insert. */
async function syncGuards(incidentId: string, guardIds: string[]) {
  await q(sb().from("incident_guards").delete().eq("incident_id", incidentId));
  if (guardIds.length) await q(sb().from("incident_guards").insert(guardIds.map((eid) => ({ incident_id: incidentId, employee_id: eid })) as never));
}

async function attach(incidentId: string, code: string, file: PickedFile, company: { id: string; name: string }, previousDriveId?: string | null) {
  if (!company.id || !company.name) throw new Error("Company not loaded — refresh and try again.");
  const up = await driveUpload(file, { category: "incidents", company_id: company.id, company_name: company.name, entity_id: incidentId, entity_code: code, entity_name: code });
  if (previousDriveId) await driveDelete(previousDriveId);
  await q(sb().from("incidents").update({ drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url, attachment_file_name: up.file_name ?? file.name } as never).eq("id", incidentId));
}

/** handleAdd() / handleEdit(). */
export async function saveIncident(existing: { id: string; code: string; raw?: any } | null, f: IncidentForm, file: PickedFile | null, company: { id: string; name: string }) {
  if (!f.client_id) throw new Error("Pick a client.");
  if (existing) {
    await q(sb().from("incidents").update(payload(f) as never).eq("id", existing.id));
    await syncGuards(existing.id, f.guard_ids);
    if (file) await attach(existing.id, existing.code, file, company, existing.raw?.drive_file_id);
    return;
  }
  const inserted = await q<any>(sb().from("incidents").insert(payload(f) as never).select().single());
  await syncGuards(inserted.id, f.guard_ids);
  if (file) await attach(inserted.id, inserted.incident_code, file, company);
}

/** handleDelete(): Drive file first, then the row (guard links cascade). */
export async function deleteIncident(i: { id: string; raw?: any }) {
  if (i.raw?.drive_file_id) await driveDelete(i.raw.drive_file_id);
  await q(sb().from("incidents").delete().eq("id", i.id));
}

export const COMPLAINT_STATUS = ["open", "in_progress", "resolved", "closed"] as const;
export const COMPLAINT_CHANNELS = ["phone", "email", "in_person", "letter"] as const;

export async function addComplaint(companyId: string, clientId: string, channel: string, description: string) {
  if (!clientId || !description.trim()) throw new Error("Pick a client and describe the complaint.");
  await q(sb().from("client_complaints").insert({ company_id: companyId, client_id: clientId, raised_on: todayIso(), channel, description, status: "open" } as never));
}

export async function setComplaintStatus(id: string, status: string) {
  await q(sb().from("client_complaints").update({ status, resolved_on: status === "resolved" || status === "closed" ? todayIso() : null } as never).eq("id", id));
}
