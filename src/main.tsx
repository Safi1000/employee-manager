
  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import "./styles/index.css";
  import "./styles/native.css";
  import { initNativeShell } from "./app/lib/nativeShell";

  // Back button, deep links, status bar and keyboard behaviour for the Android
  // and iOS shells. A no-op in the browser.
  initNativeShell();

  createRoot(document.getElementById("root")!).render(<App />);
  