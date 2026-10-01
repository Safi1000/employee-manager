import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { Select, Sheet } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Input, ListCard, Row, Toggle } from "../../components/ui";
import type { Employee } from "../../data/seed";
import { useDB } from "../../data/store";
import {
  changeCategory, changeClient, changeShift, clearanceGates, ClearanceGates, issueWarning, linesForSite, loadWarnings,
  MoveReason, rescindWarning, separate, shiftOptions, today, transfer, TransferDest, Warning,
} from "../../data/api/employees";
import { fmtShort, pkr } from "../../lib/format";

export type EmpAction = "client" | "category" | "shift" | "transfer" | "fire" | "warnings" | null;

const SHIFT_LABEL: Record<string, string> = { day: "Day", night: "Night", evening: "Evening" };
const REASONS: { value: MoveReason; label: string }[] = [
  { value: "relief_cover", label: "Relief cover" },
  { value: "return_to_pool", label: "Return to pool" },
  { value: "shift_change", label: "Shift change" },
  { value: "separation", label: "Separation" },
];

/** One host for the HR sheets the web opens from Employees and Assignments & Pay. Each save is the web handler's port (api/employees.ts). */
export function EmployeeActionSheets({ e, action, onClose }: { e: Employee | null; action: EmpAction; onClose: () => void }) {
  const { db, act } = useDB();
  const [client, setClient] = useState("");
  const [site, setSite] = useState("");
  const [line, setLine] = useState("");
  const [reason, setReason] = useState<MoveReason>("relief_cover");
  const [eff, setEff] = useState(today());
  const [cat, setCat] = useState<"client" | "office_staff" | "reliever" | "">("");
  const [dest, setDest] = useState<TransferDest>("client");
  const [branch, setBranch] = useState("");
  const [shift, setShift] = useState("");
  const [shifts, setShifts] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [sepType, setSepType] = useState<"firing" | "resignation">("firing");
  const [eligible, setEligible] = useState(false);
  const [gates, setGates] = useState<ClearanceGates | null>(null);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setClient(""); setSite(""); setLine(""); setReason("relief_cover"); setEff(today()); setCat(""); setDest("client");
    setBranch(""); setShift(""); setNote(""); setSepType("firing"); setEligible(false); setGates(null); setBusy(false);
    onClose();
  };

  // Per-sheet data the web loads when its modal opens.
  useEffect(() => {
    if (!e) return;
    let alive = true;
    if (action === "shift") shiftOptions(e).then((s) => { if (alive) { setShifts(s); setShift(s.find((x) => x !== e.shift) ?? ""); } }).catch(() => {});
    if (action === "fire") clearanceGates(e.id).then((g) => alive && setGates(g)).catch(() => {});
    if (action === "warnings") loadWarnings(e.id).then((w) => alive && setWarnings(w)).catch(() => {});
    return () => { alive = false; };
  }, [action, e]);

  if (!e) return null;
  const run = async (fn: () => Promise<unknown>, ok: string, keepOpen = false) => {
    setBusy(true);
    const done = await act(fn, ok);
    setBusy(false);
    if (done && !keepOpen) reset();
    return done;
  };

  const clientOpts = db.clients.filter((c) => c.status === "active").map((c) => ({ value: c.id, label: c.name }));
  const siteOpts = (cid: string) => db.sites.filter((s) => s.client_id === cid).map((s) => ({ value: s.id, label: s.name }));
  const lineOpts = (cid: string, sid: string) => linesForSite(db.contracts, cid, sid || null).map((l) => ({ value: l.id, label: l.category, sub: `${l.active}/${l.committed} posted` }));
  const catOpts = (["reliever", "client", "office_staff"] as const).filter((c) => c !== e.category).map((c) => ({ value: c, label: c === "client" ? "Client" : c === "office_staff" ? "Office staff" : "Reliever" }));
  const posting = (cid: string, required = false) => cid ? (
    <>
      {siteOpts(cid).length > 0 && <Select label="Site" required={required} value={site} onChange={(v) => { setSite(v); setLine(""); }} options={siteOpts(cid)} />}
      <Select label="Contract line" clearable value={line} onChange={setLine} options={lineOpts(cid, site)} />
    </>
  ) : null;
  const cancel = <Button label="Cancel" variant="secondary" full onPress={reset} />;
  const effInput = <Input label="Effective date" required value={eff} onChangeText={setEff} placeholder="YYYY-MM-DD" />;

  return (
    <>
      {/* ChangeClientModal */}
      <Sheet open={action === "client"} onClose={reset} title="Change client" subtitle={e.name}
        footer={<>{cancel}<Button label="Save" full loading={busy} disabled={!client} onPress={() => run(() => changeClient(e, db.clients, { clientId: client, lineId: line, siteId: site, reason, effectiveDate: eff }), `${e.name} moved`)} /></>}>
        <Select label="Client" required value={client} onChange={(v) => { setClient(v); setSite(""); setLine(""); }} options={clientOpts} />
        {posting(client)}
        <Select label="Reason" value={reason} onChange={(v) => setReason(v as MoveReason)} options={REASONS} />
        {effInput}
      </Sheet>

      {/* ChangeCategoryModal */}
      <Sheet open={action === "category"} onClose={reset} title="Change category" subtitle={e.name}
        footer={<>{cancel}<Button label="Save" full loading={busy} disabled={!cat} onPress={() => run(() => changeCategory(e, db.clients, { category: cat as "client", clientId: client, lineId: line, siteId: site, effectiveDate: eff }), "Category changed")} /></>}>
        <Select label="New category" required value={cat} onChange={(v) => setCat(v as "client")} options={catOpts} />
        {cat === "client" && <Select label="Client" required value={client} onChange={(v) => { setClient(v); setSite(""); setLine(""); }} options={clientOpts} />}
        {cat === "client" && posting(client)}
        {effInput}
      </Sheet>

      {/* ChangeShiftModal */}
      <Sheet open={action === "shift"} onClose={reset} title={`Change shift — ${e.name}`}
        footer={<>{cancel}<Button label="Change shift" full loading={busy} disabled={!shift || shifts.length < 2} onPress={() => run(() => changeShift(e, shift, eff), "Shift changed")} /></>}>
        <T v="small" muted style={{ marginBottom: 12 }}>Currently on the {SHIFT_LABEL[e.shift] ?? e.shift} shift.</T>
        {shifts.length < 2 ? (
          <Banner tone="info" title="No other shift to move to" sub="This site runs a single shift." />
        ) : (
          <Select label="New shift" required value={shift} onChange={setShift} options={shifts.filter((s) => s !== e.shift).map((s) => ({ value: s, label: SHIFT_LABEL[s] ?? s }))} />
        )}
        {effInput}
      </Sheet>

      {/* TransferModal (Assignments & Pay) */}
      <Sheet open={action === "transfer"} onClose={reset} title={`Transfer ${e.name}`}
        footer={<>{cancel}<Button label="Transfer" full loading={busy} onPress={() => run(() => transfer(e, db.clients, {
          dest, branchId: branch, clientId: client, siteId: site, lineId: line, effectiveDate: eff,
          hasSites: siteOpts(dest === "site" ? e.client_id ?? "" : client).length > 0,
        }), `${e.name} transferred`)} /></>}>
        <Select label="Transfer to" required value={dest} onChange={(v) => { setDest(v as TransferDest); setClient(""); setSite(""); setLine(""); }} options={[
          { value: "client", label: "Another client" },
          ...(e.client_id && siteOpts(e.client_id).length > 1 ? [{ value: "site", label: "Another site (same client)" }] : []),
          { value: "branch", label: "Another region" },
          ...(e.category !== "office_staff" ? [{ value: "office_staff", label: "Office staff" }] : []),
          ...(e.category !== "reliever" ? [{ value: "reliever", label: "Reliever pool" }] : []),
        ]} />
        {dest === "branch" && <Select label="Region" required value={branch} onChange={setBranch} options={db.branches.filter((b) => b.id !== e.branch_id).map((b) => ({ value: b.id, label: b.name }))} />}
        {dest === "client" && <Select label="Client" required value={client} onChange={(v) => { setClient(v); setSite(""); setLine(""); }} options={clientOpts.filter((c) => c.value !== e.client_id)} />}
        {dest === "client" && posting(client, true)}
        {dest === "site" && e.client_id && (
          <>
            <Select label="Site" required value={site} onChange={(v) => { setSite(v); setLine(""); }} options={siteOpts(e.client_id).filter((s) => s.value !== e.site_id)} />
            <Select label="Contract line" clearable value={line} onChange={setLine} options={lineOpts(e.client_id, site)} />
          </>
        )}
        {dest !== "branch" && effInput}
      </Sheet>

      {/* FireGuardModal */}
      <Sheet open={action === "fire"} onClose={reset} title={`Fire / Resign — ${e.name}`}
        footer={<>{cancel}<Button label="Confirm" variant="danger" full loading={busy} disabled={!note.trim() || !eff} onPress={() => run(() => separate(e, { type: sepType, date: eff, eligible, reason: note }), `${e.name} removed from roster`)} /></>}>
        <Banner tone="danger" title="The post falls vacant on the effective date" sub="Their last working day is the day before. Past attendance stays." />
        {gates && (gates.outstanding_kit_count || gates.outstanding_advance || gates.open_incident_count || gates.undisbursed_salary) ? (
          <Banner tone="warning" title="Outstanding at exit" sub={[
            gates.outstanding_kit_count ? `${gates.outstanding_kit_count} kit item(s) not returned` : "",
            gates.outstanding_advance ? `advance ${pkr(gates.outstanding_advance)}` : "",
            gates.open_incident_count ? `${gates.open_incident_count} open incident(s)` : "",
            gates.undisbursed_salary ? `undisbursed salary ${pkr(gates.undisbursed_salary)}` : "",
          ].filter(Boolean).join(" · ")} />
        ) : null}
        <Select label="Type" required value={sepType} onChange={(v) => { setSepType(v as "firing"); setEligible(v === "resignation"); }} options={[{ value: "firing", label: "Fired" }, { value: "resignation", label: "Resigned" }]} />
        <Input label="Effective date" required value={eff} onChangeText={setEff} placeholder="YYYY-MM-DD" />
        <Toggle label="Eligible for rehire" value={eligible} onChange={setEligible} />
        <Input label="Reason" required value={note} onChangeText={setNote} multiline />
      </Sheet>

      {/* DisciplinaryWarningsModal */}
      <Sheet open={action === "warnings"} onClose={reset} title={`Disciplinary warnings — ${e.name}`}
        footer={<>{<Button label="Close" variant="secondary" full onPress={reset} />}<Button label="Issue warning" full loading={busy} disabled={!note.trim()} onPress={async () => {
          if (await run(() => issueWarning(e.id, note), "Warning issued", true)) { setNote(""); setWarnings(await loadWarnings(e.id)); }
        }} /></>}>
        <ListCard style={{ marginBottom: 16 }}>
          {warnings.length ? warnings.map((w, i) => (
            <Row key={w.id} last={i === warnings.length - 1} title={w.reason} meta={`${w.warning_number ? `#${w.warning_number} · ` : ""}${fmtShort(w.issued_on)}`}
              right={w.rescinded ? <Badge label="Rescinded" tone="neutral" small /> : <Button size="sm" variant="ghost" label="Rescind" onPress={async () => {
                if (await run(() => rescindWarning(w.id), "Warning rescinded", true)) setWarnings(await loadWarnings(e.id));
              }} />} />
          )) : <View style={{ padding: 14 }}><T v="small" muted>No warnings on record.</T></View>}
        </ListCard>
        <Input label="New warning" value={note} onChangeText={setNote} multiline placeholder="What happened" />
      </Sheet>
    </>
  );
}
