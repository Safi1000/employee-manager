import { Outlet } from "react-router";
import Sidebar from "../components/Sidebar";
import InactivityLogout from "../components/InactivityLogout";
import TopBar from "../components/TopBar";
import { Building2 } from "lucide-react";

export default function SuperSuperAdminLayout() {
  const links = [
    { to: "/super-super-admin", label: "Companies", icon: Building2 },
  ];
  return (
    <div className="app-shell flex h-dvh bg-slate-50">
      <Sidebar title="Super Super Admin" links={links} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar />
        <Outlet />
      </div>
      <InactivityLogout />
    </div>
  );
}
