/**
 * Test SNS resolver against devnet alice.utxopia.sol
 */
import { resolveSnsName, resolveStealthName, isSnsStealthAddress } from "../src/sns-resolver";
import { setConfig, getConfig } from "../src/config";
import { createFetchConnectionAdapter } from "../src/solana/connection";

async function main() {
  setConfig("devnet");
  const config = getConfig();
  console.log("Network:", config.network);
  console.log("SNS Name Service:", config.snsNameServiceProgramId);
  console.log("SNS Registrar:", config.snsRegistrarProgramId);
  console.log("SNS Sub-Registrar:", config.snsSubRegistrarProgramId);
  console.log("Parent Domain:", config.snsParentDomain);

  const conn = createFetchConnectionAdapter(config.solanaRpcUrl);

  // Test 1: Resolve "alice" (bare name)
  console.log("\n--- Test 1: resolveSnsName('alice') ---");
  const r1 = await resolveSnsName(conn, "alice");
  if (r1) {
    console.log("Name:", r1.name);
    console.log("Full domain:", r1.fullDomain);
    console.log("Version:", r1.version);
    console.log("SpendingPubKey:", Buffer.from(r1.spendingPubKey).toString("hex"));
    console.log("ViewingPubKey:", Buffer.from(r1.viewingPubKey).toString("hex"));
  } else {
    console.log("NOT FOUND");
  }

  // Test 2: Resolve "alice.utxopia.sol" (full domain)
  console.log("\n--- Test 2: resolveSnsName('alice.utxopia.sol') ---");
  const r2 = await resolveSnsName(conn, "alice.utxopia.sol");
  console.log(r2 ? `Found: ${r2.fullDomain}` : "NOT FOUND");

  // Test 3: Unified resolver
  console.log("\n--- Test 3: resolveStealthName('alice') ---");
  const r3 = await resolveStealthName(conn, "alice");
  if (r3) {
    console.log("Is SNS:", isSnsStealthAddress(r3));
    console.log("SpendingPubKey:", Buffer.from(r3.spendingPubKey).toString("hex"));
  } else {
    console.log("NOT FOUND");
  }

  // Test 4: Non-existent
  console.log("\n--- Test 4: resolveSnsName('nonexistent999') ---");
  const r4 = await resolveSnsName(conn, "nonexistent999");
  console.log(r4 ? "FOUND (unexpected)" : "NOT FOUND (expected)");
}

main().catch(console.error);
