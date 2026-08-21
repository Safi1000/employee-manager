
  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import "./styles/index.css";
  import "./styles/native.css";
  import { initNativeShell } from "./app/lib/nativeShell";
  import Maintenance from "./app/Maintenance.tsx";

  // Set back to false to bring the whole app back. Nothing was removed.
  const SHOW_MAINTENANCE = true;

  // Back button, deep links, status bar and keyboard behaviour for the Android
  // and iOS shells. A no-op in the browser.
  if (!SHOW_MAINTENANCE) initNativeShell();

  createRoot(document.getElementById("root")!).render(
    SHOW_MAINTENANCE ? <Maintenance /> : <App />,
  );
  