import { Outlet } from "react-router";
import Sidebar from "../components/Sidebar";
import { Building2 } from "lucide-react";

export default function SuperSuperAdminLayout() {
  const links = [
    { to: "/super-super-admin", label: "Companies", icon: Building2 },
  ];
  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar title="Super Super Admin" links={links} />
      <div className="flex-1 flex flex-col overflow-hidden pt-12 md:pt-0">
        <Outlet />
      </div>
    </div>
  );
}
