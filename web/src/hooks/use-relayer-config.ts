"use client";

import { useState, useEffect } from "react";
import {
  SERVICE_FEE_SATS,
  RELAYER_FEE_SATS,
  type PayToken,
} from "@/components/btc-widget/pay-flow/helpers";

interface RelayerMeta {
  stealthMeta: string | null;
  relayerFeeSats: number;
  relayerFees: Record<string, number>;
  serviceFeeSats: number;
  serviceFeeBps: number;
}

export function useRelayerConfig(selectedToken: PayToken) {
  const [relayerMeta, setRelayerMeta] = useState<RelayerMeta | null>(null);

  useEffect(() => {
    // Fetch all fee config from backend (reads on-chain pool state internally)
    fetch("/api/relayer/meta")
      .then((r) => (r.ok ? r.json() : null))
      .catch((err) => { console.error("[RelayerConfig] fetch error:", err); return null; })
      .then((data) => {
        if (!data) return;
        setRelayerMeta({
          stealthMeta: data.stealth_meta || null,
          relayerFeeSats: data.relayer_fee_sats ?? RELAYER_FEE_SATS,
          relayerFees: data.relayer_fees ?? {},
          serviceFeeSats: data.service_fee_base ?? SERVICE_FEE_SATS,
          serviceFeeBps: data.service_fee_bps ?? 0,
        });
      });
  }, []);

  // Derived values
  const relayerMetaLoaded = relayerMeta !== null;
  const effectiveRelayerFee = relayerMetaLoaded
    ? (relayerMeta.relayerFees[selectedToken.shieldedSymbol]
        ?? selectedToken.relayerFee)
    : 0;
  const effectiveServiceFee = relayerMeta?.serviceFeeSats ?? 0;
  const effectiveServiceFeeBps = relayerMeta?.serviceFeeBps ?? 0;

  return {
    relayerMeta,
    relayerMetaLoaded,
    effectiveRelayerFee,
    effectiveServiceFee,
    effectiveServiceFeeBps,
  };
}
