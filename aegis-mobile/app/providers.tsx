import { useEffect } from "react";
import { initPoseidon } from "@aegis/sdk";
import { useAegisStore } from "@/stores/aegis-store";
import { loadSerializedKeys } from "@/lib/storage";
import { authenticateBiometric } from "@/lib/auth";

export function Providers({ children }: { children: React.ReactNode }) {
  const hydrateFromStorage = useAegisStore((s) => s.hydrateFromStorage);

  useEffect(() => {
    (async () => {
      await initPoseidon();
      // Check if wallet exists, then require Face ID
      const existing = await loadSerializedKeys();
      if (existing) {
        const ok = await authenticateBiometric();
        if (ok) {
          await hydrateFromStorage();
        }
      }
    })().catch(console.error);
  }, []);

  return <>{children}</>;
}
