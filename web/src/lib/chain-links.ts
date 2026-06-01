import { getChainAdapter } from "@/lib/chain-registry";
import type { NetworkConfig } from "@/lib/network-config";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";

export function getChainTransactionUrl(config: NetworkConfig, txId: string): string {
  const chain = getChainAdapter(config);
  if (chain.id === "sui" && config.sui) {
    return `${config.sui.explorerUrl.replace(/\/$/, "")}/txblock/${txId}?network=testnet`;
  }
  return getSolanaExplorerTxUrl(txId);
}

export function getChainIcon(config: NetworkConfig): string {
  const chain = getChainAdapter(config);
  return `/tokens/${chain.query}.png`;
}

export function getChainLinkClass(config: NetworkConfig): string {
  const chain = getChainAdapter(config);
  return chain.id === "sui"
    ? "text-sui/70 hover:text-sui"
    : "text-gray hover:text-gray-light";
}

export function getChainMutedLinkClass(config: NetworkConfig): string {
  const chain = getChainAdapter(config);
  return chain.id === "sui"
    ? "text-sui/40 hover:text-sui"
    : "text-purple-400/40 hover:text-purple-400";
}
