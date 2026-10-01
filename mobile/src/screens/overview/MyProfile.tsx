// My Profile (web super-admin/MyProfile.tsx): a logged-in employee's own record,
// attendance for a month, payslips, advances, documents, warnings and the cash
// they hold as a custodian. The employee link on the profile is the entitlement.
import React, { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Avatar, Badge, Banner, Card, Empty, Fields, ListCard, RecordCard, Row, Section, StatGrid } from "../../components/ui";
import { useDB } from "../../data/store";
import { q, sb } from "../../data/api/core";
import { monthKeys, monthName, lastOfMonthKey } from "../../data/api/finance";
import { loadCustodianOptions } from "../../lib/web/custodian";
import { useAuth } from "../../lib/auth";
import { fmtShort, pkr } from "../../lib/format";

async function loadMe(employeeId: string, month: string) {
  const s = sb();
  const [emp, payslips, advances, attendance, docs, warnings] = await Promise.all([
    q<any>(s.from("employees").select("id, full_name, employee_code, guard_code, phone, category, department, shift, status, lifecycle_state, base_salary, allowance, join_date, bank_name, bank_account, account_title, client:client_id(name), branch:branch_id(name), location:location_id(name)").eq("id", employeeId).maybeSingle()),
    q<any[]>(s.from("payslips").select("id, period_month, present_days, absent_days, leave_days, base_salary, bonus, deductions, advance, net_salary, amount_paid, status, disbursed, disbursed_at").eq("employee_id", employeeId).order("period_month", { ascending: false })),
    q<any[]>(s.from("advances").select("id, amount, advance_date, payment_mode, notes").eq("employee_id", employeeId).order("advance_date", { ascending: false })),
    q<any[]>(s.from("attendance_records").select("attendance_date, status").eq("employee_id", employeeId).gte("attendance_date", `${month}-01`).lte("attendance_date", lastOfMonthKey(month)).order("attendance_date")),
    q<any[]>(s.from("employee_documents").select("id, doc_type, file_name, created_at").eq("employee_id", employeeId).order("created_at", { ascending: false })),
    q<any[]>(s.from("disciplinary_warnings").select("id, warning_type, reason, issued_date").eq("employee_id", employeeId).order("issued_date", { ascending: false })),
  ]);
  return { emp, payslips, advances, attendance, docs, warnings };
}

