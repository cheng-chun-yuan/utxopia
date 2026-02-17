/**
 * Test script: Create a stealth deposit via Demo API
 */
import { deriveKeysFromSeed, createStealthMetaAddress, encodeStealthMetaAddress } from "../src/keys";
import { createStealthDeposit } from "../src/stealth";
import { bytesToHex } from "../src/crypto";
import { initPoseidon } from "../src/poseidon";

async function main() {
  await initPoseidon();
  
  // Generate deterministic keys from a known seed
  const paddedSeed = new Uint8Array(32);
  const testString = new TextEncoder().encode("test-seed-frontend-123");
  paddedSeed.set(testString.slice(0, 32));
  
  console.log("=== Generating Test Keys ===");
  const keys = await deriveKeysFromSeed(paddedSeed);
  
  console.log("\nSpending privKey:", keys.spendingPrivKey.toString(16).padStart(64, "0").slice(0, 16) + "...");
  console.log("Viewing privKey:", keys.viewingPrivKey.toString(16).padStart(64, "0").slice(0, 16) + "...");

  // Create stealth meta address
  const stealthMeta = createStealthMetaAddress(keys);
  const encodedAddress = encodeStealthMetaAddress(stealthMeta);
  
  console.log("\n=== Stealth Address (for frontend 'Stealth Address' input) ===");
  console.log(encodedAddress);
  
  // Create a deposit to self
  console.log("\n=== Creating Test Deposit ===");
  const deposit = await createStealthDeposit(stealthMeta, 10000n);
  
  console.log("EphemeralPub:", bytesToHex(deposit.ephemeralPub));
  console.log("Commitment:", bytesToHex(deposit.commitment));
  console.log("EncryptedAmount:", bytesToHex(deposit.encryptedAmount));
  
  // Post to demo API
  console.log("\n=== Posting to Demo API ===");
  const response = await fetch("http://localhost:3000/api/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "stealth",
      ephemeralPub: bytesToHex(deposit.ephemeralPub),
      commitment: bytesToHex(deposit.commitment),
      encryptedAmount: bytesToHex(deposit.encryptedAmount),
      amount: "10000",
    }),
  });
  const result = await response.json();
  console.log("Response:", JSON.stringify(result, null, 2));
}

main().catch(console.error);
