import { useState } from "react";
import { invoiceGaps, methodLabel, modeLabel, monthShort, type FollowInvoice, type FollowUpdates } from "../lib/followUpData";
import { channelLabel } from "./PaymentFollowUp";

/**
 * The follow-up UPDATES SUMMARY (0634): what happened in the period, and what
 * is open now — tiles that open their list. The same panel sits on Payment
 * Follow-up and in the Finance Report. Amounts show only when the database
 * returned them (finance logins).
 */
const fmt = (v: number | null) => (v == null ? "" : Math.round(v).toLocaleString("en-US"));
const dshort = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

type Key = "payments" | "contacts" | "delivered" | "notDelivered" | "missing" | "missed" | "due" | "done";

export default function FollowUpSummary({ updates, invoices, regionId, canSeeAmounts }: {
  updates: FollowUpdates | null; invoices: Map<string, FollowInvoice[]>; regionId: string | null; canSeeAmounts: boolean;
}) {
  const [open, setOpen] = useState<Key | null>(null);
  if (!updates) return null;
  const inRegion = <T extends { branch_id: string | null }>(xs: T[]) => xs.filter((x) => !regionId || x.branch_id === regionId);
  const u = {
    payments: inRegion(updates.payments), contacts: inRegion(updates.contacts), delivered: inRegion(updates.delivered),
    missed: inRegion(updates.promises_missed), due: inRegion(updates.steps_due), done: inRegion(updates.steps_done),
  };
  const gaps = invoiceGaps(invoices, regionId);
  const month = monthShort([...invoices.values()][0]?.[0]?.for_month);
  const received = u.payments.reduce((s, p) => s + (p.amount ?? 0), 0);

  const tiles: { key: Key; label: string; value: number; sub?: string; warn?: boolean }[] = [
    { key: "payments", label: "Payments received", value: u.payments.length, sub: canSeeAmounts && u.payments.length ? fmt(received) : undefined },
    { key: "contacts", label: "Contacts logged", value: u.contacts.length },
    { key: "delivered", label: "Invoices delivered", value: u.delivered.length },
    { key: "notDelivered", label: `${month} invoices not delivered`, value: gaps.notDelivered.length, warn: gaps.notDelivered.length > 0 },
    { key: "missing", label: `No ${month} invoice`, value: gaps.missing.length, warn: gaps.missing.length > 0 },
    { key: "missed", label: "Promises missed", value: u.missed.length, warn: u.missed.length > 0 },
    { key: "due", label: "Next steps due", value: u.due.length, warn: u.due.length > 0 },
    { key: "done", label: "Steps done", value: u.done.length },
  ];

  const list = (): React.ReactNode => {
    const li = (k: string, a: React.ReactNode) => <li key={k} className="py-1 border-b border-border last:border-0">{a}</li>;
    switch (open) {
      case "payments": return u.payments.map((p, i) => li(`${i}`, <><b>{p.client}</b> <span className="text-muted-foreground">· {dshort(p.on)}{p.mode ? ` · ${modeLabel(p.mode)}` : ""}</span>{p.amount != null && <span className="float-right tabular-nums">{fmt(p.amount)}</span>}</>));
      case "contacts": return u.contacts.map((c, i) => li(`${i}`, <><b>{c.client}</b> <span className="text-muted-foreground">· {dshort(c.on)} · {channelLabel(c.channel)}{c.by ? ` · ${c.by}` : ""}</span><div>{c.note}{c.promised_by ? ` Promised by ${dshort(c.promised_by)}${c.promised_amount != null ? ` (${fmt(c.promised_amount)})` : ""}.` : ""}{c.next_step ? ` Next: ${c.next_step}.` : ""}</div></>));
      case "delivered": return u.delivered.map((d, i) => li(`${i}`, <><b>{d.client}</b> <span className="text-muted-foreground">· {d.number} · {dshort(d.on)}, {methodLabel(d.method)}</span>{d.amount != null && <span className="float-right tabular-nums">{fmt(d.amount)}</span>}</>));
      case "notDelivered": return gaps.notDelivered.map((d, i) => li(`${i}`, <><b>{d.client}</b> <span className="text-muted-foreground">· {d.number}</span></>));
      case "missing": return gaps.missing.map((c, i) => li(`${i}`, <b>{c}</b>));
      case "missed": return u.missed.map((m, i) => li(`${i}`, <><b>{m.client}</b> <span className="text-muted-foreground">· promised by {dshort(m.promised_by)}</span>{m.promised_amount != null && <span className="float-right tabular-nums">{fmt(m.promised_amount)}</span>}</>));
      case "due": return u.due.map((s, i) => li(`${i}`, <><b>{s.client}</b>: {s.step} <span className="text-muted-foreground">· {s.who ?? "anyone"} · due {dshort(s.due)}</span></>));
      case "done": return u.done.map((s, i) => li(`${i}`, <><b>{s.client}</b>: {s.step} <span className="text-muted-foreground">· {s.by ?? ""} · {dshort(s.at)}</span></>));
      default: return null;
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-px bg-border rounded-t-xl overflow-hidden">
        {tiles.map((t) => (
          <button key={t.key} type="button" onClick={() => setOpen(open === t.key ? null : t.key)} disabled={!t.value}
            className={`bg-card px-3 py-2.5 text-left disabled:cursor-default ${open === t.key ? "ring-2 ring-inset ring-brand-500" : t.value ? "hover:bg-muted/50" : ""}`}>
            <div className="text-[11px] text-muted-foreground leading-tight">{t.label}</div>
            <div className={`text-xl font-semibold tabular-nums ${t.warn ? "text-warning-700 dark:text-warning-500" : "text-foreground"}`}>{t.value}</div>
            {t.sub && <div className="text-[11px] text-muted-foreground tabular-nums">{t.sub}</div>}
          </button>
        ))}
      </div>
      {open && <ul className="px-4 py-2 text-sm max-h-80 overflow-y-auto">{list()}</ul>}
    </div>
  );
}
