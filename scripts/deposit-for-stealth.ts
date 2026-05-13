#!/usr/bin/env bun
/**
 * One-shot helper: take a `utxo:` stealth address and print the BTC Taproot
 * deposit address + 64-byte OP_RETURN payload the user should attach to
 * their deposit transaction.
 *
 * No broadcasting — output is paste-into-your-own-wallet shape.
 *
 * Usage:
 *   bun run scripts/deposit-for-stealth.ts utxo:<hex>
 *   bun run scripts/deposit-for-stealth.ts utxo:<hex> --network devnet-regtest
 *   bun run scripts/deposit-for-stealth.ts utxo:<hex> --network localnet
 *
 * Defaults to the `devnet` profile (devnet Solana + testnet4 BTC), since that
 * matches `web/.env.local`.
 */

import {
  decodeStealthMetaAddress,
  createNonInteractiveDeposit,
} from "../sdk/src/index";
import networks from "../web/src/lib/networks.json";

type NetworkKey = keyof typeof networks;

function parseArgs(argv: string[]): { stealth: string; network: NetworkKey } {
  const args = argv.slice(2);
  let network: NetworkKey = "devnet";
  let stealth: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--network" || a === "-n") {
      const n = args[++i];
      if (!(n in networks)) {
        throw new Error(`unknown network "${n}"; valid: ${Object.keys(networks).join(", ")}`);
      }
      network = n as NetworkKey;
    } else if (!stealth) {
      stealth = a;
    }
  }
  if (!stealth) {
    throw new Error("missing stealth address (expected a `utxo:` string as the first positional arg)");
  }
  return { stealth, network };
}

function hex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function main(): Promise<void> {
  const { stealth, network } = parseArgs(process.argv);
  const cfg = networks[network];
  if (!cfg) throw new Error(`network "${network}" not present in networks.json`);

  const btcNet = (cfg as any).bitcoin?.network as "mainnet" | "testnet4" | "regtest" | undefined;
  if (!btcNet) throw new Error(`network "${network}" has no bitcoin.network`);
  // SDK type accepts mainnet | testnet | regtest — testnet4 maps to testnet for address encoding.
  const sdkBtcNet = btcNet === "testnet4" ? "testnet" : btcNet;

  const groupPubkeyHex = (cfg as any).bitcoin?.groupPubkey as string | undefined;
  if (!groupPubkeyHex) throw new Error(`network "${network}" has no bitcoin.groupPubkey`);
  const groupPubkey = Uint8Array.from(Buffer.from(groupPubkeyHex, "hex"));
  if (groupPubkey.length !== 32) {
    throw new Error(`groupPubkey must be 32 bytes (x-only); got ${groupPubkey.length}`);
  }

  const meta = decodeStealthMetaAddress(stealth);
  const deposit = await createNonInteractiveDeposit(meta, groupPubkey, sdkBtcNet as any);

  console.log("");
  console.log("┌──────────────────────────────────────────────────────────────────────────┐");
  console.log("│ UTXOpia non-interactive deposit                                         │");
  console.log("├──────────────────────────────────────────────────────────────────────────┤");
  console.log(`│ Network         │ ${network} (${btcNet})`);
  console.log(`│ Pool group key  │ ${groupPubkeyHex}`);
  console.log(`│ Stealth address │ ${stealth.slice(0, 24)}…${stealth.slice(-12)}`);
  console.log("└──────────────────────────────────────────────────────────────────────────┘");
  console.log("");
  console.log("→ Send any BTC amount to:");
  console.log("");
  console.log(`     ${deposit.btcAddress}`);
  console.log("");
  console.log("→ Attach a single OP_RETURN output with these exact 64 bytes:");
  console.log("");
  console.log(`     ${hex(deposit.opReturnPayload)}`);
  console.log("");
  console.log("   Breakdown:");
  console.log(`     ephemeralPub (32B): ${hex(deposit.ephemeralPub)}`);
  console.log(`     npk          (32B): ${hex(deposit.npk)}`);
  console.log("");
  console.log("Notes:");
  console.log("  • The commitment is computed on-chain from (npk, ZKBTC_TOKEN_ID, actual sats received).");
  console.log("  • You can send any amount; minimum is bound by the fee schedule, not by this script.");
  console.log("  • In Sparrow / similar: add a second output `OP_RETURN <hex above>` with 0 sats.");
  console.log("  • Sweep + SPV happen automatically once the backend tracker sees the tx.");
  console.log("");
}

main().catch((e) => {
  console.error(`[deposit-for-stealth] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
