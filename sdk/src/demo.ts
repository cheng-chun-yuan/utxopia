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
 * Build instruction data for ADD_DEMO_STEALTH (npk-based, matches real deposits)
 *
 * Layout:
 * - discriminator: 1 byte (13)
 * - ephemeral_pub: 32 bytes (Ed25519 public key)
 * - npk: 32 bytes (note public key, big-endian BN254 field element)
 * - amount_sats: 8 bytes (u64 little-endian)
 * Total: 73 bytes
 *
 * @param ephemeralPub - Ed25519 ephemeral public key (32 bytes)
 * @param npk - Note public key (32 bytes, big-endian)
 * @param amountSats - Amount in satoshis
 * @returns Instruction data buffer
 */
export function buildAddDemoStealthData(
  ephemeralPub: Uint8Array,
  npk: Uint8Array,
  amountSats: bigint
): Uint8Array {
  if (ephemeralPub.length !== 32) {
    throw new Error(`Ephemeral pub must be 32 bytes, got ${ephemeralPub.length}`);
  }
  if (npk.length !== 32) {
    throw new Error(`NPK must be 32 bytes, got ${npk.length}`);
  }

  // Total size: 1 + 32 + 32 + 8 = 73 bytes
  const data = new Uint8Array(73);
  let offset = 0;

  data[offset++] = DEMO_INSTRUCTION.ADD_DEMO_STEALTH;

  data.set(ephemeralPub, offset);
  offset += 32;

  data.set(npk, offset);
  offset += 32;

  // Write amount_sats as u64 little-endian
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  view.setBigUint64(0, amountSats, true); // little-endian

  return data;
}

/**
 * Parse ADD_DEMO_STEALTH instruction data
 */
export function parseAddDemoStealthData(data: Uint8Array): {
  ephemeralPub: Uint8Array;
  npk: Uint8Array;
  amountSats: bigint;
} {
  if (data.length !== 73) {
    throw new Error(`Invalid data length: expected 73, got ${data.length}`);
  }

  if (data[0] !== DEMO_INSTRUCTION.ADD_DEMO_STEALTH) {
    throw new Error(
      `Invalid discriminator: expected ${DEMO_INSTRUCTION.ADD_DEMO_STEALTH}, got ${data[0]}`
    );
  }

  const view = new DataView(data.buffer, data.byteOffset + 65, 8);

  return {
    ephemeralPub: data.slice(1, 33),
    npk: data.slice(33, 65),
    amountSats: view.getBigUint64(0, true),
  };
}
