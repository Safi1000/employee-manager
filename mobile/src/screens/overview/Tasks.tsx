import { Bell, BellOff, Plus, Trash2 } from "lucide-react-native";
import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Button, Card, Checkbox, Empty, HStack, IconBtn, Input, Section, Segmented, toneOf } from "../../components/ui";
import { Task, TODAY } from "../../data/seed";
import { useDB } from "../../data/store";
import {
  addChecklistItem, armReminder, createTask, deleteTask, disarmReminder, moveTask, removeChecklistItem, TaskForm, toggleChecklistItem, updateTask,
} from "../../data/api/overview";
import { useAuth } from "../../lib/auth";
import { isAdmin } from "../../lib/permissions";
import { daysBetween, fmtShort } from "../../lib/format";
import { useTheme } from "../../theme/ThemeProvider";

const COLS: { key: Task["status"]; label: string; tone: "info" | "warning" | "success" }[] = [
  { key: "todo", label: "To do", tone: "info" },
  { key: "in_progress", label: "In progress", tone: "warning" },
  { key: "done", label: "Done", tone: "success" },
];
const PRIORITY_TONE = { low: "neutral", medium: "info", high: "warning", urgent: "danger" } as const;

/** Task Board (admins) / My Tasks (everyone else) — web Tasks.tsx; kanban columns become a segmented switch. */
export default function Tasks() {
  const t = useTheme();
  const { db, act } = useDB();
  const { profile } = useAuth();
  const { confirm } = useOverlay();
  const admin = isAdmin(profile);
  const [col, setCol] = useState<Task["status"]>("todo");
  const [edit, setEdit] = useState<Task | "new" | null>(null);
  const [newItem, setNewItem] = useState("");
  const [remind, setRemind] = useState<string | null>(null);
  const [remindAt, setRemindAt] = useState("");
  const mine = admin ? db.tasks : db.tasks.filter((x) => x.raw?.assignee_id === profile?.id);
  const shown = mine.filter((x) => x.status === col);

  return (
    <Screen
      eyebrow="Overview"
      title={admin ? "Task Board" : "My Tasks"}
      actions={admin ? <IconBtn icon={Plus} label="New task" filled onPress={() => setEdit("new")} /> : undefined}
      sticky={<Segmented value={col} onChange={setCol} items={COLS.map((c) => ({ key: c.key, label: c.label, count: mine.filter((x) => x.status === c.key).length }))} />}
    >
      {shown.map((x) => {
        const d = x.due ? daysBetween(TODAY, x.due) : 0;
        return (
          <Card key={x.id} style={{ marginBottom: 10, borderTopWidth: 3, borderTopColor: t.tone(COLS.find((c) => c.key === x.status)!.tone).solid }} onPress={() => setEdit(x)}>
            <HStack style={{ alignItems: "flex-start" }}>
              <T v="bodyStrong" style={{ flex: 1 }}>{x.title}</T>
              <Badge label={x.priority} tone={PRIORITY_TONE[x.priority]} small />
            </HStack>
            {x.description ? <T v="small" muted style={{ marginTop: 4 }}>{x.description}</T> : null}
            <HStack style={{ marginTop: 10 }}>
              <T v="small" soft style={{ flex: 1 }}>{x.assignee || "Unassigned"}</T>
              {x.due ? <T v="mono" style={{ fontSize: 12 }} color={x.status !== "done" && d < 0 ? t.tone("danger").text : t.mutedFg}>{x.status !== "done" && d < 0 ? `${-d}d late` : `due ${fmtShort(x.due)}`}</T> : null}
            </HStack>
            <HStack style={{ marginTop: 12 }}>
              {x.status === "todo" && <Button size="sm" variant="secondary" label="Start" onPress={() => { void act(() => moveTask(x.id, "in_progress"), "Moved to In progress"); }} />}
              {x.status !== "done" && <Button size="sm" variant="success" label="Mark done" onPress={() => { void act(() => moveTask(x.id, "done"), "Task done"); }} />}
              {x.status === "done" && <Button size="sm" variant="secondary" label="Reopen" onPress={() => { void act(() => moveTask(x.id, "todo"), "Reopened"); }} />}
              {admin && <Button size="sm" variant="ghost" label="Delete" icon={Trash2} onPress={async () => { if (await confirm({ title: `Delete task "${x.title}"?`, confirmLabel: "Delete", tone: "danger" })) await act(() => deleteTask(x.id), "Task deleted"); }} />}
            </HStack>
          </Card>
        );
      })}
      {shown.length === 0 && <Empty title="Nothing here" sub={col === "done" ? "Finished tasks land here." : "You're clear."} />}

      <Section title="Personal checklist" count={`${db.checklist.filter((c) => c.done).length}/${db.checklist.length}`} hint="Only you can see this.">
        <Card>
          {db.checklist.map((c) => (
            <View key={c.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ flex: 1 }}><Checkbox value={c.done} label={c.text} onChange={(v) => { void act(() => toggleChecklistItem(c.id, v)); }} /></View>
              <Pressable hitSlop={8} onPress={() => c.raw?.reminders_on ? act(() => disarmReminder(c.id), "Reminder off") : (setRemind(c.id), setRemindAt(""))}>
                {c.raw?.reminders_on ? <Bell size={16} color={t.tone("brand").text} /> : <BellOff size={16} color={t.mutedFg} />}
              </Pressable>
              <Pressable hitSlop={8} onPress={() => { void act(() => removeChecklistItem(c.id)); }}><Trash2 size={16} color={t.mutedFg} /></Pressable>
            </View>
          ))}
          <HStack style={{ marginTop: 10 }}>
            <View style={{ flex: 1 }}>
              <Input style={{ marginBottom: 0 }} value={newItem} onChangeText={setNewItem} placeholder="Add an item"
                onSubmitEditing={async () => { if (profile && newItem.trim() && await act(() => addChecklistItem(profile.id, newItem, db.checklist.map((x) => x.raw?.position ?? 0)))) setNewItem(""); }} />
            </View>
          </HStack>
        </Card>
      </Section>

      <Sheet open={!!remind} onClose={() => setRemind(null)} title="Email me a reminder"
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setRemind(null)} /><Button label="Set reminder" full disabled={!remindAt} onPress={async () => {
          if (remind && await act(() => armReminder(remind, remindAt.replace(" ", "T")), "Reminder set")) setRemind(null);
        }} /></>}>
        <Input label="When" value={remindAt} onChangeText={setRemindAt} placeholder="YYYY-MM-DD HH:MM" />
      </Sheet>

      <TaskSheet key={edit === "new" ? "new" : edit?.id ?? "none"} task={edit} onClose={() => setEdit(null)} admin={admin} />
    </Screen>
  );
}

