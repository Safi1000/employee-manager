import { type ReactNode } from "react";
import { useSearchParams } from "react-router";

// Lightweight tabbed container used by the consolidation restructure to present
// several previously-separate panels as one home (UI-level merge; underlying
// pages/tables are untouched). Each child keeps its own sticky Header + actions;
// this only renders a slim tab strip above the active child and switches which
// one mounts. Deep-linkable via ?tab=<key>.
export type HubTab = { key: string; label: string; render: () => ReactNode };

export default function TabHub({
  tabs,
  defaultTab,
}: {
  tabs: HubTab[];
  defaultTab?: string;
}) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const active =
    tabs.find((t) => t.key === requested)?.key ??
    defaultTab ??
    tabs[0]?.key;

  // The layout shell is a `flex flex-col overflow-hidden` column, and each child
  // page scrolls itself via `flex-1 overflow-y-auto`. This container has to keep
  // that height chain intact (`flex-1 min-h-0` + column) or the child scroller
  // has no bounded height and its overflow is silently clipped by the shell —
  // which is what left Payroll unscrollable. `overflow-y-auto` on the pane is the
  // fallback for any child that isn't its own scroller.
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 md:px-8 pt-3 flex-shrink-0">
        <div className="flex gap-2 flex-wrap">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("tab", t.key);
                setParams(next, { replace: true });
              }}
              className={`px-4 py-2 rounded-md text-sm transition-colors ${
                active === t.key
                  ? "bg-brand-600 text-[#fff]"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {tabs.map((t) =>
        active === t.key ? (
          <div key={t.key} className="flex-1 flex flex-col min-h-0 overflow-y-auto">
            {t.render()}
          </div>
        ) : null,
      )}
    </div>
  );
}
