import { useState, useEffect } from "react";
import { NavLink, useLocation } from "react-router";
import { LucideIcon, LogOut, Menu, X } from "lucide-react";
import { useAuth } from "../lib/auth";

interface SidebarProps {
  title: string;
  links: {
    to: string;
    label: string;
    icon: LucideIcon;
  }[];
}

export default function Sidebar({ title, links }: SidebarProps) {
  const { profile, signOut } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);

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
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.to.split("/").length === 2}
          className={({ isActive }) =>
            `flex items-center gap-3 px-4 py-2.5 rounded-md text-sm transition-colors ${
              isActive
                ? "bg-blue-50 text-blue-700 border-l-2 border-blue-600"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            }`
          }
        >
          <link.icon className="w-4 h-4" strokeWidth={1.5} />
          <span>{link.label}</span>
        </NavLink>
      ))}
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
    </>
  );
}
