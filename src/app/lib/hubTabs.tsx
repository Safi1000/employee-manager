import { createContext, useContext } from "react";

/**
 * A TabHub's tabs, offered to the active child's page band. The child's
 * <Header> renders them inside the band (so the hub's "which screen" switch
 * sits on the same command surface as the page title) and claims them; the
 * hub then hides its own fallback strip. A child that renders no Header never
 * claims, and the hub keeps showing its strip — nothing is lost.
 */
export type HubTabsValue = {
  tabs: { key: string; label: string }[];
  active: string | undefined;
  select: (key: string) => void;
  /** Called by the Header that renders these tabs; returns the release. */
  claim: () => () => void;
};

export const HubTabsContext = createContext<HubTabsValue | null>(null);

export const useHubTabs = () => useContext(HubTabsContext);

/** The hub's segmented switch. Token based, so it reads on paper and in the band. */
export function HubStrip({ tabs, active, onSelect }: { tabs: { key: string; label: string }[]; active: string | undefined; onSelect: (k: string) => void }) {
  return (
    <div className="inline-flex gap-1 flex-wrap p-1 rounded-xl bg-muted border border-border/60 max-w-full" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onSelect(t.key)}
          className={`px-3.5 md:px-4 py-1.5 md:py-2 rounded-lg text-sm min-h-9 md:min-h-10 transition-all ${
            active === t.key
              ? "bg-card text-foreground font-semibold shadow-[0_1px_3px_rgba(0,0,0,0.25)]"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
