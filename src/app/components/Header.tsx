import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useAuth } from "../lib/auth";
import { sectionOf } from "../lib/navMeta";
import { HubStrip, useHubTabs } from "../lib/hubTabs";
import { Link } from "react-router";
import { supabase } from "../lib/supabase";

/** Pages whose records the audit log covers, by the route's first segment. */
const CHANGE_TABLES: Record<string, string[]> = {
  invoices: ["invoices", "invoice_payments"],
  expenses: ["expenses", "advances", "fixed_expenses"],
  employees: ["employees"],
  assignments: ["employees", "deployments"],
  clients: ["clients", "contracts"],
  contracts: ["contracts", "contract_lines", "contract_addendums"],
  payroll: ["payslips"],
  accounting: ["bank_accounts", "cheques", "cash_deposits", "cash_locations"],
  incidents: ["incidents"],
  "access-governance": ["profiles"],
};

interface HeaderProps {
  /** A string renders as the page heading; a node (e.g. a dropdown) replaces it. */
  title: ReactNode;
  /** Optional line rendered under the title. */
  subtitle?: string;
  actions?: ReactNode;
  /** The tracked caps line above the title. Defaults to "<section> · <company>". */
  kicker?: ReactNode;
  /** Shows the amber live dot beside the kicker (pages that update on their own). */
  live?: boolean;
  /** Content inside the band, under the title row — headline figures, filters. */
  children?: ReactNode;
}

/**
 * The page band: every page opens on the same dark command surface — kicker,
 * display title, page actions — so the frame reads as one instrument and the
 * paper below it reads as the work. Children placed here (headline tiles,
 * basis switches) inherit the .on-dark palette, so ordinary Buttons, selects
 * and Badges render correctly on it without dark-specific classes.
 */
