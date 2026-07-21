import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Light/dark colour mode. The initial class is applied pre-paint by an inline
// script in index.html (avoids a flash); this provider keeps React in sync and
// persists the choice.

type Mode = "light" | "dark";

type ModeContextValue = {
  mode: Mode;
  toggle: () => void;
  setMode: (m: Mode) => void;
};

const ModeContext = createContext<ModeContextValue | null>(null);

const STORAGE_KEY = "txs.mode";

function readInitial(): Mode {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "dark";
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(readInitial);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", mode === "dark");
    root.style.colorScheme = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  const value: ModeContextValue = {
    mode,
    setMode: setModeState,
    toggle: () => setModeState((m) => (m === "dark" ? "light" : "dark")),
  };

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error("useMode must be used within ModeProvider");
  return ctx;
}
