import { useState, useEffect } from "react";
import { NavLink, useLocation } from "react-router";
import { LucideIcon, LogOut, Menu, X, KeyRound, ChevronRight } from "lucide-react";
import { useAuth } from "../lib/auth";
import ForcePasswordChange from "./ForcePasswordChange";
import ChangePasswordModal from "./ChangePasswordModal";

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
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => loadExpanded());

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
      if (variant === "section") {
        return (
          <SidebarSection
            key={item.basePath}
            group={item}
            depth={depth}
            renderItem={renderItem}
          />
        );
      }
      const isAnyChildActive = anyChildActive(item, location.pathname);
      const isOpen =
        item.basePath in expanded ? expanded[item.basePath] : isAnyChildActive;
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
          `flex items-center gap-3 px-4 py-2.5 rounded-md text-sm transition-colors ${
            isActive
              ? "bg-brand-50 text-brand-700 border-l-2 border-brand-600"
              : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
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

  const footer = (
    <div className="p-4 border-t border-slate-200 space-y-2">
      {profile?.email && (
        <div className="px-4 text-xs text-slate-500 truncate" title={profile.email}>
          {profile.full_name ?? profile.email}
        </div>
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
        className={`md:hidden fixed inset-y-0 left-0 z-50 w-72 bg-white border-r border-slate-200 flex flex-col transform transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="h-16 px-6 flex items-center justify-between border-b border-slate-200">
          <h1 className="text-lg text-slate-900 truncate">{title}</h1>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1 text-slate-500 hover:text-slate-900"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>
        {navItems}
        {footer}
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 bg-white border-r border-slate-200 flex-col">
        <div className="h-16 px-6 flex items-center border-b border-slate-200">
          <h1 className="text-lg text-slate-900 truncate">{title}</h1>
        </div>
        {navItems}
        {footer}
      </aside>

      <ForcePasswordChange />
      <ChangePasswordModal isOpen={pwModalOpen} onClose={() => setPwModalOpen(false)} />
    </>
  );
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
  renderItem,
}: {
  group: SidebarGroup;
  depth: number;
  renderItem: (item: SidebarItem, depth: number) => React.ReactNode;
}) {
  return (
    <div className={depth === 0 ? "pt-3 first:pt-0" : ""}>
      <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-400">
        {group.label}
      </div>
      <div className="space-y-1">
        {group.children.map((child) => renderItem(child, depth + 1))}
      </div>
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
