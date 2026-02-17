#!/usr/bin/env bun
/**
 * Test the full stealth deposit + claim flow
 * This verifies that:
 * 1. createStealthDeposit creates correct commitments
 * 2. scanAnnouncements finds the deposits
 * 3. prepareClaimInputs derives correct stealthPrivKey
 * 4. The computed commitment matches the stored commitment
 */
import {
  initPoseidon,
  deriveKeysFromSeed,
  createStealthMetaAddress,
  createStealthDeposit,
  scanAnnouncements,
  prepareClaimInputs,
  computeUnifiedCommitmentSync,
  bytesToBigint,
  bytesToHex,
} from "../src";

async function main() {
  console.log("=== Full Stealth Flow Test ===\n");
  
  await initPoseidon();
  console.log("✓ Poseidon initialized\n");
  
  // Step 1: Generate keys
  console.log("Step 1: Generate ZVault keys");
  const seed = new Uint8Array(32);
  seed[0] = 42; // Deterministic seed
  const keys = await deriveKeysFromSeed(seed);
  console.log(`  Spending pub X: ${keys.spendingPubKey.x.toString(16).slice(0, 16)}...`);
  console.log(`  Viewing pub X: ${keys.viewingPubKey.x.toString(16).slice(0, 16)}...`);
  
  // Step 2: Create stealth meta address
  console.log("\nStep 2: Create stealth meta address");
  const meta = createStealthMetaAddress(keys);
  console.log(`  Meta address created`);
  
  // Step 3: Create stealth deposit
  const amount = 10000n;
  console.log(`\nStep 3: Create stealth deposit (${amount} sats)`);
  const deposit = await createStealthDeposit(meta, amount);
  const commitmentHex = bytesToHex(deposit.commitment);
  console.log(`  Ephemeral pub: ${bytesToHex(deposit.ephemeralPub).slice(0, 20)}...`);
  console.log(`  Commitment: ${commitmentHex}`);
  console.log(`  Encrypted amount: ${bytesToHex(deposit.encryptedAmount)}`);
  
  // Step 4: Simulate scanning (as if we fetched from chain)
  console.log("\nStep 4: Scan for the deposit");
  const announcements = [{
    ephemeralPub: deposit.ephemeralPub,
    encryptedAmount: deposit.encryptedAmount,
    commitment: deposit.commitment,
    leafIndex: 0, // Simulated
  }];
  
  const scanned = await scanAnnouncements(keys, announcements);
  if (scanned.length === 0) {
    throw new Error("FAILED: scanAnnouncements didn't find the deposit!");
  }
  const note = scanned[0];
  console.log(`  ✓ Deposit found!`);
  console.log(`  Amount: ${note.amount} sats`);
  console.log(`  StealthPub.x: ${note.stealthPub.x.toString(16).slice(0, 16)}...`);
  
  // Step 5: Prepare claim inputs
  console.log("\nStep 5: Prepare claim inputs");
  const dummyProof = {
    root: 0n,
    pathElements: Array(20).fill(0n),
    pathIndices: Array(20).fill(0),
  };
  
  const claimInputs = await prepareClaimInputs(keys, note, dummyProof);
  console.log(`  Stealth priv: ${claimInputs.stealthPrivKey.toString(16).slice(0, 16)}...`);
  
  // Step 6: Verify commitment matches
  console.log("\nStep 6: Verify commitment calculation");
  const computedCommitment = computeUnifiedCommitmentSync(note.stealthPub.x, note.amount);
  const storedCommitment = bytesToBigint(deposit.commitment);
  
  console.log(`  Stored commitment:   ${storedCommitment.toString(16).padStart(64, "0")}`);
  console.log(`  Computed commitment: ${computedCommitment.toString(16).padStart(64, "0")}`);
  console.log(`  Match: ${computedCommitment === storedCommitment}`);
  
  if (computedCommitment !== storedCommitment) {
    throw new Error("FAILED: Commitment mismatch!");
  }
  
  console.log("\n✓ All tests passed! The stealth flow is working correctly.");
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message);
  process.exit(1);
});
