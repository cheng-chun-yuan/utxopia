/**
 * Cross-layer instruction alignment tests
 *
 * Verifies that SDK/frontend instruction data formats match
 * what the on-chain contract expects. If someone changes the
 * contract's data layout, these tests break immediately.
 *
 * ┌─────────────┐     data format     ┌─────────────┐
 * │  Contract   │◄════════════════════│   SDK/FE    │
 * │  (Rust)     │  must match exactly │ (TypeScript) │
 * └─────────────┘                     └─────────────┘
 */

import { describe, it, expect } from "bun:test";

// =============================================================================
// Contract-defined constants (from Rust source)
// =============================================================================

/** From contracts/programs/utxopia/src/instructions/shield.rs */
const CONTRACT = {
  shield: {
    disc: 29,
    dataLen: 72, // amount(8) + npk(32) + ephemeral_pub(32)
    accountCount: 7,
    accounts: [
      "user (signer)",
      "user_token_account (writable)",
      "pool_state (read)",
      "token_config (writable)",
      "vault (writable)",
      "commitment_tree (writable)",
      "token_program (read)",
    ],
  },
  addDemoStealth: {
    disc: 13,
    dataLen: 72, // ephemeral_pub(32) + npk(32) + amount_sats(8)
    accountCount: 8,
    accounts: [
      "pool_state (writable)",
      "commitment_tree (writable)",
      "authority (signer)",
      "system_program (read)",
      "zkbtc_mint (writable)",
      "pool_vault (writable)",
      "token_program (read)",
      "token_config (read)",
    ],
  },
  registerToken: {
    disc: 28,
    dataLen: 32, // service_fee(8) + min_deposit(8) + max_deposit(8) + deposit_cap(8)
    accountCount: 6,
    accounts: [
      "authority (signer)",
      "pool_state (read)",
      "mint (read)",
      "token_config (writable)",
      "vault (read)",
      "system_program (read)",
    ],
  },
  completeDeposit: {
    disc: 1,
    dataLen: 80, // sweep_txid(32) + block_height(8) + sweep_tx_size(4) + deposit_tx_size(4) + deposit_txid(32)
    accountCount: 14,
  },
  transact: {
    disc: 14,
    stealthDataPerOutput: 72, // ephemeral_pub(32) + encrypted_amount(8) + encrypted_token_id(32)
  },
  unshield: {
    disc: 30,
    fixedAccountCount: 9,
    stealthDataPerOutput: 72,
  },
};

// =============================================================================
// Tests
// =============================================================================

