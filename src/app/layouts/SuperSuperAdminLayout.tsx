import { Suspense } from "react";
import RouteLoading from "../components/RouteLoading";
import { Outlet } from "react-router";
import Sidebar from "../components/Sidebar";
import InactivityLogout from "../components/InactivityLogout";
import SecurityGate from "../components/SecurityGate";
import TopBar from "../components/TopBar";
import { Building2 } from "lucide-react";
import { ScrollMemory } from "../lib/pageState";

export default function SuperSuperAdminLayout() {
  const links = [
    { to: "/super-super-admin", label: "Companies", icon: Building2 },
  ];
  return (
    <SecurityGate>
      <div className="app-shell flex h-dvh bg-muted/50">
        <Sidebar title="Super Super Admin" links={links} />
        <div className="flex-1 flex flex-col overflow-hidden">
          <TopBar />
          {/* Remembers each page's scroll position for the session (pageState.tsx). */}
          <ScrollMemory>
            <Suspense fallback={<RouteLoading />}>
              <Outlet />
            </Suspense>
          </ScrollMemory>
        </div>
        <InactivityLogout />
      </div>
    </SecurityGate>
  );
}
