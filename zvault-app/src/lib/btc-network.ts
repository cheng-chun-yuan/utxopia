/**
 * Central Bitcoin network configuration utility.
 * Maps SDK config to all network-dependent values.
 * This is the ONLY file that should contain network string literals.
 */
import { getConfig } from "@zvault/sdk";
import { BitcoinNetworkType } from "sats-connect";

type BitcoinNetwork = ReturnType<typeof getConfig>["bitcoinNetwork"];

/** sats-connect network enum for Xverse/Leather wallets */
export function getSatsConnectNetwork(): BitcoinNetworkType {
  const net = getConfig().bitcoinNetwork;
  switch (net) {
    case "mainnet":
      return BitcoinNetworkType.Mainnet;
    case "testnet":
    case "testnet4":
    case "signet":
    case "regtest":
      return BitcoinNetworkType.Testnet;
    default:
      return BitcoinNetworkType.Testnet;
  }
}

/** UniSat wallet chain string for switchChain() */
export function getUnisatChain(): string {
  const net = getConfig().bitcoinNetwork;
  switch (net) {
    case "mainnet":
      return "BITCOIN_MAINNET";
    case "testnet":
      return "BITCOIN_TESTNET";
    case "testnet4":
      return "BITCOIN_TESTNET4";
    case "signet":
      return "BITCOIN_SIGNET";
    case "regtest":
      return "BITCOIN_REGTEST";
    default:
      return "BITCOIN_TESTNET4";
  }
}

/** UniSat fallback network string for switchNetwork() (only knows mainnet/testnet) */
export function getUnisatFallbackNetwork(): string {
  return getConfig().bitcoinNetwork === "mainnet" ? "livenet" : "testnet";
}

/** mempool.space explorer base URL (for <a href> links, no /api suffix) */
export function getMempoolExplorerUrl(): string {
  const net = getConfig().bitcoinNetwork;
  switch (net) {
    case "mainnet":
      return "https://mempool.space";
    case "testnet":
      return "https://mempool.space/testnet";
    case "testnet4":
      return "https://mempool.space/testnet4";
    case "signet":
      return "https://mempool.space/signet";
    case "regtest":
      return "http://localhost:8080";
    default:
      return "https://mempool.space/testnet4";
  }
}

/** Esplora API base URL (for fetch calls) — re-exports from SDK config */
export function getEsploraApiUrl(): string {
  return getConfig().esploraUrl;
}

/** scure-btc-signer network — only knows "mainnet" | "testnet" */
export function getBtcSignerNetwork(): "mainnet" | "testnet" {
  return getConfig().bitcoinNetwork === "mainnet" ? "mainnet" : "testnet";
}
