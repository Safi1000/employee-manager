import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { pageMemory } from "../../lib/pageState";
import { HubStrip, HubTabsContext, type HubTabsValue } from "../../lib/hubTabs";

// Lightweight tabbed container used by the consolidation restructure to present
// several previously-separate panels as one home (UI-level merge; underlying
// pages/tables are untouched). Each child keeps its own Header + actions; the
// hub offers its tabs to that Header (HubTabsContext), which draws them inside
// the page band. A child with no Header leaves them unclaimed and the hub draws
// its own strip instead. Deep-linkable via ?tab=<key>.
export type HubTab = { key: string; label: string; render: () => ReactNode };

export default function TabHub({
  tabs,
  defaultTab,
}: {
  tabs: HubTab[];
  defaultTab?: string;
}) {
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();
  // The URL names the tab when it can (?tab=…, deep links). A plain link to the
  // page — the sidebar — carries none, so fall back to the tab last used here
  // this session (2026-10-05, app-wide persistent state).
  const remembered = pageMemory.get<string>(`tabhub:${pathname}`);
  const requested = params.get("tab") ?? remembered;
  const active =
    tabs.find((t) => t.key === requested)?.key ??
    defaultTab ??
    tabs[0]?.key;
  useEffect(() => { if (active) pageMemory.set(`tabhub:${pathname}`, active); }, [pathname, active]);

  const select = useCallback((key: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", key);
    setParams(next, { replace: true });
  }, [params, setParams]);

  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);

  const tabKeys = tabs.map((t) => `${t.key}:${t.label}`).join("|");
  const value = useMemo<HubTabsValue>(
    () => ({ tabs: tabs.map(({ key, label }) => ({ key, label })), active, select, claim }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabKeys, active, select, claim],
  );

  // The layout shell is a `flex flex-col overflow-hidden` column, and each child
  // page scrolls itself via `flex-1 overflow-y-auto`. This container has to keep
  // that height chain intact (`flex-1 min-h-0` + column) or the child scroller
  // has no bounded height and its overflow is silently clipped by the shell —
  // which is what left Payroll unscrollable. `overflow-y-auto` on the pane is the
  // fallback for any child that isn't its own scroller.
  return (
    <HubTabsContext.Provider value={value}>
      <div className="flex-1 flex flex-col min-h-0">
        {claims === 0 && (
          <div className="px-3 md:px-8 pt-3 md:pt-4 flex-shrink-0">
            <HubStrip tabs={value.tabs} active={active} onSelect={select} />
          </div>
        )}
        {tabs.map((t) =>
          active === t.key ? (
            <div key={t.key} className="flex-1 flex flex-col min-h-0 overflow-y-auto">
              {t.render()}
            </div>
          ) : null,
        )}
      </div>
    </HubTabsContext.Provider>
  );
}
