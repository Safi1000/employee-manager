import { Outlet } from "react-router";
import Sidebar from "../components/Sidebar";
import {
  LayoutDashboard,
  UserCircle,
  Calendar,
  FileText,
} from "lucide-react";

export default function HRLayout() {
  const links = [
    { to: "/hr", label: "Dashboard", icon: LayoutDashboard },
    { to: "/hr/employees", label: "Employee Management", icon: UserCircle },
    { to: "/hr/attendance", label: "Attendance", icon: Calendar },
    { to: "/hr/documents", label: "Documents", icon: FileText },
  ];

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar title="HR Panel" links={links} />
      <div className="flex-1 flex flex-col overflow-hidden pt-12 md:pt-0">
        <Outlet />
      </div>
    </div>
  );
}
