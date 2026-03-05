import {
  resolveSnsName,
  resolveStealthName,
  isSnsStealthAddress,
  setConfig,
  getConfig,
  createFetchConnectionAdapter,
} from "@aegis/sdk";

async function main() {
  // Use devnet config
  setConfig("devnet");
  const config = getConfig();
  console.log("Network:", config.network);
  console.log("SNS Name Service:", config.snsNameServiceProgramId);
  console.log("SNS Parent Domain:", config.snsParentDomain);

  // Create connection adapter
  const conn = createFetchConnectionAdapter(config.solanaRpcUrl);

  // Test 1: Resolve "alice" (bare name)
  console.log("\n--- Test 1: resolveSnsName('alice') ---");
  const result1 = await resolveSnsName(conn, "alice");
  if (result1) {
    console.log("Name:", result1.name);
    console.log("Full domain:", result1.fullDomain);
    console.log("Version:", result1.version);
    console.log("SpendingPubKey:", result1.stealthMetaAddressHex.slice(0, 64));
    console.log("ViewingPubKey:", result1.stealthMetaAddressHex.slice(64));
  } else {
    console.log("NOT FOUND");
  }

  // Test 2: Resolve "alice.btcpro.sol" (full domain)
  console.log("\n--- Test 2: resolveSnsName('alice.btcpro.sol') ---");
  const result2 = await resolveSnsName(conn, "alice.btcpro.sol");
  if (result2) {
    console.log("Name:", result2.name);
    console.log("Full domain:", result2.fullDomain);
  } else {
    console.log("NOT FOUND");
  }

  // Test 3: Unified resolver
  console.log("\n--- Test 3: resolveStealthName('alice') ---");
  const result3 = await resolveStealthName(conn, "alice");
  if (result3) {
    console.log("Is SNS:", isSnsStealthAddress(result3));
    console.log("SpendingPubKey:", Buffer.from(result3.spendingPubKey).toString("hex"));
    console.log("ViewingPubKey:", Buffer.from(result3.viewingPubKey).toString("hex"));
  } else {
    console.log("NOT FOUND");
  }

  // Test 4: Non-existent name
  console.log("\n--- Test 4: resolveSnsName('nonexistent') ---");
  const result4 = await resolveSnsName(conn, "nonexistent");
  console.log("Result:", result4 ? "FOUND" : "NOT FOUND (expected)");
}

main().catch(console.error);