export default function Header({ title, subtitle, actions, kicker, live, children }: HeaderProps) {
  const { pathname } = useLocation();
  const { company, profile } = useAuth();
  const section = sectionOf(pathname);
  const companyName = profile?.display_company_name || company?.name || null;
  const auto = [section, companyName].filter(Boolean).join(" · ");
  const line = kicker ?? (auto || null);

  // WHAT CHANGED SINCE YOU LAST LOOKED (2026-10-21). For pages about records
  // the audit log covers, count the changes other people made since this user
  // last opened the page (the visit time is kept in this browser). Only for
  // those who can open the Audit Log, which is where the chip leads.
  const [changed, setChanged] = useState<{ n: number; since: string } | null>(null);
  useEffect(() => {
    const tables = CHANGE_TABLES[pathname.split("/").filter(Boolean).slice(1, 2)[0] ?? ""];
    const role = profile?.role;
    if (!tables || !profile?.id || (role !== "super_admin" && role !== "super_super_admin")) { setChanged(null); return; }
    const key = `lastSeen:${profile.id}:${pathname}`;
    let since: string | null = null;
    try { since = localStorage.getItem(key); localStorage.setItem(key, new Date().toISOString()); } catch { /* no storage: no chip */ }
    if (!since) { setChanged(null); return; }
    let cancelled = false;
    void supabase.from("audit_log").select("id", { count: "exact", head: true })
      .in("table_name", tables).gt("changed_at", since).neq("changed_by", profile.id)
      .then(({ count, error }) => { if (!cancelled) setChanged(!error && count ? { n: count, since } : null); });
    return () => { cancelled = true; };
  }, [pathname, profile?.id, profile?.role]);

  // Inside a TabHub, draw the hub's switch in the band and tell the hub so it
  // drops its own strip. Layout effect: the claim lands before paint, so the
  // fallback strip never flashes.
  const hub = useHubTabs();
  const claim = hub?.claim;
  useLayoutEffect(() => (claim ? claim() : undefined), [claim]);

  // THE FOLD, tied to the scroll (2026-10-21). A band carrying figures shrinks
  // pixel for pixel as the page scrolls — 50px of scroll, 50px less band — until
  // only its title row is left, and grows back the same way. Nothing in the page
  // moves to make room: the band keeps its full height in the layout and is
  // CLIPPED from the bottom, and the list slides up underneath it. So there is
  // no jump (the old fold waited ~120px, then dropped the band's height out from
  // under the list) and no re-layout per frame (clip-path is paint only).
  //
  // The scroller is whichever element around the band scrolls:
  //   inside   the band's parent — the band is sticky in it, content passes under
  //   beside   a sibling below it — the sibling is slid up under the band (negative
  //            margin) and keeps its content clear of it (padding of the same height)
  const wrapRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const figRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    if (!children) return;
    const el = wrapRef.current, band = bandRef.current, fig = figRef.current;
    const parent = el?.parentElement;
    if (!el || !band || !fig || !parent) return;
    const scrolls = (n: Element) => /(auto|scroll)/.test(getComputedStyle(n).overflowY);
    const inside = scrolls(parent);
    const targets = (inside ? [parent] : Array.from(parent.children).filter((c) => c !== el && scrolls(c))) as HTMLElement[];
    if (targets.length === 0) return;
    const beside = inside ? null : targets[0];
    const saved = beside ? { marginTop: beside.style.marginTop, paddingTop: beside.style.paddingTop } : null;
    const basePad = beside ? parseFloat(getComputedStyle(beside).paddingTop) || 0 : 0;

    let collapsible = 0;
    let frame = 0;
    const apply = () => {
      const top = Math.max(...targets.map((t) => t.scrollTop));
      const x = Math.min(collapsible, Math.max(0, top));
      el.style.setProperty("--fold", `${x}px`);
      el.style.setProperty("--fold-p", String(collapsible ? x / collapsible : 0));
      setFolded(collapsible > 0 && x >= collapsible - 1);
    };
    const measure = () => {
      const gap = parseFloat(getComputedStyle(band).rowGap) || 0;
      collapsible = fig.offsetHeight + gap;
      el.style.setProperty("--band-r", getComputedStyle(band).borderBottomLeftRadius || "22px");
      if (beside) {
        const h = el.offsetHeight;
        beside.style.marginTop = `-${h}px`;
        beside.style.paddingTop = `${basePad + h}px`;
      }
      apply();
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; apply(); });
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el); ro.observe(fig);
    targets.forEach((t) => t.addEventListener("scroll", onScroll, { passive: true }));
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      targets.forEach((t) => t.removeEventListener("scroll", onScroll));
      if (beside && saved) { beside.style.marginTop = saved.marginTop; beside.style.paddingTop = saved.paddingTop; }
      el.style.removeProperty("--fold");
    };
  }, [children ? 1 : 0]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // Fully opaque wrapper: the page scroller sits below the band, and in an
    // Android WebView a translucent sticky layer lets the table show through.
    <div ref={wrapRef} className="page-band sticky top-0 z-20 bg-background px-3 md:px-8 pt-3 md:pt-5 pb-1 md:pb-2 flex-shrink-0"
      style={children ? { clipPath: "inset(0 0 var(--fold, 0px) 0)" } : undefined}>
      <div ref={bandRef} className="band on-dark rounded-2xl md:rounded-[22px] px-4 md:px-7 py-3.5 md:py-5 flex flex-col gap-3 md:gap-4 overflow-hidden"
        style={children ? { clipPath: "inset(0 0 var(--fold, 0px) 0 round var(--band-r, 22px))" } : undefined}>
        {hub && hub.tabs.length > 1 && (
          <div className="-mx-1 overflow-x-auto">
            <HubStrip tabs={hub.tabs} active={hub.active} onSelect={hub.select} />
          </div>
        )}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
          <div className="min-w-0">
            {line && (
              <div className="flex items-center gap-2 mb-1 md:mb-1.5 min-w-0">
                {live && <span className="live-dot w-2 h-2 rounded-full bg-brand-500 flex-shrink-0" aria-hidden="true" />}
                <span className="lbl truncate">{line}</span>
                {changed && (
                  <Link to="/super-admin/audit-log" title={`Changes others made since ${new Date(changed.since).toLocaleString()}`}
                    className="ml-1 flex-shrink-0 rounded-full border border-brand-500/50 px-2 py-0.5 text-[10px] font-semibold text-brand-500 hover:bg-brand-500/10">
                    {changed.n} change{changed.n === 1 ? "" : "s"} since you last looked
                  </Link>
                )}
              </div>
            )}
            <h1 className="font-display text-xl md:text-[30px] font-extrabold tracking-tight text-foreground leading-tight truncate">{title}</h1>
            {subtitle && <p className="text-xs md:text-sm text-muted-foreground mt-1 line-clamp-2">{subtitle}</p>}
          </div>
          {/* The light/dark toggle lives in the layout's top bar, not here —
              page headers hold page actions only. */}
          {actions && <div className="flex items-center gap-2 md:gap-2.5 flex-wrap">{actions}</div>}
        </div>
        {children && (
          // The figures fade and lift slightly as the band closes over them.
          <div
            ref={figRef}
            aria-hidden={folded || undefined}
            style={{ opacity: "calc(1 - var(--fold-p, 0) * 1.15)", transform: "translateY(calc(var(--fold-p, 0) * -6px))" }}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
