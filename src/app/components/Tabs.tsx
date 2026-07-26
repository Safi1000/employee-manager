import type { ReactNode } from "react";

// Canonical tab control for the whole app — a segmented amber-pill group matching
// the flagship Employees All/Active/Fired switch. Use for primary section nav so
// every page's tabs look identical (replaces the old ad-hoc border-b underline
// bars). Fully theme-token based, so it follows light/dark automatically.

export type TabItem<T extends string> = {
  value: T;
  label: ReactNode;
  count?: number;
};

export default function Tabs<T extends string>({
  items,
  value,
  onChange,
  size = "md",
  className,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const pad = size === "sm" ? "px-2.5 py-1" : "px-3 py-1.5";
  return (
    <div className={`inline-flex flex-wrap items-center gap-1.5 ${className ?? ""}`} role="tablist">
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.value)}
            className={`inline-flex items-center gap-1.5 rounded-md border text-sm transition-colors ${pad} ${
              active
                ? "border-brand-500 bg-brand-500/15 text-brand-700 dark:text-brand-500 font-medium"
                : "border-border text-muted-foreground hover:bg-accent"
            }`}
          >
            {it.label}
            {it.count != null && (
              <span
                className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full ${
                  active ? "bg-brand-500 text-[#241a06]" : "bg-secondary text-muted-foreground"
                }`}
              >
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
