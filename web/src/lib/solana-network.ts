/**
 * Central Solana network configuration utility.
 * Maps SDK config to all network-dependent values.
 * This is the ONLY file that should contain Solana explorer URL logic.
 */
import { getConfig } from "@utxopia/sdk";

/** Solana explorer cluster query parameter */
export function getSolanaCluster(): string {
  const net = getConfig().network;
  switch (net) {
    case "mainnet":
      return ""; // mainnet-beta is the default, no cluster param needed
    case "devnet":
      return "devnet";
    case "localnet":
      return "custom&customUrl=http%3A%2F%2Flocalhost%3A8899";
    default:
      return "devnet";
  }
}

/** Solana explorer transaction URL */
export function getSolanaExplorerTxUrl(signature: string): string {
  const cluster = getSolanaCluster();
  const base = `https://explorer.solana.com/tx/${signature}`;
  return cluster ? `${base}?cluster=${cluster}` : base;
}

/** Solana explorer address URL */
export function getSolanaExplorerAddressUrl(address: string): string {
  const cluster = getSolanaCluster();
  const base = `https://explorer.solana.com/address/${address}`;
  return cluster ? `${base}?cluster=${cluster}` : base;
}