export default function MyProfile() {
  const { db } = useDB();
  const { profile } = useAuth();
  const employeeId = profile?.employee_id ?? null;
  const [month, setMonth] = useState(monthKeys(1)[0]);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadMe>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  useEffect(() => {
    if (!employeeId) return;
    let c = false;
    loadMe(employeeId, month).then((d) => { if (!c) { setData(d); setError(null); } }).catch((e) => { if (!c) setError(e instanceof Error ? e.message : String(e)); });
    return () => { c = true; };
  }, [employeeId, month]);
  useEffect(() => {
    if (!employeeId || !db.company.id) return;
    let c = false;
    loadCustodianOptions(db.company.id, true).then((opts) => {
      if (c) return;
      const mine = opts.find((o) => o.kind === "employee" && o.employeeId === employeeId);
      setHeld(mine ? mine.held : null);
    }).catch(() => undefined);
    return () => { c = true; };
  }, [employeeId, db.company.id]);

  if (!employeeId) return <Screen title="My Profile"><Empty title="Your login isn't linked to an employee record" sub="An administrator can link it from Access & Governance." /></Screen>;
  const e = data?.emp;
  const count = (...ss: string[]) => (data?.attendance ?? []).filter((a) => ss.includes(String(a.status).toLowerCase())).length;
  return (
    <Screen eyebrow="Me" title="My Profile" subtitle={e ? `${e.full_name} · your record, attendance, pay and cash` : "Your own record"}>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {data && !e && <Empty title="Your employee record couldn't be read" />}
      {e && (
        <>
          <Card>
            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <Avatar name={e.full_name} size={52} />
              <View style={{ flex: 1 }}>
                <T v="h3">{e.full_name}</T>
                <T v="mono" muted style={{ fontSize: 12 }}>{e.guard_code ?? e.employee_code}{e.department ? ` · ${e.department}` : ""}</T>
              </View>
              <Badge label={e.status} dot />
            </View>
            <View style={{ marginTop: 14 }}>
              <Fields items={[
                { label: "Posting", value: e.client?.name ?? (e.category ?? "").replace("_", " ") }, { label: "Region", value: e.branch?.name ?? "—" },
                { label: "Joined", value: e.join_date ? fmtShort(e.join_date) : "—" }, { label: "Shift", value: e.shift ?? "—" },
                { label: "Base", value: pkr(Number(e.base_salary ?? 0)), mono: true }, { label: "Allowance", value: pkr(Number(e.allowance ?? 0)), mono: true },
                { label: "Bank", value: [e.bank_name, e.bank_account].filter(Boolean).join(" ") || "—", full: true },
              ]} />
            </View>
          </Card>
          {held != null && (
            <Section title="Cash you hold">
              <RecordCard title="Custodian cash" accent="warning" fields={[{ label: "Held", value: pkr(held), mono: true }]} />
            </Section>
          )}
          <Section title={`Attendance · ${monthName(month)}`} count={data.attendance.length}>
            <Select compact label="Month" value={month} onChange={setMonth} options={monthKeys(12).map((m) => ({ value: m, label: monthName(m) }))} />
            <View style={{ height: 8 }} />
            <StatGrid cols={3} items={[{ label: "Present", value: String(count("present", "double_duty", "relief_cover")), tone: "success" }, { label: "Absent", value: String(count("absent")), tone: "danger" }, { label: "Leave", value: String(count("leave", "rotation_leave")), tone: "warning" }]} />
            <ListCard style={{ marginTop: 8 }}>{data.attendance.map((a, i) => <Row key={a.attendance_date} last={i === data.attendance.length - 1} title={fmtShort(a.attendance_date)} right={<Badge small label={String(a.status).replace(/_/g, " ")} />} />)}</ListCard>
          </Section>
          <Section title="Payslips" count={data.payslips.length}>
            {data.payslips.map((p) => (
              <RecordCard key={p.id} title={monthName(String(p.period_month).slice(0, 7))} badge={<Badge label={p.disbursed ? "Disbursed" : p.status} tone={p.disbursed ? "success" : "warning"} small />} fields={[
                { label: "Present", value: `${p.present_days} days` }, { label: "Base", value: pkr(Number(p.base_salary)), mono: true },
                { label: "Bonus", value: pkr(Number(p.bonus)), mono: true }, { label: "Advance", value: pkr(Number(p.advance)), mono: true },
                { label: "Deductions", value: pkr(Number(p.deductions)), mono: true }, { label: "Net", value: pkr(Number(p.net_salary)), mono: true, tone: "success" },
                { label: "Paid", value: pkr(Number(p.amount_paid ?? 0)), mono: true },
              ]} />
            ))}
            {data.payslips.length === 0 && <T v="small" muted>No payslips yet.</T>}
          </Section>
          <Section title="Advances taken" count={data.advances.length}>
            <ListCard>{data.advances.map((a, i) => <Row key={a.id} last={i === data.advances.length - 1} title={pkr(Number(a.amount))} meta={`${fmtShort(a.advance_date)} · ${a.payment_mode}${a.notes ? ` · ${a.notes}` : ""}`} />)}</ListCard>
            {data.advances.length === 0 && <T v="small" muted>No advances.</T>}
          </Section>
          {data.docs.length > 0 && (
            <Section title="Documents on file" count={data.docs.length}>
              <ListCard>{data.docs.map((d, i) => <Row key={d.id} last={i === data.docs.length - 1} title={d.file_name} meta={`${d.doc_type} · ${fmtShort(String(d.created_at).slice(0, 10))}`} />)}</ListCard>
            </Section>
          )}
          {data.warnings.length > 0 && (
            <Section title="Disciplinary warnings" count={data.warnings.length}>
              <ListCard>{data.warnings.map((w, i) => <Row key={w.id} last={i === data.warnings.length - 1} title={w.warning_type} subtitle={w.reason} meta={fmtShort(w.issued_date)} />)}</ListCard>
            </Section>
          )}
        </>
      )}
    </Screen>
  );
}
