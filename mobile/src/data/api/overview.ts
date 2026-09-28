// Tasks and the personal checklist (web Tasks.tsx, PersonalChecklist.tsx).
import { q, sb } from "./core";

export type TaskForm = { title: string; description: string; status: string; priority: string; assignee_id: string; due_date: string };

/** handleCreate(): tasks.company_id is NOT NULL with no fill trigger, so the caller supplies it. */
export async function createTask(companyId: string | null, f: TaskForm) {
  if (!f.title.trim()) throw new Error("Task title is required.");
  if (!companyId) throw new Error("No company is selected, so there is nowhere to file this task.");
  await q(sb().from("tasks").insert({
    company_id: companyId, title: f.title.trim(), description: f.description.trim() || null, status: f.status, priority: f.priority,
    assignee_id: f.assignee_id || null, due_date: f.due_date || null,
  } as never));
}

/** handleEditSave(): a non-admin sends STATUS AND NOTHING ELSE (0418 guards the rest). */
export async function updateTask(id: string, f: TaskForm, isAdmin: boolean) {
  if (!f.title.trim()) throw new Error("Task title is required.");
  const patch = isAdmin
    ? { title: f.title.trim(), description: f.description.trim() || null, status: f.status, priority: f.priority, assignee_id: f.assignee_id || null, due_date: f.due_date || null }
    : { status: f.status };
  await q(sb().from("tasks").update(patch as never).eq("id", id));
}

export const deleteTask = (id: string) => q(sb().from("tasks").delete().eq("id", id));
export const moveTask = (id: string, status: string) => q(sb().from("tasks").update({ status } as never).eq("id", id));

// ---------- personal checklist ----------
export async function addChecklistItem(ownerId: string, label: string, positions: number[]) {
  if (!label.trim()) return;
  const nextPosition = positions.length > 0 ? Math.max(...positions) + 1 : 0;
  await q(sb().from("personal_checklist_items").insert({ owner_id: ownerId, label: label.trim(), position: nextPosition } as never));
}
export const toggleChecklistItem = (id: string, done: boolean) => q(sb().from("personal_checklist_items").update({ done } as never).eq("id", id));
export const renameChecklistItem = (id: string, label: string) => q(sb().from("personal_checklist_items").update({ label: label.trim() } as never).eq("id", id));
export const removeChecklistItem = (id: string) => q(sb().from("personal_checklist_items").delete().eq("id", id));
export const armReminder = (id: string, at: string) => q(sb().from("personal_checklist_items").update({ due_at: new Date(at).toISOString(), reminders_on: true } as never).eq("id", id));
export const disarmReminder = (id: string) => q(sb().from("personal_checklist_items").update({ reminders_on: false } as never).eq("id", id));
