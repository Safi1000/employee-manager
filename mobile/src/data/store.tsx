// The one data seam. Screens read `db` and write through `commit()`.
//
// Demo mode (no Supabase env): `db` is the in-memory fixture set; writes stay on
// this device.
//
// Live mode: `db` starts EMPTY — never the fixtures, which would put invented
// guards and balances in front of a real user — and is filled from the database
// by live.ts once someone signs in. `commit()` cannot persist anything in live
// mode, so it refuses: it says so in a toast and swallows the screen's own
// "saved" toast from the same tap, because a success message for a write that
// never happened is the one outcome worse than no feature. The writes that ARE
// wired (site confirmation, daily notes) call live.ts directly and then reload.
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import * as seed from "./seed";
import type { AttStatus, Shift } from "./seed";
import { loadLive } from "./live";
import { useAuth } from "../lib/auth";
import { isLive } from "../lib/supabase";

type Extra = {
  attOverride: Record<string, AttStatus>; // `${employeeId}|${date}`
  reportOverride: Record<string, "awaiting" | "reported" | "confirmed">; // `${siteId}|${shift}|${date}`
  shiftOverride: Record<string, Shift>;
  // live mode only
  attLive: Record<string, AttStatus>;
  confLive: Record<string, true>;
  attFrom: string;
  companyId: string | null;
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type DB = Mutable<typeof seed> & Extra;

const liveExtra = { attLive: {}, confLive: {}, attFrom: "", companyId: null };

/** Every collection emptied: arrays → [], maps → {}. Functions (pure helpers) are kept. */
function emptyDB(): DB {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(seed)) {
    out[k] = Array.isArray(v) ? [] : v && typeof v === "object" ? {} : v;
  }
  out.company = { id: "", name: "Bastion", short: "B", plan: "", guard_cap: 0 };
  return { ...(out as Mutable<typeof seed>), attOverride: {}, reportOverride: {}, shiftOverride: {}, ...liveExtra };
}

const db: DB = emptyDB();

// ---------- live-mode write refusal ----------
export const NOT_IN_APP = "Not saved — this action isn't available in the app yet. Use the web app.";
let toastSink: ((text: string, tone?: any) => void) | null = null;
let swallowUntilTick = false;
/** OverlayProvider registers its toast here so the store can speak. */
export function registerToastSink(fn: typeof toastSink) { toastSink = fn; }
/** True when a success toast in this tick belongs to a refused write. */
export function shouldSwallowToast(tone: string | undefined) {
  return swallowUntilTick && tone !== "danger";
}

