import { ReactNode, useLayoutEffect } from "react";
import { useLocation } from "react-router";
import { useAuth } from "../lib/auth";
import { sectionOf } from "../lib/navMeta";
import { HubStrip, useHubTabs } from "../lib/hubTabs";

interface HeaderProps {
  /** A string renders as the page heading; a node (e.g. a dropdown) replaces it. */
  title: ReactNode;
  /** Optional line rendered under the title. */
  subtitle?: string;
  actions?: ReactNode;
  /** The tracked caps line above the title. Defaults to "<section> · <company>". */
  kicker?: ReactNode;
  /** Shows the amber live dot beside the kicker (pages that update on their own). */
  live?: boolean;
  /** Content inside the band, under the title row — headline figures, filters. */
  children?: ReactNode;
}

/**
 * The page band: every page opens on the same dark command surface — kicker,
 * display title, page actions — so the frame reads as one instrument and the
 * paper below it reads as the work. Children placed here (headline tiles,
 * basis switches) inherit the .on-dark palette, so ordinary Buttons, selects
 * and Badges render correctly on it without dark-specific classes.
 */
export default function Header({ title, subtitle, actions, kicker, live, children }: HeaderProps) {
  const { pathname } = useLocation();
  const { company, profile } = useAuth();
  const section = sectionOf(pathname);
  const companyName = profile?.display_company_name || company?.name || null;
  const auto = [section, companyName].filter(Boolean).join(" · ");
  const line = kicker ?? (auto || null);

  // Inside a TabHub, draw the hub's switch in the band and tell the hub so it
  // drops its own strip. Layout effect: the claim lands before paint, so the
  // fallback strip never flashes.
  const hub = useHubTabs();
  const claim = hub?.claim;
  useLayoutEffect(() => (claim ? claim() : undefined), [claim]);

  return (
    // Fully opaque wrapper: the page scroller sits below the band, and in an
    // Android WebView a translucent sticky layer lets the table show through.
    <div className="sticky top-0 z-20 bg-background px-3 md:px-8 pt-3 md:pt-5 pb-1 md:pb-2 flex-shrink-0">
      <div className="band on-dark rounded-2xl md:rounded-[22px] px-4 md:px-7 py-3.5 md:py-5 flex flex-col gap-3 md:gap-4 overflow-hidden">
        {hub && hub.tabs.length > 1 && (
          <div className="-mx-1 overflow-x-auto">
            <HubStrip tabs={hub.tabs} active={hub.active} onSelect={hub.select} />
          </div>
        )}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
          <div className="min-w-0">
            {line && (
              <div className="flex items-center gap-2 mb-1 md:mb-1.5 min-w-0">
                {live && <span className="live-dot w-2 h-2 rounded-full bg-brand-500 flex-shrink-0" aria-hidden="true" />}
                <span className="lbl truncate">{line}</span>
              </div>
            )}
            <h1 className="font-display text-xl md:text-[30px] font-extrabold tracking-tight text-foreground leading-tight truncate">{title}</h1>
            {subtitle && <p className="text-xs md:text-sm text-muted-foreground mt-1 line-clamp-2">{subtitle}</p>}
          </div>
          {/* The light/dark toggle lives in the layout's top bar, not here —
              page headers hold page actions only. */}
          {actions && <div className="flex items-center gap-2 md:gap-2.5 flex-wrap">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}
