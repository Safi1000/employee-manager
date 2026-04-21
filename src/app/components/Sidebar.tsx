import { NavLink } from "react-router";
import { LucideIcon } from "lucide-react";

interface SidebarProps {
  title: string;
  links: {
    to: string;
    label: string;
    icon: LucideIcon;
  }[];
}

export default function Sidebar({ title, links }: SidebarProps) {
  return (
    <div className="w-64 bg-white border-r border-slate-200 flex flex-col">
      <div className="h-16 px-6 flex items-center border-b border-slate-200">
        <h1 className="text-lg text-slate-900">{title}</h1>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to.split('/').length === 2}
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

      <div className="p-4 border-t border-slate-200">
        <NavLink
          to="/"
          className="flex items-center gap-3 px-4 py-2.5 rounded-md text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
        >
          <span>Switch Role</span>
        </NavLink>
      </div>
    </div>
  );
}
