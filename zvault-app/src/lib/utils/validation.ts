// Validation utilities
//
// Uses @zvault/sdk for Bitcoin address validation (more comprehensive than regex)

import {
  MIN_DEPOSIT_SATS,
  MAX_DEPOSIT_SATS,
  MIN_WITHDRAWAL_SATS,
} from "@/lib/constants";
import { isValidBitcoinAddress } from "@zvault/sdk";

export function validateDepositAmount(amount: number): { valid: boolean; error?: string } {
  if (!amount || amount <= 0) {
    return { valid: false, error: "Amount must be greater than 0" };
  }
  if (amount < MIN_DEPOSIT_SATS) {
    return { valid: false, error: `Minimum deposit is ${MIN_DEPOSIT_SATS.toLocaleString()} sats` };
  }
  if (amount > MAX_DEPOSIT_SATS) {
    return { valid: false, error: `Maximum deposit is ${MAX_DEPOSIT_SATS.toLocaleString()} sats` };
  }
  return { valid: true };
}

export function validateWithdrawalAmount(amount: number): { valid: boolean; error?: string } {
  if (!amount || amount <= 0) {
    return { valid: false, error: "Amount must be greater than 0" };
  }
  if (amount < MIN_WITHDRAWAL_SATS) {
    return { valid: false, error: `Minimum withdrawal is ${MIN_WITHDRAWAL_SATS.toLocaleString()} sats` };
  }
  return { valid: true };
}

/**
 * Validate Bitcoin address using SDK's comprehensive validator
 * Supports P2PKH, P2SH, P2WPKH, P2WSH, and P2TR (Taproot)
 */
export function validateBtcAddress(address: string): { valid: boolean; error?: string } {
  const trimmed = address.trim();
  if (!trimmed) {
    return { valid: false, error: "Bitcoin address is required" };
  }

  const result = isValidBitcoinAddress(trimmed);
  if (!result.valid) {
    return { valid: false, error: "Invalid Bitcoin address format" };
  }

  // Allow both mainnet and testnet addresses
  if (result.network === "unknown") {
    return { valid: false, error: "Unrecognized Bitcoin network" };
  }

  return { valid: true };
}

export function parseSats(amount: string): number | null {
  const parsed = parseInt(amount, 10);
  return isNaN(parsed) || parsed <= 0 ? null : parsed;
}

export function satsToBtc(sats: number): number {
  return sats / 100_000_000;
}