type Ctx = {
  db: DB;
  v: number;
  commit: (fn: (db: DB) => void) => void;
  /** Live mode: re-read the database. Demo mode: no-op. */
  reload: () => Promise<void>;
  /**
   * Run a real write, then re-read the database and report the outcome. Resolves
   * true on success, false on failure (the database's own message is toasted).
   * Screens close their sheet only on true, so a refused write keeps the form.
   */
  act: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
  loading: boolean;
  error: string | null;
};
const DataCtx = createContext<Ctx | null>(null);

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [v, setV] = useState(0);
  const [loading, setLoading] = useState(isLive);
  const [error, setError] = useState<string | null>(null);
  const { profile } = useAuth();

  const reload = useCallback(async () => {
    if (!isLive || !profile) return;
    setLoading(true);
    setError(null);
    try {
      const data = await loadLive(profile);
      Object.assign(db, emptyDB(), data);
      setV((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile]);

  // Load on sign-in, clear on sign-out. Deferred a tick so the state changes
  // land from a callback rather than the effect body.
  useEffect(() => {
    if (!isLive) return;
    const h = setTimeout(() => {
      if (profile) void reload();
      else { Object.assign(db, emptyDB()); setV((x) => x + 1); }
    }, 0);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  const commit = useCallback((fn: (d: DB) => void) => {
    if (isLive) {
      swallowUntilTick = true;
      setTimeout(() => { swallowUntilTick = false; }, 0);
      toastSink?.(NOT_IN_APP, "danger");
      return;
    }
    fn(db);
    setV((x) => x + 1);
  }, []);

  const act = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
    } catch (e) {
      toastSink?.(e instanceof Error ? e.message : String(e), "danger");
      return false;
    }
    await reload();
    if (ok) toastSink?.(ok);
    return true;
  }, [reload]);

  return <DataCtx.Provider value={{ db, v, commit, reload, act, loading, error }}>{children}</DataCtx.Provider>;
}

export function useDB() {
  const c = useContext(DataCtx);
  if (!c) throw new Error("DataProvider missing");
  return c;
}

// ---------- pure selectors (no DOM, safe to share with web) ----------
export const clientName = (d: DB, id: string | null | undefined) => (id ? d.clients.find((c) => c.id === id)?.name ?? "—" : "Office");
export const siteName = (d: DB, id: string | null | undefined) => (id ? d.sites.find((s) => s.id === id)?.name ?? "—" : "—");
export const employee = (d: DB, id: string) => d.employees.find((e) => e.id === id);

export function attendance(d: DB, empId: string, date: string): AttStatus | null {
  if (isLive) return d.attLive[`${empId}|${date}`] ?? null;
  return d.attOverride[`${empId}|${date}`] ?? seed.statusFor(empId, date);
}

export function reportState(d: DB, siteId: string, shift: Shift, date: string) {
  // The database has no "reported, not yet confirmed" state — a shift is
  // confirmed or it is not.
  if (isLive) return d.confLive[`${siteId}|${shift}|${date}`] ? "confirmed" : "awaiting";
  const o = d.reportOverride[`${siteId}|${shift}|${date}`];
  if (o) return o;
  if (date < seed.TODAY) return "confirmed";
  if (date > seed.TODAY) return "awaiting";
  return d.siteReports.find((r) => r.site_id === siteId && r.shift === shift)?.state ?? "awaiting";
}

export function roster(d: DB, siteId: string, shift: Shift) {
  return d.employees.filter((e) => e.site_id === siteId && (d.shiftOverride[e.id] ?? e.shift) === shift && e.lifecycle === "active");
}

export function receivableFor(d: DB, clientId: string) {
  const inv = d.invoices.filter((i) => i.client_id === clientId);
  const invoiced = inv.reduce((a, i) => a + i.amount, 0);
  const received = inv.reduce((a, i) => a + i.payments.reduce((b, p) => b + p.amount, 0), 0);
  const wht = inv.reduce((a, i) => a + i.payments.reduce((b, p) => b + p.wht, 0), 0);
  const opening = d.openingReceivable[clientId] ?? 0;
  return { opening, invoiced, received, wht, outstanding: opening + invoiced - received - wht };
}

export const invoiceReceived = (i: seed.Invoice) => i.payments.reduce((a, p) => a + p.amount + p.wht, 0);

export function accountBalances(d: DB) {
  const m: Record<string, { debit: number; credit: number }> = {};
  for (const j of d.journal) for (const l of j.lines) {
    m[l.account] ??= { debit: 0, credit: 0 };
    m[l.account]!.debit += l.debit;
    m[l.account]!.credit += l.credit;
  }
  return m;
}

/** lib/custodian.ts loadCustodianOptions: balance text only with banks.view (a data-exposure rule, handoff A5). */
export function custodianOptions(d: DB, canViewBanking: boolean) {
  return d.custodians.filter((c) => c.active).map((c) => ({
    value: c.id,
    label: canViewBanking ? `${c.holder} — holds PKR ${Math.round(c.held).toLocaleString("en-US")}` : c.holder,
    sub: c.location,
  }));
}

export function bankOptions(d: DB, canViewBanking: boolean) {
  return d.banks.map((b) => ({ value: b.id, label: b.name, sub: canViewBanking ? `${b.number} · PKR ${Math.round(b.balance).toLocaleString("en-US")}` : b.number }));
}
