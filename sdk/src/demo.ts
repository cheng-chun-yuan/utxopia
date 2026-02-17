/**
 * Demo Instruction Builders
 *
 * Utilities for building demo/test instructions.
 * These are only available on devnet/localnet (demo mode).
 *
 * @module demo
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Demo instruction discriminators
 */
export const DEMO_INSTRUCTION = {
  /** Add a demo stealth announcement (for testing) */
  ADD_DEMO_STEALTH: 13,
} as const;

// =============================================================================
// Instruction Builders
// =============================================================================

/**
 * Build instruction data for ADD_DEMO_STEALTH
 *
 * Layout:
 * - discriminator: 1 byte (13)
 * - ephemeral_pub: 32 bytes (Ed25519 public key)
 * - commitment: 32 bytes
 * - encrypted_amount: 8 bytes
 * Total: 73 bytes
 *
 * @param ephemeralPub - Ed25519 ephemeral public key (32 bytes)
 * @param commitment - Commitment hash (32 bytes)
 * @param encryptedAmount - Encrypted amount (8 bytes)
 * @returns Instruction data buffer
 */
export function buildAddDemoStealthData(
  ephemeralPub: Uint8Array,
  commitment: Uint8Array,
  encryptedAmount: Uint8Array
): Uint8Array {
  if (ephemeralPub.length !== 32) {
    throw new Error(`Ephemeral pub must be 32 bytes, got ${ephemeralPub.length}`);
  }
  if (commitment.length !== 32) {
    throw new Error(`Commitment must be 32 bytes, got ${commitment.length}`);
  }
  if (encryptedAmount.length !== 8) {
    throw new Error(`Encrypted amount must be 8 bytes, got ${encryptedAmount.length}`);
  }

  // Total size: 1 + 32 + 32 + 8 = 73 bytes
  const data = new Uint8Array(73);
  let offset = 0;

  data[offset++] = DEMO_INSTRUCTION.ADD_DEMO_STEALTH;

  data.set(ephemeralPub, offset);
  offset += 32;

  data.set(commitment, offset);
  offset += 32;

  data.set(encryptedAmount, offset);

  return data;
}

/**
 * Parse ADD_DEMO_STEALTH instruction data
 */
export function parseAddDemoStealthData(data: Uint8Array): {
  ephemeralPub: Uint8Array;
  commitment: Uint8Array;
  encryptedAmount: Uint8Array;
} {
  if (data.length !== 73) {
    throw new Error(`Invalid data length: expected 73, got ${data.length}`);
  }

  if (data[0] !== DEMO_INSTRUCTION.ADD_DEMO_STEALTH) {
    throw new Error(
      `Invalid discriminator: expected ${DEMO_INSTRUCTION.ADD_DEMO_STEALTH}, got ${data[0]}`
    );
  }

  return {
    ephemeralPub: data.slice(1, 33),
    commitment: data.slice(33, 65),
    encryptedAmount: data.slice(65, 73),
  };
}
