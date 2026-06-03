/**
 * Pure recipient-type detection for the unified Send wizard.
 *
 * Detection is a first-match-wins ladder; see
 * docs/designs/2026-05-10-pay-wizard-merge-design.md "Detection rules".
 *
 * On-curve / checksum validation is the SDK's job downstream — this
 * function only needs to be sharp enough to drive the type indicator.
 */

export type RecipientType =
  | "btc"
  | "stealth_sns"
  | "stealth_suins"
  | "stealth_meta"
  | "spl_wallet";

export type DetectionResult = {
  type: RecipientType | "invalid" | "ambiguous" | "empty";
  confidence: "high" | "medium" | "low";
  reason?: string;
};

export type RecipientDetectionContext = {
  chain?: "solana" | "sui";
};

const SNS_SUFFIX = ".utxopia.sol";
const SUINS_SUFFIX = ".utxopia.sui";
const SUINS_NAME_RE = /^[a-z0-9]{1,63}\.utxopia\.sui$/;
const STEALTH_META_PREFIX = "utxo:";
// 96 bytes = spendingPubKey(32) + viewingPubKey(32) + mpk(32). See
// sdk/src/keys.ts::decodeStealthMetaAddress.
const STEALTH_META_HEX_LEN = 64 + 64 + 64;

const BECH32_PREFIXES = ["bc1", "tb1", "bcrt1"];

const BASE58_ALPHABET =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

function looksLikeBech32(input: string): boolean {
  const lower = input.toLowerCase();
  if (!BECH32_PREFIXES.some((p) => lower.startsWith(p))) return false;
  return /^[a-z0-9]+$/.test(lower) && lower.length >= 26 && lower.length <= 90;
}

function looksLikeBase58(
  input: string,
  minLen: number,
  maxLen: number,
): boolean {
  return (
    input.length >= minLen &&
    input.length <= maxLen &&
    BASE58_ALPHABET.test(input)
  );
}

function looksLikeLegacyBtc(input: string): boolean {
  if (!(input.startsWith("1") || input.startsWith("3"))) return false;
  return looksLikeBase58(input, 26, 35);
}

function looksLikeSolanaPubkey(input: string): boolean {
  return looksLikeBase58(input, 32, 44) && input.length >= 43;
}

function looksLikeStealthMeta(input: string): boolean {
  if (!input.startsWith(STEALTH_META_PREFIX)) return false;
  const rest = input.slice(STEALTH_META_PREFIX.length);
  return rest.length === STEALTH_META_HEX_LEN && /^[0-9a-fA-F]+$/.test(rest);
}

export function detectRecipient(
  rawInput: string,
  context: RecipientDetectionContext = {},
): DetectionResult {
  const input = rawInput.trim();
  if (input.length === 0) {
    return { type: "empty", confidence: "high" };
  }

  const lower = input.toLowerCase();

  if (lower.endsWith(SNS_SUFFIX)) {
    return {
      type: "stealth_sns",
      confidence: "high",
      reason: "Looks like a .utxopia.sol name",
    };
  }

  if (lower.endsWith(SUINS_SUFFIX) && SUINS_NAME_RE.test(lower)) {
    return {
      type: "stealth_suins",
      confidence: "high",
      reason: "Looks like a SuiNS name",
    };
  }

  if (/^@[a-z0-9]{1,63}$/.test(lower)) {
    if (context.chain === "solana") {
      return {
        type: "stealth_sns",
        confidence: "high",
        reason: "Looks like a .utxopia.sol handle on Solana",
      };
    }
    if (context.chain === "sui") {
      return {
        type: "stealth_suins",
        confidence: "high",
        reason: "Looks like a SuiNS handle on Sui",
      };
    }
    return {
      type: "ambiguous",
      confidence: "medium",
      reason: "Handle requires an active chain context",
    };
  }

  if (looksLikeBech32(input)) {
    return {
      type: "btc",
      confidence: "high",
      reason: "Bech32 Bitcoin address",
    };
  }

  if (looksLikeLegacyBtc(input)) {
    return {
      type: "btc",
      confidence: "medium",
      reason: "Legacy Bitcoin address",
    };
  }

  if (looksLikeStealthMeta(input)) {
    return {
      type: "stealth_meta",
      confidence: "high",
      reason: "Stealth meta-address",
    };
  }

  if (looksLikeSolanaPubkey(input)) {
    return {
      type: "spl_wallet",
      confidence: "medium",
      reason: "Solana wallet address",
    };
  }

  return {
    type: "invalid",
    confidence: "low",
    reason: "Not a recognized address format",
  };
}