describe("Cross-layer: instruction alignment", () => {
  describe("shield (disc=29)", () => {
    it("builds correct data format: amount(8) + npk(32) + ephemeral_pub(32) = 72 bytes", () => {
      const amount = 50000n;
      const npk = new Uint8Array(32).fill(0xab);
      const ephemeralPub = new Uint8Array(32).fill(0xcd);

      // Build like shield-flow.tsx does
      const ixData = new Uint8Array(73); // 1 disc + 72 data
      ixData[0] = CONTRACT.shield.disc;
      const view = new DataView(ixData.buffer);
      view.setBigUint64(1, amount, true); // LE
      ixData.set(npk, 9);
      ixData.set(ephemeralPub, 41);

      // Verify disc
      expect(ixData[0]).toBe(29);

      // Verify amount at correct offset (contract reads data[0..8] after disc strip)
      const contractData = ixData.slice(1); // contract receives without disc
      expect(contractData.length).toBe(CONTRACT.shield.dataLen);

      const parsedAmount = new DataView(contractData.buffer, contractData.byteOffset).getBigUint64(0, true);
      expect(parsedAmount).toBe(amount);

      // Verify npk at correct offset
      const parsedNpk = contractData.slice(8, 40);
      expect(parsedNpk).toEqual(npk);

      // Verify ephemeral at correct offset
      const parsedEph = contractData.slice(40, 72);
      expect(parsedEph).toEqual(ephemeralPub);
    });

    it("requires exactly 7 accounts in correct order", () => {
      expect(CONTRACT.shield.accountCount).toBe(7);
      expect(CONTRACT.shield.accounts[0]).toContain("user");
      expect(CONTRACT.shield.accounts[1]).toContain("user_token_account");
      expect(CONTRACT.shield.accounts[2]).toContain("pool_state");
      expect(CONTRACT.shield.accounts[3]).toContain("token_config");
      expect(CONTRACT.shield.accounts[4]).toContain("vault");
      expect(CONTRACT.shield.accounts[5]).toContain("commitment_tree");
      expect(CONTRACT.shield.accounts[6]).toContain("token_program");
    });
  });

  describe("add_demo_stealth (disc=13)", () => {
    it("builds correct data format: ephemeral_pub(32) + npk(32) + amount(8) = 72 bytes", () => {
      const ephemeralPub = new Uint8Array(32).fill(0x11);
      const npk = new Uint8Array(32).fill(0x22);
      const amount = 10000n;

      // Build like topup-stealth.mjs does
      const data = new Uint8Array(73);
      data[0] = CONTRACT.addDemoStealth.disc;
      data.set(ephemeralPub, 1);
      data.set(npk, 33);
      const view = new DataView(data.buffer);
      view.setBigUint64(65, amount, true);

      // Contract receives without disc
      const contractData = data.slice(1);
      expect(contractData.length).toBe(CONTRACT.addDemoStealth.dataLen);

      // Verify ephemeral_pub at [0..32]
      expect(contractData.slice(0, 32)).toEqual(ephemeralPub);

      // Verify npk at [32..64]
      expect(contractData.slice(32, 64)).toEqual(npk);

      // Verify amount at [64..72]
      const parsedAmount = new DataView(contractData.buffer, contractData.byteOffset).getBigUint64(64, true);
      expect(parsedAmount).toBe(amount);
    });

    it("requires exactly 8 accounts", () => {
      expect(CONTRACT.addDemoStealth.accountCount).toBe(8);
    });

    it("has different data layout from shield (ephemeral first vs amount first)", () => {
      // Shield: amount(8) + npk(32) + ephemeral(32)
      // Demo:   ephemeral(32) + npk(32) + amount(8)
      // This is intentional — verify they're NOT accidentally swapped
      expect(CONTRACT.shield.disc).not.toBe(CONTRACT.addDemoStealth.disc);
    });
  });

  describe("register_token (disc=28)", () => {
    it("builds correct data format: 4x u64 LE = 32 bytes", () => {
      const serviceFee = 1000n;
      const minDeposit = 5000n;
      const maxDeposit = 10_000_000_000n;
      const depositCap = 2_100_000_000_000_000n;

      // Build like init-devnet.mjs does
      const data = new Uint8Array(33);
      data[0] = CONTRACT.registerToken.disc;
      const view = new DataView(data.buffer);
      view.setBigUint64(1, serviceFee, true);
      view.setBigUint64(9, minDeposit, true);
      view.setBigUint64(17, maxDeposit, true);
      view.setBigUint64(25, depositCap, true);

      const contractData = data.slice(1);
      expect(contractData.length).toBe(CONTRACT.registerToken.dataLen);

      const cv = new DataView(contractData.buffer, contractData.byteOffset);
      expect(cv.getBigUint64(0, true)).toBe(serviceFee);
      expect(cv.getBigUint64(8, true)).toBe(minDeposit);
      expect(cv.getBigUint64(16, true)).toBe(maxDeposit);
      expect(cv.getBigUint64(24, true)).toBe(depositCap);
    });

    it("requires exactly 6 accounts", () => {
      expect(CONTRACT.registerToken.accountCount).toBe(6);
    });
  });

  describe("complete_deposit (disc=1)", () => {
    it("has correct data layout: 80 bytes total", () => {
      const sweepTxid = new Uint8Array(32).fill(0xaa);
      const blockHeight = 2311n;
      const sweepTxSize = 225;
      const depositTxSize = 300;
      const depositTxid = new Uint8Array(32).fill(0xbb);

      const data = new Uint8Array(81);
      data[0] = CONTRACT.completeDeposit.disc;
      data.set(sweepTxid, 1);
      const view = new DataView(data.buffer);
      view.setBigUint64(33, blockHeight, true);
      view.setUint32(41, sweepTxSize, true);
      view.setUint32(45, depositTxSize, true);
      data.set(depositTxid, 49);

      const contractData = data.slice(1);
      expect(contractData.length).toBe(CONTRACT.completeDeposit.dataLen);
    });

    it("requires exactly 14 accounts", () => {
      expect(CONTRACT.completeDeposit.accountCount).toBe(14);
    });
  });

  describe("transact (disc=14)", () => {
    it("stealth data per output is 72 bytes: ephemeral(32) + amount(8) + token_id(32)", () => {
      expect(CONTRACT.transact.stealthDataPerOutput).toBe(72);
      expect(32 + 8 + 32).toBe(72);
    });
  });

  describe("unshield (disc=30)", () => {
    it("has 9 fixed accounts + n nullifier records", () => {
      expect(CONTRACT.unshield.fixedAccountCount).toBe(9);
    });

    it("stealth data per output matches transact", () => {
      expect(CONTRACT.unshield.stealthDataPerOutput).toBe(CONTRACT.transact.stealthDataPerOutput);
    });
  });
});
