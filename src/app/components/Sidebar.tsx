import { useState, useEffect } from "react";
import { NavLink, useLocation } from "react-router";
import { LucideIcon, LogOut, Menu, X, KeyRound, ChevronRight, ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useAuth } from "../lib/auth";
import ForcePasswordChange from "./ForcePasswordChange";
import ChangePasswordModal from "./ChangePasswordModal";
import ProfileModal from "./ProfileModal";

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
  // section = spec-style heading (smaller caps, muted, no icon, no chevron).
  //          Default expanded; children always rendered. Used for top-level
  //          groups like WORKFORCE, FINANCE, etc.
  // collapsible = old behaviour: clickable header with chevron and icon.
  //          Used for nested sub-groups like Relievers.
  variant?: "section" | "collapsible";
  children: (SidebarLink | SidebarGroup)[];
};

export type SidebarItem = SidebarLink | SidebarGroup;

/** Bastion shield mark — amber, matches the landing brand. */
function BrandMark() {
  return (
    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-600 dark:text-brand-500">
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
}

const STORAGE_KEY = "sidebar.expandedGroups.v1";

function loadExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveExpanded(state: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota / privacy errors
  }
}

export default function Sidebar({ title, links }: SidebarProps) {
  const { profile, signOut } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [pwModalOpen, setPwModalOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => loadExpanded());
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("sidebar.collapsed.v1") === "1"; } catch { return false; }
  });
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("sidebar.collapsed.v1", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  // Per-user company-name override (Settings → Company Profile). Falls back to the
  // real company name passed in. Only affects this user's view.
  const displayTitle = profile?.display_company_name || title;

  // Close drawer on route change
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Lock body scroll when drawer open on mobile
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [open]);

  const toggleGroup = (basePath: string, isAnyChildActive: boolean) => {
    setExpanded((prev) => {
      // If never toggled, current state = isAnyChildActive (auto-expanded).
      // First click should flip from that.
      const current = basePath in prev ? prev[basePath] : isAnyChildActive;
      const next = { ...prev, [basePath]: !current };
      saveExpanded(next);
      return next;
    });
  };

  const handleSignOut = async () => {
    await signOut();
    setOpen(false);
  };

  const renderItem = (item: SidebarItem, depth: number): React.ReactNode => {
    if ("type" in item && item.type === "group") {
      const variant = item.variant ?? "collapsible";
      const isAnyChildActive = anyChildActive(item, location.pathname);
      const isOpen =
        item.basePath in expanded ? expanded[item.basePath] : isAnyChildActive;
      if (variant === "section") {
        return (
          <SidebarSection
            key={item.basePath}
            group={item}
            depth={depth}
            isOpen={isOpen}
            isAnyChildActive={isAnyChildActive}
            onToggle={() => toggleGroup(item.basePath, isAnyChildActive)}
            renderItem={renderItem}
          />
        );
      }
      return (
        <SidebarCollapsibleGroup
          key={item.basePath}
          group={item}
          depth={depth}
          isOpen={isOpen}
          isAnyChildActive={isAnyChildActive}
          onToggle={() => toggleGroup(item.basePath, isAnyChildActive)}
          renderItem={renderItem}
        />
      );
    }
    const link = item as SidebarLink;
    return (
      <NavLink
        key={link.to}
        to={link.to}
        end={link.to.split("/").length === 2}
        className={({ isActive }) =>
          `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-colors ${
            isActive
              ? "bg-brand-500/15 text-brand-700 dark:text-brand-500 font-medium border-l-2 border-brand-500"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          }`
        }
      >
        <link.icon className="w-4 h-4" strokeWidth={1.5} />
        <span>{link.label}</span>
      </NavLink>
    );
  };

  const navItems = (
    <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
      {links.map((item) => renderItem(item, 0))}
    </nav>
  );

  const initials = (profile?.full_name || profile?.email || "?").trim().slice(0, 1).toUpperCase();
  const footer = (
    <div className="p-4 border-t border-slate-200 space-y-2">
      {profile && (
        <button
          onClick={() => setProfileModalOpen(true)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-50 transition-colors text-left"
          title="Edit my profile"
        >
          <span className="h-8 w-8 rounded-full overflow-hidden bg-slate-100 border border-slate-200 flex items-center justify-center flex-shrink-0">
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-xs text-slate-500">{initials}</span>
            )}
          </span>
          <span className="min-w-0">
            <span className="block text-sm text-slate-800 truncate">{profile.full_name ?? "Set your name"}</span>
            {profile.email && <span className="block text-xs text-slate-500 truncate">{profile.email}</span>}
          </span>
        </button>
      )}
      <button
        onClick={() => setPwModalOpen(true)}
        className="w-full flex items-center gap-3 px-4 py-2.5 rounded-md text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
      >
        <KeyRound className="w-4 h-4" strokeWidth={1.5} />
        <span>Change Password</span>
      </button>
      <button
        onClick={handleSignOut}
        className="w-full flex items-center gap-3 px-4 py-2.5 rounded-md text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
      >
        <LogOut className="w-4 h-4" strokeWidth={1.5} />
        <span>Sign out</span>
      </button>
    </div>
  );

  // Collapsed desktop rail: flat list of leaf links as icons only.
  const flatLinks = flattenLinks(links);
  const collapsedNav = (
    <nav className="flex-1 py-3 px-2 space-y-1 overflow-y-auto flex flex-col items-center">
      <button
        onClick={toggleCollapsed}
        title="Expand sidebar"
        className="w-11 h-10 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors mb-1"
      >
        <PanelLeftOpen className="w-4 h-4" strokeWidth={1.5} />
      </button>
      {flatLinks.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.to.split("/").length === 2}
          title={link.label}
          className={({ isActive }) =>
            `w-11 h-10 rounded-lg flex items-center justify-center transition-colors ${
              isActive
                ? "bg-brand-500/15 text-brand-700 dark:text-brand-500"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`
          }
        >
          <link.icon className="w-[18px] h-[18px]" strokeWidth={1.5} />
        </NavLink>
      ))}
    </nav>
  );
  const collapsedFooter = (
    <div className="p-2 border-t border-sidebar-border flex flex-col items-center gap-1">
      {profile && (
        <button
          onClick={() => setProfileModalOpen(true)}
          title={profile.full_name ?? "Profile"}
          className="w-11 h-10 rounded-lg flex items-center justify-center hover:bg-accent transition-colors"
        >
          <span className="h-7 w-7 rounded-full overflow-hidden bg-muted border border-border flex items-center justify-center">
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-xs text-muted-foreground">{initials}</span>
            )}
          </span>
        </button>
      )}
      <button onClick={() => setPwModalOpen(true)} title="Change password" className="w-11 h-10 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
        <KeyRound className="w-4 h-4" strokeWidth={1.5} />
      </button>
      <button onClick={handleSignOut} title="Sign out" className="w-11 h-10 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
        <LogOut className="w-4 h-4" strokeWidth={1.5} />
      </button>
    </div>
  );

  return (
    <>
      {/* Mobile hamburger (top-left, fixed) */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="md:hidden fixed top-3 left-3 z-30 p-2 rounded-md bg-white border border-slate-200 shadow-sm text-slate-700"
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" strokeWidth={1.5} />
      </button>

      {/* Mobile backdrop */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={`md:hidden fixed inset-y-0 left-0 z-50 w-72 bg-sidebar border-r border-sidebar-border flex flex-col transform transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="h-16 px-4 flex items-center justify-between border-b border-sidebar-border">
          <div className="flex items-center gap-2.5 min-w-0">
            <BrandMark />
            <h1 className="text-base font-bold tracking-tight text-foreground truncate">{displayTitle}</h1>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1 text-muted-foreground hover:text-foreground"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>
        {navItems}
        {footer}
      </aside>

      {/* Desktop sidebar */}
      <aside className={`hidden md:flex ${collapsed ? "w-16" : "w-64"} bg-sidebar border-r border-sidebar-border flex-col transition-[width] duration-200 ease-out`}>
        <div className={`h-16 border-b border-sidebar-border flex items-center ${collapsed ? "justify-center" : "px-4 gap-2.5"}`}>
          <BrandMark />
          {!collapsed && (
            <>
              <h1 className="text-base font-bold tracking-tight text-foreground truncate leading-tight flex-1">{displayTitle}</h1>
              <button
                onClick={toggleCollapsed}
                title="Collapse sidebar"
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
              >
                <PanelLeftClose className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </>
          )}
        </div>
        {collapsed ? collapsedNav : navItems}
        {collapsed ? collapsedFooter : footer}
      </aside>

      <ForcePasswordChange />
      <ChangePasswordModal isOpen={pwModalOpen} onClose={() => setPwModalOpen(false)} />
      <ProfileModal isOpen={profileModalOpen} onClose={() => setProfileModalOpen(false)} />
    </>
  );
}

function flattenLinks(items: SidebarItem[]): SidebarLink[] {
  const out: SidebarLink[] = [];
  for (const it of items) {
    if ("type" in it && it.type === "group") out.push(...flattenLinks(it.children));
    else out.push(it as SidebarLink);
  }
  return out;
}

function anyChildActive(group: SidebarGroup, activePath: string): boolean {
  for (const child of group.children) {
    if ("type" in child && child.type === "group") {
      if (anyChildActive(child, activePath)) return true;
    } else if (activePath.startsWith((child as SidebarLink).to)) {
      return true;
    }
  }
  return false;
}

function SidebarSection({
  group,
  depth,
  isOpen,
  isAnyChildActive,
  onToggle,
  renderItem,
}: {
  group: SidebarGroup;
  depth: number;
  isOpen: boolean;
  isAnyChildActive: boolean;
  onToggle: () => void;
  renderItem: (item: SidebarItem, depth: number) => React.ReactNode;
}) {
  return (
    <div className={depth === 0 ? "pt-2 first:pt-0" : ""}>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-center gap-2 px-4 py-2 rounded-md text-xs uppercase tracking-wider transition-colors ${
          isAnyChildActive
            ? "text-slate-900 bg-slate-100"
            : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
        }`}
        aria-expanded={isOpen}
      >
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronDown
          className={`w-4 h-4 transition-transform ${isOpen ? "" : "-rotate-90"}`}
          strokeWidth={2}
        />
      </button>
      {isOpen && (
        <div className="space-y-0.5 mt-1 mb-1">
          {group.children.map((child) => renderItem(child, depth + 1))}
        </div>
      )}
    </div>
  );
}

function SidebarCollapsibleGroup({
  group,
  depth,
  isOpen,
  isAnyChildActive,
  onToggle,
  renderItem,
}: {
  group: SidebarGroup;
  depth: number;
  isOpen: boolean;
  isAnyChildActive: boolean;
  onToggle: () => void;
  renderItem: (item: SidebarItem, depth: number) => React.ReactNode;
}) {
  const Icon = group.icon;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-md text-sm transition-colors ${
          isAnyChildActive ? "text-slate-900" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
        }`}
      >
        {Icon && <Icon className="w-4 h-4" strokeWidth={1.5} />}
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronRight
          className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
          strokeWidth={1.5}
        />
      </button>
      {isOpen && (
        <div className="ml-5 pl-2 border-l border-slate-200 mt-0.5 space-y-1">
          {group.children.map((child) => renderItem(child, depth + 1))}
        </div>
      )}
    </div>
  );
}
