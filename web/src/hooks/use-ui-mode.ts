"use client";

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type UiMode = "lite" | "advanced";

const STORAGE_KEY = "utxopia-ui-mode";

type UiModeContextValue = {
  mode: UiMode;
  isAdvanced: boolean;
  setMode: (next: UiMode) => void;
};

const UiModeContext = createContext<UiModeContextValue | null>(null);

function readInitial(): UiMode {
  if (typeof window === "undefined") return "lite";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "advanced" ? "advanced" : "lite";
}

export function UiModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<UiMode>(() => readInitial());

  // Sync across tabs/windows.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      setModeState(e.newValue === "advanced" ? "advanced" : "lite");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<UiModeContextValue>(
    () => ({
      mode,
      isAdvanced: mode === "advanced",
      setMode: (next) => {
        setModeState(next);
        window.localStorage.setItem(STORAGE_KEY, next);
      },
    }),
    [mode],
  );

  return createElement(UiModeContext.Provider, { value }, children);
}

export function useUiMode(): UiModeContextValue {
  const ctx = useContext(UiModeContext);
  if (!ctx) {
    // Allow hook calls outside the provider (tests / SSR fallback) — return lite.
    return { mode: "lite", isAdvanced: false, setMode: () => {} };
  }
  return ctx;
}
