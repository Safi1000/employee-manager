import { ReactNode } from "react";

interface HeaderProps {
  /** A string renders as the page heading; a node (e.g. a dropdown) replaces it. */
  title: ReactNode;
  /** Optional small subtitle rendered under the title. */
  subtitle?: string;
  actions?: ReactNode;
}

export default function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    // Fully opaque on mobile, translucent-with-blur from `md` up. `backdrop-blur`
    // is unreliable and expensive in an Android WebView: where it fails the
    // header renders as a semi-transparent pane with the table scrolling
    // visibly through it, which is what made the heading look washed out.
    // Desktop keeps the original frosted treatment.
    <div className="sticky top-0 z-20 bg-card md:bg-card/85 md:backdrop-blur border-b border-border px-3 md:px-8 py-3 md:py-2.5 md:min-h-16 flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-3">
      <div className="min-w-0">
        <h2 className="text-lg md:text-xl font-bold tracking-tight text-foreground truncate">{title}</h2>
        {subtitle && (
          <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
        )}
      </div>
      {/* The light/dark toggle lives in the layout's top bar, not here — page
          headers hold page actions only. */}
      <div className="flex items-center gap-2 md:gap-3 flex-wrap">{actions}</div>
    </div>
  );
}
