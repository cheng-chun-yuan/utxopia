"use client";

import { renderChainDeposit } from "@/components/vault/deposit-adapters";
import { useChainEnvironment } from "@/lib/chain-environment";

export default function DepositPage() {
  const env = useChainEnvironment();
  return renderChainDeposit({ networkId: env.networkId, config: env.config });
}