function TaskSheet({ task, onClose, admin }: { task: Task | "new" | null; onClose: () => void; admin: boolean }) {
  const { db, act } = useDB();
  const isNew = task === "new";
  const r = !isNew && task ? task.raw ?? {} : {};
  const [f, setF] = useState<TaskForm>({
    title: !isNew && task ? task.title : "", description: !isNew && task ? task.description : "", status: !isNew && task ? task.status : "todo",
    priority: !isNew && task ? task.priority : "medium", assignee_id: r.assignee_id ?? "", due_date: r.due_date ?? "",
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const ok = await act(() => isNew ? createTask(db.companyId, f) : updateTask((task as Task).id, f, admin), isNew ? "Task created" : "Task saved");
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Sheet open={!!task} onClose={onClose} title={isNew ? "New task" : `Task — ${f.title}`}
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label="Save" full loading={busy} disabled={!f.title.trim()} onPress={save} /></>}>
      <Input label="Title" required editable={admin} value={f.title} onChangeText={(v) => setF({ ...f, title: v })} />
      <Input label="Description" editable={admin} multiline value={f.description} onChangeText={(v) => setF({ ...f, description: v })} />
      {admin ? (
        <>
          <Select label="Assignee" clearable value={f.assignee_id} onChange={(v) => setF({ ...f, assignee_id: v })} placeholder="Unassigned" options={db.users.map((u) => ({ value: u.id, label: u.name, sub: u.title }))} />
          <Input label="Due date" value={f.due_date} onChangeText={(v) => setF({ ...f, due_date: v })} placeholder="YYYY-MM-DD" />
          <Select label="Priority" value={f.priority} onChange={(v) => setF({ ...f, priority: v })} options={["low", "medium", "high", "urgent"].map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))} />
        </>
      ) : (
        <T v="small" muted style={{ marginBottom: 12 }}>Only an admin can change the title, assignee, due date or priority.</T>
      )}
      <Select label="Status" value={f.status} onChange={(v) => setF({ ...f, status: v })} options={COLS.map((c) => ({ value: c.key, label: c.label }))} />
      <Badge label={f.status.replace("_", " ")} tone={toneOf(f.status)} />
    </Sheet>
  );
}
