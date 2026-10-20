import type { ReactNode } from "react";

// Canonical tab control for the whole app — a segmented track: the active tab
// is a raised card on a recessed strip. Use for primary section nav so every
// page's tabs look identical. Fully token based, so it follows light/dark and
// renders correctly inside the dark page band (.on-dark) too.

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
  const pad = size === "sm" ? "px-2.5 py-1 text-xs min-h-8" : "px-3.5 py-1.5 text-sm min-h-9";
  return (
    <div className={`inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-muted border border-border/60 max-w-full ${className ?? ""}`} role="tablist">
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.value)}
            className={`inline-flex items-center gap-1.5 rounded-lg transition-all ${pad} ${
              active
                ? "bg-card text-foreground font-semibold shadow-[0_1px_3px_rgba(40,30,10,0.14)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {it.label}
            {it.count != null && (
              <span
                className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold rounded-full ${
                  active ? "bg-brand-500 text-on-brand" : "bg-background text-muted-foreground"
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
