import { Suspense } from "react";
import { RouterProvider } from "react-router";
import RouteLoading from "./components/RouteLoading";
import { router } from "./routes";
import { AuthProvider } from "./lib/auth";
import { RegionProvider } from "./lib/region";
import { ModeProvider } from "./lib/mode";
import AppUpdateBanner from "./lib/appUpdate";

export default function App() {
  return (
    <ModeProvider>
      <AuthProvider>
        {/* Inside AuthProvider: the region list is per-company and the region
            lock comes from the profile. */}
        <RegionProvider>
          {/* Routes are lazy chunks (see routes.tsx). This boundary catches the
              public ones; the two layouts carry their own around <Outlet /> so
              the sidebar stays put while a screen loads. */}
          <Suspense fallback={<RouteLoading />}>
            <RouterProvider router={router} />
          </Suspense>
          {/* Outside the router on purpose: a stale tab has to be told so on
              every screen, including login and any route that fails to load
              because its chunk no longer exists on the server. */}
          <AppUpdateBanner />
        </RegionProvider>
      </AuthProvider>
    </ModeProvider>
  );
}
