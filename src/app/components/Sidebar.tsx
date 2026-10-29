import { useState, useEffect, useMemo, useRef } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import {
  LucideIcon, LogOut, X, KeyRound, ChevronDown, Search, Pin, Clock, UserRound, LayoutDashboard,
  Building2, Users, Siren, Landmark, ShieldCheck, Settings as SettingsIcon, Folder,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { togglePin, usePinned, useRecent, pushRecent } from "../lib/navPrefs";
import ForcePasswordChange from "./ForcePasswordChange";
import ChangePasswordModal from "./ChangePasswordModal";
import ProfileModal from "./ProfileModal";
import CommandPalette, { type PaletteLink } from "./CommandPalette";

/**
 * NAVIGATION (rebuilt 2026-10-20) — the 256px sidebar and its collapse toggle
 * are gone. On desktop:
 *
 *   Section rail   one icon per section (Overview, Clients, Workforce…). Hover
 *                  or tap opens a flyout with that section's pages; it floats
 *                  over the page, so the page keeps its full width.
 *   ⌘K palette     the search button at the top of the rail, or ⌘K / Ctrl+K
 *                  anywhere: any page, client, guard or invoice.
 *   Pinned/recent  pages pinned from a flyout or the palette sit on the rail;
 *                  the last pages opened sit at the foot of every flyout.
 *
 * A panel with no sections (HR, Accounts, platform) gets its links straight on
 * the rail. Phones keep the slide-in drawer, opened from the top bar.
 */

type SidebarLink = {
  to: string;
  label: string;
  icon: LucideIcon;
};

type SidebarGroup = {
  type: "group";
  label: string;
  icon?: LucideIcon;
  basePath: string;
  // section = a top-level heading (WORKFORCE, FINANCE…): a rail icon on
  //           desktop, a heading in the phone drawer.
  // collapsible = a nested sub-group (Relievers).
  variant?: "section" | "collapsible";
  children: (SidebarLink | SidebarGroup)[];
};

export type SidebarItem = SidebarLink | SidebarGroup;

/** The rail's icon and short name for each section the layouts build. */
const SECTION_META: Record<string, { icon: LucideIcon; short: string }> = {
  Me: { icon: UserRound, short: "Me" },
  Overview: { icon: LayoutDashboard, short: "Overview" },
  "Clients & Contracts": { icon: Building2, short: "Clients" },
  Workforce: { icon: Users, short: "Workforce" },
  Operations: { icon: Siren, short: "Ops" },
  Finance: { icon: Landmark, short: "Finance" },
  "Profit-Share": { icon: Landmark, short: "Profit" },
  Compliance: { icon: ShieldCheck, short: "Comply" },
  Admin: { icon: SettingsIcon, short: "Admin" },
};
const metaOf = (g: SidebarGroup) => SECTION_META[g.label] ?? { icon: g.icon ?? Folder, short: g.label.split(" ")[0] };

/** Bastion shield mark — amber, matches the landing brand. */
function BrandMark() {
  return (
    <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-brand-500 text-on-brand">
      <svg viewBox="0 0 32 32" fill="none" className="h-5 w-5">
        <path d="M16 2.5 4.5 7v8.5c0 6.6 4.7 10.5 11.5 13.3C22.8 25.9 27.5 22 27.5 15.5V7z" stroke="currentColor" strokeWidth="1.8" />
        <path d="M13 15.5a3 3 0 0 1 3-3 3 3 0 0 1 3 3 3 3 0 0 1-3 3M19 16.5a3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}

interface SidebarProps {
  title: string;
  links: SidebarItem[];
  /** What is waiting in each section, keyed by section label (navBadges.ts). */
  badges?: Record<string, { n: number; title: string }>;
}

const isGroup = (it: SidebarItem): it is SidebarGroup => "type" in it && it.type === "group";

function flattenLinks(items: SidebarItem[]): SidebarLink[] {
  const out: SidebarLink[] = [];
  for (const it of items) {
    if (isGroup(it)) out.push(...flattenLinks(it.children));
    else out.push(it);
  }
  return out;
}

/** The link the current path belongs to: exact, else the longest prefix. A
 *  panel's home (/app) only ever matches itself. */
function currentLink(links: SidebarLink[], path: string): SidebarLink | null {
  let best: SidebarLink | null = null;
  for (const l of links) {
    const home = l.to.split("/").filter(Boolean).length === 1;
    const hit = path === l.to || (!home && path.startsWith(l.to + "/"));
    if (hit && (!best || l.to.length > best.to.length)) best = l;
  }
  return best;
}

export default function Sidebar({ title, links, badges = {} }: SidebarProps) {
  const { profile, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pwModalOpen, setPwModalOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  // Which flyout is out: a section's basePath, "account", or null.
  const [fly, setFly] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const pinned = usePinned();
  const recent = useRecent();
  // Per-user company-name override (Settings → Company Profile). Falls back to the
  // real company name passed in. Only affects this user's view.
  const displayTitle = profile?.display_company_name || title;

  const flat = useMemo(() => flattenLinks(links), [links]);
  const here = currentLink(flat, location.pathname);
  const sectionOfLink = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of links) if (isGroup(it)) for (const l of flattenLinks(it.children)) if (!m.has(l.to)) m.set(l.to, it.label);
    return m;
  }, [links]);
  const paletteLinks: PaletteLink[] = useMemo(
    () => flat.filter((l, i) => flat.findIndex((x) => x.to === l.to) === i).map((l) => ({ ...l, section: sectionOfLink.get(l.to) ?? displayTitle })),
    [flat, sectionOfLink, displayTitle],
  );
  const byPath = useMemo(() => new Map(paletteLinks.map((l) => [l.to, l])), [paletteLinks]);

  // Close everything on route change, and remember where we have been.
  useEffect(() => {
    setOpen(false);
    setFly(null);
    if (here) pushRecent(here.to);
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // The mobile menu button lives in TopBar, not here — a window event keeps
  // the two decoupled (they are siblings in the layout tree).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("sidebar:open", onOpen);
    return () => window.removeEventListener("sidebar:open", onOpen);
  }, []);

  // Flyout: Escape or a click anywhere off the rail closes it.
  useEffect(() => {
    if (!fly) return;
    const onDoc = (e: MouseEvent) => { if (railRef.current && !railRef.current.contains(e.target as Node)) setFly(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFly(null); };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); window.removeEventListener("keydown", onKey); };
  }, [fly]);

  // Lock body scroll when drawer open on mobile
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [open]);

  const handleSignOut = async () => {
    await signOut();
    setOpen(false);
  };

  // Hover opens a section after a short pause (so sweeping the pointer across
  // the rail does not flash every flyout); leaving the rail and its flyout
  // closes it. Tapping toggles, for touch screens and for people who click.
  const clearHover = () => { if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; } };
  const hoverOpen = (key: string) => { clearHover(); hoverTimer.current = window.setTimeout(() => setFly(key), fly ? 60 : 160); };
  const hoverClose = () => { clearHover(); hoverTimer.current = window.setTimeout(() => setFly((f) => (f === "account" ? f : null)), 260); };

  const openPalette = () => { setFly(null); setOpen(false); window.dispatchEvent(new Event("palette:open")); };

  const sections = links.filter(isGroup);
  const directLinks = links.filter((l): l is SidebarLink => !isGroup(l));
  const flySection = sections.find((s) => s.basePath === fly) ?? null;
  const pinnedLinks = pinned.map((p) => byPath.get(p)).filter((l): l is PaletteLink => !!l);
  const recentLinks = recent.filter((p) => p !== here?.to).map((p) => byPath.get(p)).filter((l): l is PaletteLink => !!l).slice(0, 4);
  const initials = (profile?.full_name || profile?.email || "?").trim().slice(0, 1).toUpperCase();

  const avatar = (size: string) => (
    <span className={`${size} rounded-full overflow-hidden bg-muted border border-border flex items-center justify-center flex-shrink-0`}>
      {profile?.avatar_url ? <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" /> : <span className="text-xs font-semibold text-muted-foreground">{initials}</span>}
    </span>
  );

  // ---- rail pieces ---------------------------------------------------------

  const railBtn = "w-[60px] rounded-xl flex flex-col items-center justify-center gap-1 py-2 transition-colors";
  const railIdle = "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground";
  const railOn = "bg-sidebar-accent text-brand-500 shadow-[inset_3px_0_0_var(--color-brand-500)]";

  const rail = (
    <nav className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col items-center gap-1 px-2 pb-2" aria-label="Sections">
      <button type="button" onClick={openPalette} title="Search — ⌘K" className={`${railBtn} ${railIdle} mb-1 border border-sidebar-border`}>
        <Search className="w-[18px] h-[18px]" strokeWidth={1.75} />
        <span className="text-[10px] font-semibold leading-none">⌘K</span>
      </button>
      {links.map((item) => {
        if (!isGroup(item)) {
          const l = item;
          const home = l.to.split("/").filter(Boolean).length === 1;
          return (
            <NavLink key={l.to} to={l.to} end={home} title={badges[l.label]?.title ?? (home ? "Dashboard" : l.label)}
              className={({ isActive }) => `relative ${railBtn} ${isActive ? railOn : railIdle}`}>
              {badges[l.label] && (
                // The Home icon's count is the open alerts; tapping the count
                // (not the icon) opens them, since Alerts is not in the menu.
                <span
                  role="link"
                  tabIndex={0}
                  title={`${badges[l.label].title} — open them`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate("/app/alerts"); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); navigate("/app/alerts"); } }}
                  className="absolute top-1 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-down text-ink text-[10px] font-bold leading-[18px] text-center hover:ring-2 hover:ring-brand-500"
                >
                  {badges[l.label].n > 99 ? "99+" : badges[l.label].n}
                </span>
              )}
              <l.icon className="w-[19px] h-[19px]" strokeWidth={1.6} />
              <span className="text-[10px] font-semibold leading-none truncate max-w-full px-0.5">{home ? "Home" : l.label.split(" ")[0]}</span>
            </NavLink>
          );
        }
        const s = item;
        const m = metaOf(s);
        const Icon = m.icon;
        const active = !!here && flattenLinks(s.children).some((l) => l.to === here.to);
        const isOut = fly === s.basePath;
        return (
          <button
            key={s.basePath}
            type="button"
            onClick={() => { clearHover(); setFly(isOut ? null : s.basePath); }}
            onMouseEnter={() => hoverOpen(s.basePath)}
            onMouseLeave={hoverClose}
            aria-expanded={isOut}
            aria-label={badges[s.label] ? `${s.label} — ${badges[s.label].title}` : s.label}
            title={badges[s.label]?.title}
            className={`relative ${railBtn} ${active ? railOn : isOut ? "bg-sidebar-accent text-foreground" : railIdle}`}
          >
            {badges[s.label] && (
              <span className="absolute top-1 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-down text-ink text-[10px] font-bold leading-[18px] text-center">
                {badges[s.label].n > 99 ? "99+" : badges[s.label].n}
              </span>
            )}
            <Icon className="w-[19px] h-[19px]" strokeWidth={1.6} />
            <span className="text-[10px] font-semibold leading-none truncate max-w-full px-0.5">{m.short}</span>
          </button>
        );
      })}
      {pinnedLinks.length > 0 && (
        <>
          <span className="w-8 border-t border-sidebar-border my-1.5" />
          <span className="lbl !text-[9px]">Pinned</span>
          {pinnedLinks.map((l) => (
            <NavLink key={l.to} to={l.to} end title={l.label}
              className={({ isActive }) => `w-11 h-10 rounded-xl flex items-center justify-center transition-colors ${isActive ? railOn : railIdle}`}>
              <l.icon className="w-[17px] h-[17px]" strokeWidth={1.6} />
            </NavLink>
          ))}
        </>
      )}
    </nav>
  );

  const linkRow = (l: SidebarLink) => {
    const isPinned = pinned.includes(l.to);
    const on = here?.to === l.to;
    return (
      <div key={l.to} className="group relative">
        <NavLink
          to={l.to}
          end={l.to.split("/").length === 2}
          className={`flex items-center gap-3 pl-3 pr-10 py-2.5 rounded-xl text-sm transition-colors ${
            on ? "bg-sidebar-accent text-foreground font-semibold shadow-[inset_3px_0_0_var(--color-brand-500)]" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          }`}
        >
          <l.icon className="w-4 h-4 flex-shrink-0" strokeWidth={1.6} />
          <span className="truncate">{l.label}</span>
        </NavLink>
        <button
          type="button"
          onClick={() => togglePin(l.to)}
          title={isPinned ? "Unpin from the rail" : "Pin to the rail"}
          aria-label={isPinned ? `Unpin ${l.label}` : `Pin ${l.label}`}
          className={`absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-opacity ${isPinned ? "text-brand-500" : "text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"} hover:bg-card`}
        >
          <Pin className="w-3.5 h-3.5" fill={isPinned ? "currentColor" : "none"} />
        </button>
      </div>
    );
  };

  const renderFlyChildren = (items: (SidebarLink | SidebarGroup)[]): React.ReactNode =>
    items.map((it) =>
      isGroup(it) ? (
        <div key={it.basePath} className="pt-2">
          <p className="lbl px-3 pb-1">{it.label}</p>
          {renderFlyChildren(it.children)}
        </div>
      ) : linkRow(it),
    );

  const recentStrip = recentLinks.length > 0 && (
    <div className="border-t border-sidebar-border px-4 py-3">
      <p className="lbl flex items-center gap-1.5 mb-2"><Clock className="w-3 h-3" /> Recent</p>
      <div className="flex flex-wrap gap-1.5">
        {recentLinks.map((l) => (
          <NavLink key={l.to} to={l.to} className="inline-flex items-center gap-1.5 rounded-full border border-sidebar-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-sidebar-accent">
            <l.icon className="w-3 h-3" strokeWidth={1.75} />{l.label}
          </NavLink>
        ))}
      </div>
    </div>
  );

  const flyout = fly && (
    <div
      onMouseEnter={clearHover}
      onMouseLeave={hoverClose}
      className="absolute left-full top-0 bottom-0 w-72 bg-sidebar border-r border-sidebar-border shadow-[16px_0_40px_-12px_rgba(0,0,0,0.45)] flex flex-col animate-in fade-in slide-in-from-left-2 duration-150"
    >
      {flySection ? (
        <>
          <div className="px-5 pt-5 pb-3">
            <p className="lbl">{displayTitle}</p>
            <h2 className="font-display text-lg font-bold tracking-tight text-foreground mt-0.5">{flySection.label}</h2>
            {badges[flySection.label] && <p className="mt-1 text-xs text-down">{badges[flySection.label].title}</p>}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3 space-y-0.5">{renderFlyChildren(flySection.children)}</div>
          {pinned.length === 0 && (
            <p className="px-5 pb-3 text-[11px] text-muted-foreground flex items-center gap-1.5"><Pin className="w-3 h-3" /> Pin a page and it stays on the rail.</p>
          )}
          {recentStrip}
        </>
      ) : (
        <>
          <div className="px-5 pt-5 pb-4 flex items-center gap-3">
            {avatar("h-10 w-10")}
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground truncate">{profile?.full_name ?? "Set your name"}</span>
              {profile?.email && <span className="block text-xs text-muted-foreground truncate">{profile.email}</span>}
            </span>
          </div>
          <div className="px-2 space-y-0.5">
            <button onClick={() => { setFly(null); setProfileModalOpen(true); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
              <UserRound className="w-4 h-4" strokeWidth={1.6} /> Edit my profile
            </button>
            <button onClick={() => { setFly(null); setPwModalOpen(true); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
              <KeyRound className="w-4 h-4" strokeWidth={1.6} /> Change password
            </button>
            <button onClick={handleSignOut} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
              <LogOut className="w-4 h-4" strokeWidth={1.6} /> Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );

  // ---- phone drawer (unchanged shape: the full list, by section) -----------

  const [drawerOpenSections, setDrawerOpenSections] = useState<Record<string, boolean>>({});
  const drawerNav = (
    <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
      <button type="button" onClick={openPalette} className="w-full flex items-center gap-3 px-3 py-2.5 mb-2 rounded-xl border border-sidebar-border text-sm text-muted-foreground">
        <Search className="w-4 h-4" strokeWidth={1.75} /> Search pages, clients, guards…
      </button>
      {pinnedLinks.length > 0 && (
        <div className="pb-2">
          <p className="lbl px-3 pt-1 pb-1">Pinned</p>
          {pinnedLinks.map(linkRow)}
        </div>
      )}
      {links.map((it) => {
        if (!isGroup(it)) return linkRow(it);
        const active = !!here && flattenLinks(it.children).some((l) => l.to === here.to);
        const isOpen = drawerOpenSections[it.basePath] ?? true;
        return (
          <div key={it.basePath} className="pt-1">
            <button
              type="button"
              onClick={() => setDrawerOpenSections((p) => ({ ...p, [it.basePath]: !isOpen }))}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-bold uppercase tracking-[0.09em] ${active ? "text-foreground" : "text-muted-foreground"}`}
              aria-expanded={isOpen}
            >
              <span className="flex-1 text-left">{it.label}</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? "" : "-rotate-90"}`} strokeWidth={2} />
            </button>
            {isOpen && <div className="space-y-0.5 mt-0.5 mb-1">{renderFlyChildren(it.children)}</div>}
          </div>
        );
      })}
    </nav>
  );

  const drawerFooter = (
    <div className="p-3 border-t border-sidebar-border space-y-1">
      {profile && (
        <button onClick={() => setProfileModalOpen(true)} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-sidebar-accent text-left" title="Edit my profile">
          {avatar("h-8 w-8")}
          <span className="min-w-0">
            <span className="block text-sm text-foreground truncate">{profile.full_name ?? "Set your name"}</span>
            {profile.email && <span className="block text-xs text-muted-foreground truncate">{profile.email}</span>}
          </span>
        </button>
      )}
      <button onClick={() => setPwModalOpen(true)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
        <KeyRound className="w-4 h-4" strokeWidth={1.5} /> Change Password
      </button>
      <button onClick={handleSignOut} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
        <LogOut className="w-4 h-4" strokeWidth={1.5} /> Sign out
      </button>
    </div>
  );

  return (
    <>
      {/* Mobile backdrop */}
      {open && <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={() => setOpen(false)} />}

      {/* Mobile drawer */}
      <aside
        style={{ paddingTop: "var(--safe-top, 0px)", paddingBottom: "var(--safe-bottom, 0px)" }}
        className={`on-dark md:hidden fixed inset-y-0 left-0 z-50 w-72 bg-sidebar border-r border-sidebar-border flex flex-col transform transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="h-16 px-4 flex items-center justify-between border-b border-sidebar-border flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <BrandMark />
            <h1 className="text-base font-bold tracking-tight text-foreground truncate">{displayTitle}</h1>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="p-1 text-muted-foreground hover:text-foreground" aria-label="Close menu">
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>
        {drawerNav}
        {drawerFooter}
      </aside>

      {/* Desktop: the section rail, with its flyout floating over the page */}
      <aside ref={railRef} className="on-dark hidden md:flex relative z-40 w-[76px] flex-shrink-0 bg-sidebar border-r border-sidebar-border flex-col">
        <NavLink to={flat[0]?.to ?? "/"} end title={`${displayTitle} — Dashboard`} aria-label="Dashboard" className="h-16 flex items-center justify-center flex-shrink-0 hover:opacity-90">
          <BrandMark />
        </NavLink>
        {rail}
        <div className="p-2 border-t border-sidebar-border flex flex-col items-center flex-shrink-0">
          {profile && (
            <button
              type="button"
              onClick={() => setFly(fly === "account" ? null : "account")}
              title={profile.full_name ?? "Account"}
              aria-label="Account"
              className={`w-[60px] h-12 rounded-xl flex items-center justify-center ${fly === "account" ? "bg-sidebar-accent" : "hover:bg-sidebar-accent"}`}
            >
              {avatar("h-8 w-8")}
            </button>
          )}
        </div>
        {flyout}
      </aside>

      <CommandPalette links={paletteLinks} onChangePassword={() => setPwModalOpen(true)} />
      <ForcePasswordChange />
      <ChangePasswordModal isOpen={pwModalOpen} onClose={() => setPwModalOpen(false)} />
      <ProfileModal isOpen={profileModalOpen} onClose={() => setProfileModalOpen(false)} />
    </>
  );
}
