/**
 * BTC Stealth Deposit (Combined BTC + Announcement)
 *
 * Re-exports from stealth-deposit module for subpath compatibility.
 */

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
} from "../stealth-deposit";
