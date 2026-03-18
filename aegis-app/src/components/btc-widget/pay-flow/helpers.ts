/**
 * Pay Flow Helpers — pure utility functions for the JoinSplit payment flow.
 * Contains address validation, note selection, circuit estimation, and field reduction.
 */

import { PublicKey } from "@solana/web3.js";
import type { InboxNote } from "@/hooks/use-aegis";

// --- Constants ---

export const MIN_PAY_SATS = 500;
import { getActiveTokenId } from "@/lib/token-context";

// Token ID is now computed dynamically from the active token's mint address.
// This is a function call, not a constant — use ZKBTC_TOKEN_ID() in all call sites.
export const ZKBTC_TOKEN_ID = getActiveTokenId;
export const MAX_OUTPUTS = 12; // N+M<=14, need at least 1 input + 1 change
export const SERVICE_FEE_SATS = 2000;
export const RELAYER_FEE_SATS = 2000;
export const SOLANA_MAX_TX_SIZE = 1232;

/** BN254 scalar field modulus (big-endian bytes) */
const BN254_FR_MODULUS = [
  0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
  0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
  0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
  0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/**
 * Available JoinSplit circuit variants (N+M <= 14).
 * Constrained to what's actually compiled and has on-chain VK registered.
 */
export const AVAILABLE_CIRCUITS = new Set(
  Array.from({ length: 13 }, (_, n) =>
    Array.from({ length: 14 - n - 1 }, (_, m) => `${n + 1}x${m + 1}`)
  ).flat()
);

/** Circuits served locally by Vercel (N+M <= 5, always available) */
export const LOCAL_CIRCUITS = new Set([
  "1x1", "1x2", "1x3", "1x4",
  "2x1", "2x2", "2x3",
  "3x1", "3x2",
  "4x1",
]);

// --- Validation ---

/** Validate a Solana base58 public key */
export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// --- Field Reduction ---

/**
 * Match on-chain reduce_to_field: if bytes >= BN254 modulus, mask first byte.
 * This ensures the commitment computed off-chain matches the on-chain verification.
 *
 * TODO(backward-compat): this mirrors the on-chain mask approach (result[0] &= 0x2F).
 * If on-chain changes to proper modular reduction, update here too.
 */
export function reduceToFieldOnChain(bytes: Uint8Array): bigint {
  let isGe = true;
  for (let i = 0; i < 32; i++) {
    if (bytes[i] < BN254_FR_MODULUS[i]) { isGe = false; break; }
    if (bytes[i] > BN254_FR_MODULUS[i]) { break; }
  }
  if (!isGe) {
    return BigInt("0x" + Buffer.from(bytes).toString("hex"));
  }
  const reduced = new Uint8Array(bytes);
  reduced[0] &= 0x2F;
  return BigInt("0x" + Buffer.from(reduced).toString("hex"));
}

// --- Transaction Size Estimation ---

/**
 * Estimate Solana transaction size for a JoinSplit(N,M).
 * Solana max tx size = 1232 bytes.
 *
 * Relay uses proof_source=1: proof (256 bytes) offloaded to ChadBuffer,
 * stealth data (M×40 bytes) remains in instruction data.
 */
export function estimateTransactionSize(nInputs: number, nOutputs: number): number {
  const numAccounts = 7 + nInputs;
  const instructionDataSize = 68 + (nInputs * 32) + (nOutputs * 72);

  return (
    1 + 64 + 3 + 1 +
    (numAccounts * 32) +
    32 + 1 + 1 + 1 +
    (6 + nInputs) +
    2 + instructionDataSize
  );
}

// --- Note Selection ---

/**
 * Auto-select smallest combination of notes that covers the target amount.
 * Greedy: sort ascending, pick until covered.
 */
export function autoSelectNotes(notes: InboxNote[], targetSats: number): Set<string> {
  if (targetSats <= 0) return new Set();
  const sorted = [...notes].sort((a, b) => Number(a.amount) - Number(b.amount));
  const selected = new Set<string>();
  let total = 0;
  for (const note of sorted) {
    selected.add(note.id);
    total += Number(note.amount);
    if (total >= targetSats) break;
  }
  return selected;
}

// --- Supported Tokens ---

export interface PayToken {
  symbol: string;
  name: string;
  logo: string;
  enabled: boolean;
  unit: string; // display unit for amounts (e.g. "sats", "USDC")
}

export const PAY_TOKENS: PayToken[] = [
  { symbol: "zkBTC", name: "Shielded Bitcoin", logo: "/zkbtc.png", enabled: true, unit: "sats" },
  { symbol: "SOL", name: "Solana", logo: "/tokens/sol.png", enabled: true, unit: "SOL" },
  { symbol: "USDC", name: "USD Coin", logo: "/tokens/usdc.png", enabled: true, unit: "USDC" },
  { symbol: "USDT", name: "Tether USD", logo: "/tokens/usdt.png", enabled: true, unit: "USDT" },
];

// --- Types ---

export type PayStep = "connect" | "compose" | "proving" | "success";
export type OutputMode = "stealth" | "public" | "note" | "btc";

export interface OutputRow {
  id: string;
  mode: OutputMode;
  amount: string;
  secretPhrase: string;
  resolvedMeta: import("@aegis/sdk").StealthMetaAddress | null;
  resolvedName: string | null;
  stealthError: string | null;
  solanaAddress: string;
  addressError: string | null;
  btcAddress: string | null;
  btcScriptPubKey: Uint8Array | null;
  btcAddressError: string | null;
}

export function createOutputRow(mode: OutputMode = "stealth", defaultAddress = ""): OutputRow {
  return {
    id: crypto.randomUUID(),
    mode,
    amount: "",
    secretPhrase: "",
    resolvedMeta: null,
    resolvedName: null,
    stealthError: null,
    solanaAddress: defaultAddress,
    addressError: null,
    btcAddress: null,
    btcScriptPubKey: null,
    btcAddressError: null,
  };
}
