"use client";

import { useEffect, useState } from "react";
import {
  getSuiAuthState,
  SUI_AUTH_CHANGE_EVENT,
  type SuiAuthState,
} from "@/lib/sui/client";

export function useSuiAuthState(): SuiAuthState | null {
  const [suiAuth, setSuiAuth] = useState<SuiAuthState | null>(null);

  useEffect(() => {
    const refresh = () => setSuiAuth(getSuiAuthState());
    refresh();
    window.addEventListener(SUI_AUTH_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SUI_AUTH_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return suiAuth;
}
