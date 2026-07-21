import { ReactNode } from "react";
import ThemeToggle from "./ThemeToggle";

interface HeaderProps {
  title: string;
  /** Optional small subtitle rendered under the title. */
  subtitle?: string;
  actions?: ReactNode;
}

export default function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    <div className="sticky top-0 z-20 bg-card/85 backdrop-blur border-b border-border px-4 md:px-8 py-3 md:py-2.5 md:min-h-16 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg md:text-xl font-bold tracking-tight text-foreground truncate">{title}</h2>
        {subtitle && (
          <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
        )}
      </div>
      <div className="flex items-center gap-2 md:gap-3 flex-wrap">
        {actions}
        <ThemeToggle />
      </div>
    </div>
  );
}
