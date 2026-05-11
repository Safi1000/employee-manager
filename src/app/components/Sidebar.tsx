import { NavLink, useNavigate } from "react-router";
import { LucideIcon, LogOut } from "lucide-react";
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
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <div className="w-64 bg-white border-r border-slate-200 flex flex-col">
      <div className="h-16 px-6 flex items-center border-b border-slate-200">
        <h1 className="text-lg text-slate-900">{title}</h1>
      </div>

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
    </div>
  );
}
