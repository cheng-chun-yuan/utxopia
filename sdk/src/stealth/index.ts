/**
 * Stealth Address Subpath
 *
 * EIP-5564/DKSAP stealth address implementation for AEGIS.
 * Provides privacy-preserving deposit and receiving functionality.
 */

// Re-export stealth deposit creation
export {
  createStealthDeposit,
  type StealthDeposit,
} from "./deposit";

// Re-export announcement scanning
export {
  scanAnnouncements,
  scanAnnouncementsViewOnly,
  exportViewOnlyKeys,
  prepareClaimInputs,
  scanUnifiedNotes,
  // Amount encryption utilities
  encryptAmount,
  decryptAmount,
  // Constants
  ANNOUNCEMENT_TYPE_DEPOSIT,
  ANNOUNCEMENT_TYPE_TRANSFER,
  // Types
  type ScannedNote,
  type ClaimInputs as StealthClaimInputs,
  type OnChainStealthAnnouncement,
  type ViewOnlyKeys,
  type ViewOnlyScannedNote,
  type ConnectionAdapter,
} from "./scan";

// Re-export stealth meta-address utilities from keys
export {
  createStealthMetaAddress,
  serializeStealthMetaAddress,
  deserializeStealthMetaAddress,
  parseStealthMetaAddress,
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
  type StealthMetaAddress,
  type SerializedStealthMetaAddress,
} from "./address";

// Re-export direct stealth deposit (BTC + announcement combined)
export {
  prepareStealthDeposit,
  buildStealthOpReturn,
  parseStealthOpReturn,
  verifyStealthDeposit,
  STEALTH_OP_RETURN_SIZE,
  VERIFY_STEALTH_DEPOSIT_DISCRIMINATOR,
  type PreparedStealthDeposit,
  type StealthDepositData,
  type ParsedStealthOpReturn,
  type Ed25519KeyPair,
} from "./btc-deposit";

// Re-export wallet type guard
export { isWalletAdapter } from "./scan";
