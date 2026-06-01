/**
 * Legacy demo instruction helpers used by local E2E tests.
 *
 * The production deposit path uses shield/complete_deposit. These helpers are
 * kept so older localnet tests can still build the byte payload for the
 * test-only add_demo_stealth instruction.
 */

export const DEMO_INSTRUCTION = {
  ADD_DEMO_STEALTH: 13,
} as const;

export function buildAddDemoStealthData(
  ephemeralPub: Uint8Array,
  npk: Uint8Array,
  amountOrEncryptedAmount: bigint | Uint8Array,
): Uint8Array {
  if (ephemeralPub.length !== 32) {
    throw new Error(`ephemeralPub must be 32 bytes, got ${ephemeralPub.length}`);
  }
  if (npk.length !== 32) {
    throw new Error(`npk must be 32 bytes, got ${npk.length}`);
  }

  const data = new Uint8Array(73);
  data[0] = DEMO_INSTRUCTION.ADD_DEMO_STEALTH;
  data.set(ephemeralPub, 1);
  data.set(npk, 33);

  if (typeof amountOrEncryptedAmount === "bigint") {
    new DataView(data.buffer).setBigUint64(65, amountOrEncryptedAmount, true);
  } else {
    if (amountOrEncryptedAmount.length !== 8) {
      throw new Error(
        `encrypted amount must be 8 bytes, got ${amountOrEncryptedAmount.length}`,
      );
    }
    data.set(amountOrEncryptedAmount, 65);
  }

  return data;
}
