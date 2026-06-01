/**
 * Central Bitcoin network configuration utility.
 * Maps SDK config to all network-dependent values.
 * This is the ONLY file that should contain network string literals.
 */
import { getConfig } from "@utxopia/sdk";
import { BitcoinNetworkType } from "sats-connect";
import { getNetworkConfig } from "./network-config";

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

/** BTC block explorer base URL (for <a href> links, no /api suffix).
 *  Reads `bitcoin.explorerUrl` from the active network config, so hybrid
 *  surfaces `btc.utxopia.com/regtest` instead of localhost. Falls back to
 *  per-network mempool.space defaults if no config is loaded yet. */
export function getMempoolExplorerUrl(): string {
  try {
    const url = getNetworkConfig().bitcoin.explorerUrl;
    if (url) return url;
  } catch {
    /* fall through to legacy switch */
  }
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
      return "https://btc.utxopia.com/regtest";
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

// =============================================================================
// Bitcoin address decoding (bech32/bech32m from scriptPubKey hex)
// =============================================================================

/** Get the bech32 HRP for the current Bitcoin network */
function getBech32Hrp(): string {
  try {
    const net = getConfig().bitcoinNetwork;
    if (net === "mainnet") return "bc";
    if (net === "regtest") return "bcrt";
    return "tb"; // testnet, testnet4, signet
  } catch {
    return "tb";
  }
}

/** Decode a hex scriptPubKey to a bech32/bech32m address */
export function scriptToAddress(hexScript: string): string | null {
  try {
    const bytes = new Uint8Array(hexScript.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    if (bytes.length < 4) return null;
    const version = bytes[0] === 0x00 ? 0 : bytes[0] - 0x50;
    if (version < 0 || version > 16) return null;
    const progLen = bytes[1];
    if (bytes.length < 2 + progLen) return null;
    const program = bytes.slice(2, 2 + progLen);
    const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const data5: number[] = [version];
    let acc = 0, bits = 0;
    for (const b of program) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; data5.push((acc >> bits) & 31); } }
    if (bits > 0) data5.push((acc << (5 - bits)) & 31);
    const hrp = getBech32Hrp();
    const useBech32m = version > 0;
    function polymod(values: number[]): number {
      const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
      let chk = 1;
      for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]; }
      return chk;
    }
    function hrpExpand(h: string): number[] {
      const r: number[] = [];
      for (const c of h) r.push(c.charCodeAt(0) >> 5);
      r.push(0);
      for (const c of h) r.push(c.charCodeAt(0) & 31);
      return r;
    }
    const checkConst = useBech32m ? 0x2bc830a3 : 1;
    const values = [...hrpExpand(hrp), ...data5, 0, 0, 0, 0, 0, 0];
    const pm = polymod(values) ^ checkConst;
    const checksum: number[] = [];
    for (let i = 0; i < 6; i++) checksum.push((pm >> (5 * (5 - i))) & 31);
    return hrp + "1" + [...data5, ...checksum].map(v => CHARSET[v]).join("");
  } catch {
    return null;
  }
}
