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
  icon: LucideIcon;
  basePath: string;
  children: SidebarLink[];
};

export type SidebarItem = SidebarLink | SidebarGroup;

interface SidebarProps {
  title: string;
  links: SidebarItem[];
}

export default function Sidebar({ title, links }: SidebarProps) {
  const { profile, signOut } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [pwModalOpen, setPwModalOpen] = useState(false);

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

  const handleSignOut = async () => {
    await signOut();
    setOpen(false);
  };

  const navItems = (
    <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
      {links.map((item) => {
        if ("type" in item && item.type === "group") {
          return (
            <SidebarGroupNode
              key={item.basePath}
              group={item}
              activePath={location.pathname}
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
      })}
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

function SidebarGroupNode({ group, activePath }: { group: SidebarGroup; activePath: string }) {
  const isAnyChildActive = group.children.some((c) => activePath.startsWith(c.to));
  const [expanded, setExpanded] = useState(isAnyChildActive);
  useEffect(() => {
    if (isAnyChildActive) setExpanded(true);
  }, [isAnyChildActive]);
  const Icon = group.icon;
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-md text-sm transition-colors ${
          isAnyChildActive ? "text-slate-900" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
        }`}
      >
        <Icon className="w-4 h-4" strokeWidth={1.5} />
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronRight
          className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
          strokeWidth={1.5}
        />
      </button>
      {expanded && (
        <div className="ml-5 pl-2 border-l border-slate-200 mt-0.5 space-y-1">
          {group.children.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-brand-50 text-brand-700"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`
              }
            >
              <child.icon className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span>{child.label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
