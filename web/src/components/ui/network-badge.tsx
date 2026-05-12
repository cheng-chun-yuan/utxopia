"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { Beaker } from "lucide-react";
import { detectNetwork, NETWORK_META } from "@/lib/network-config";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/**
 * Header badge that surfaces the active network whenever it isn't the
 * production default ("devnet"). Click → /settings.
 *
 * Hidden on devnet so production users see no extra chrome; on hybrid
 * (and any future test stack) the chip makes it obvious which backend
 * the app is talking to.
 */
export function NetworkBadge() {
  const active = useSyncExternalStore(
    subscribe,
    () => detectNetwork(),
    () => "devnet" as const,
  );

  if (active === "devnet") return null;

  const meta = NETWORK_META.find((m) => m.id === active);
  const label = meta?.label ?? active;
  // Compact label: take the part before the parens, e.g. "Hybrid (devnet+regtest)" → "Hybrid"
  const short = label.split(" (")[0];

  return (
    <Link
      href="/settings"
      title={`Active network: ${label}. Click to change.`}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-medium uppercase tracking-wide hover:bg-amber-500/20 transition-colors"
    >
      <Beaker className="h-2.5 w-2.5" />
      {short}
    </Link>
  );
}
