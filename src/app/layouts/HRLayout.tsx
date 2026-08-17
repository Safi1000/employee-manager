import { Outlet } from "react-router";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
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
    <div className="app-shell flex h-dvh bg-slate-50">
      <Sidebar title="HR Panel" links={links} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar />
        <Outlet />
      </div>
    </div>
  );
}
