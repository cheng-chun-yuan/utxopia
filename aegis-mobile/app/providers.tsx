import { useEffect } from "react";
import { initPoseidon } from "@aegis/sdk";

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initPoseidon().catch(console.error);
  }, []);
  return <>{children}</>;
}
