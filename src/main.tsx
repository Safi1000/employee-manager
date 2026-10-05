
  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import "./styles/index.css";
  import { reloadForNewBuild } from "./app/lib/lazyPage";

  // Vite fires this when a module preload fails — the same stale-build case
  // lazyPage handles (a deploy replaced the chunk this tab expected). Reload
  // into the new build instead of surfacing an error.
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewBuild()) event.preventDefault();
  });

  createRoot(document.getElementById("root")!).render(<App />);
  