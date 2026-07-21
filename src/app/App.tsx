import { RouterProvider } from "react-router";
import { router } from "./routes";
import { AuthProvider } from "./lib/auth";
import { RegionProvider } from "./lib/region";
import { ModeProvider } from "./lib/mode";

export default function App() {
  return (
    <ModeProvider>
      <AuthProvider>
        {/* Inside AuthProvider: the region list is per-company and the region
            lock comes from the profile. */}
        <RegionProvider>
          <RouterProvider router={router} />
        </RegionProvider>
      </AuthProvider>
    </ModeProvider>
  );
}
