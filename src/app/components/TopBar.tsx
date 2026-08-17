import { ReactNode } from "react";
import { Menu } from "lucide-react";
import ThemeToggle from "./ThemeToggle";

/**
 * Persistent app-level bar above the page header. Holds account-wide controls
 * (menu, region scope, light/dark) so they sit in the same place on every page
 * and never mix with a page's own action buttons.
 *
 * On mobile this bar also owns the nav menu button. It used to be a `fixed`
 * button floating over the page content, which meant every layout had to
 * reserve a strip of blank space for it (`pt-14`) and it still collided with
 * whatever a page put in its top-left corner. Sitting in the bar, it takes part
 * in normal layout and cannot overlap anything.
 */
export default function TopBar({ children }: { children?: ReactNode }) {
  return (
    <div className="flex-shrink-0 border-b border-border bg-card px-2 md:px-8 py-1.5 flex items-center gap-2 md:gap-3 min-h-12">
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("sidebar:open"))}
        // 44px square: the minimum comfortable thumb target on both platforms,
        // and the same size as ThemeToggle so the bar's two ends match.
        className="md:hidden flex-shrink-0 w-11 h-11 -ml-1 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent transition-colors"
        aria-label="Open navigation menu"
      >
        <Menu className="w-5 h-5" strokeWidth={2} />
      </button>
      <div className="flex-1 min-w-0 flex items-center gap-3">{children}</div>
      <ThemeToggle className="flex-shrink-0" />
    </div>
  );
}
