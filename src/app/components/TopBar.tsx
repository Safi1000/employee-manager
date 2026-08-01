import { ReactNode } from "react";
import ThemeToggle from "./ThemeToggle";

/**
 * Persistent app-level bar above the page header. Holds account-wide controls
 * (region scope, light/dark) so they sit in the same place on every page and
 * never mix with a page's own action buttons.
 */
export default function TopBar({ children }: { children?: ReactNode }) {
  return (
    <div className="flex-shrink-0 border-b border-border bg-card px-4 md:px-8 py-1.5 flex items-center gap-3 min-h-11">
      <div className="flex-1 min-w-0 flex items-center gap-3">{children}</div>
      <ThemeToggle className="flex-shrink-0" />
    </div>
  );
}
