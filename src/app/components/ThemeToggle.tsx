import { Moon, Sun } from "lucide-react";
import { useMode } from "../lib/mode";

/** Light/dark toggle. Small, icon-only; sits in the top bar on every page. */
export default function ThemeToggle({ className = "" }: { className?: string }) {
  const { mode, toggle } = useMode();
  const isDark = mode === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:border-brand-500/50 transition-colors ${className}`}
    >
      {isDark ? <Sun className="h-4 w-4" strokeWidth={1.75} /> : <Moon className="h-4 w-4" strokeWidth={1.75} />}
    </button>
  );
}
