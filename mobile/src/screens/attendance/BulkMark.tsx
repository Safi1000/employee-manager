import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { MonthGrid, MonthStepper } from "../../components/MonthGrid";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Banner, Button, Chips, Input } from "../../components/ui";
import { THIS_MONTH } from "../../data/seed";
import { clientName, useDB } from "../../data/store";
import { bulkClear, bulkMark, BulkStatus, CalendarContext, loadCalendar } from "../../data/api/attendance";
import { useAuth } from "../../lib/auth";
import { useTheme } from "../../theme/ThemeProvider";

const LETTER: Record<string, string> = { present: "P", absent: "A", leave: "L", double_duty: "DD", rest_day: "L", relief_cover: "RC" };
const STATUSES: { key: BulkStatus; label: string }[] = [
  { key: "present", label: "Present" }, { key: "absent", label: "Absent" }, { key: "leave", label: "Leave" }, { key: "double_duty", label: "Double duty" },
];

/**
 * BulkMarkByEmployeeModal. Select days on the month, then apply ONE mark to all
 * of them (or clear them). Which shift each day lands on is derived from the
 * dated posting, never picked; double duty adds the shift before it in the cycle.
 */
export function BulkMarkSheet({ open, onClose, employeeId }: { open: boolean; onClose: () => void; employeeId?: string }) {
  const t = useTheme();
  const { db, act } = useDB();
  const { profile } = useAuth();
  const { toast } = useOverlay();
  const [client, setClient] = useState("");
  const [emp, setEmp] = useState(employeeId ?? "");
  const [month, setMonth] = useState(THIS_MONTH);
  const [status, setStatus] = useState<BulkStatus>("present");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [override, setOverride] = useState("");
  const [ctx, setCtx] = useState<CalendarContext | null>(null);
  const [busy, setBusy] = useState(false);
  const staff = db.employees.filter((e) => e.category !== "reliever" && e.raw?.lifecycle_state !== "archived" && (!client || e.client_id === client));
  const e = db.employees.find((x) => x.id === emp);

  const reload = useCallback(async () => {
    if (!e) { setCtx(null); return; }
    setCtx(null);
    try { setCtx(await loadCalendar(e, month, db.contracts)); } catch (err) { toast(err instanceof Error ? err.message : String(err), "danger"); }
  }, [e, month, db.contracts, toast]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
  useEffect(() => { setSelected(new Set()); void reload(); }, [reload]);

  const toggle = (d: string) => {
    if (!ctx || ctx.windowBlock(d)) return;
    setSelected((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n; });
  };
  const run = async (kind: "mark" | "clear") => {
    if (!e || !ctx || !profile || selected.size === 0) return;
    setBusy(true);
    let notice = "";
    const ok = await act(async () => {
      notice = kind === "mark" ? await bulkMark(e, ctx, [...selected], status, override, profile) : await bulkClear(e, ctx, [...selected], override);
    });
    setBusy(false);
    if (ok) { toast(notice); setOverride(""); setSelected(new Set()); await reload(); }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Bulk mark by employee" subtitle="Select the days, then apply one mark." full
      footer={<>
        <Button label="Clear marks" variant="secondary" full loading={busy} disabled={!selected.size} onPress={() => run("clear")} />
        <Button label={selected.size ? `Mark ${selected.size} day${selected.size > 1 ? "s" : ""}` : "Mark"} full loading={busy} disabled={!selected.size} onPress={() => run("mark")} />
      </>}>
      <Select label="Client" clearable value={client} onChange={(v) => { setClient(v); setEmp(""); }} placeholder="All clients" options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />
      <Select label="Employee" required searchable value={emp} onChange={setEmp} options={staff.map((x) => ({ value: x.id, label: x.name, sub: `${x.code} · ${clientName(db, x.client_id)}` }))} />
      <MonthStepper month={month} onChange={setMonth} />
      <View style={{ marginVertical: 12 }}>
        <Chips value={status} onChange={setStatus} items={STATUSES} />
      </View>
      {!e ? (
        <T v="small" muted center style={{ paddingVertical: 24 }}>Choose an employee to load their month.</T>
      ) : !ctx ? (
        <ActivityIndicator color={t.brand[500]} style={{ marginVertical: 24 }} />
      ) : (
        <>
          <MonthGrid
            month={month}
            onPress={toggle}
            render={(d) => {
              const blocked = !!ctx.windowBlock(d);
              const on = selected.has(d);
              const cur = ctx.existing.get(d);
              return (
                <View style={{ alignItems: "center", paddingVertical: 2, borderRadius: 6, backgroundColor: on ? t.tone("brand").tint : "transparent", opacity: blocked ? 0.35 : 1 }}>
                  <T v="mono" style={{ fontSize: 10 }} color={on ? t.tone("brand").text : t.mutedFg}>{cur ? LETTER[cur] ?? "?" : on ? "•" : ""}</T>
                </View>
              );
            }}
          />
          <T v="small" muted style={{ marginTop: 8 }}>Greyed days are outside the employment or contract window. Tap a day again to deselect it.</T>
          <Input label="Supervisor override reason" value={override} onChangeText={setOverride} multiline placeholder="Only needed for days past the backdate limit" />
          {status === "double_duty" && <Banner tone="info" title="Double duty" sub="Writes the rostered shift plus the shift before it in the cycle, both as double duty." />}
        </>
      )}
    </Sheet>
  );
}
