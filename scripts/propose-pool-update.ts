#!/usr/bin/env bun
/**
 * Propose pool parameter update (48h timelock).
 * Usage: bun run scripts/propose-pool-update.ts [--fee-base 2000] [--fee-bps 30]
 */

import { TransactionInstruction } from "@solana/web3.js";
import { buildProposePoolUpdateInstructionData } from "@privacy-coin/sdk";
import { setupScript, sendTx } from "./lib/common.ts";

const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

async function main() {
  const { conn, authority, programId, poolState } = setupScript();
  const poolAccount = await conn.getAccountInfo(poolState);
  if (!poolAccount) { console.error("Pool state not found!"); process.exit(1); }

  const d = poolAccount.data;
  const currentMinDeposit = d.readBigUInt64LE(172);
  const currentMaxDeposit = d.readBigUInt64LE(180);
  console.log("Current fee_base:", d.readBigUInt64LE(196).toString(), "fee_bps:", d.readUInt16LE(244));

  const newFeeBase = BigInt(getArg("--fee-base", "2000"));
  const newFeeBps = parseInt(getArg("--fee-bps", "30"), 10);
  console.log("Proposed fee_base:", newFeeBase.toString(), "fee_bps:", newFeeBps);

  const ixData = buildProposePoolUpdateInstructionData(
    currentMinDeposit, currentMaxDeposit, newFeeBase, newFeeBps,
  );

  const sig = await sendTx(conn, authority, new TransactionInstruction({
    programId,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(ixData),
  }));
  console.log("Proposal submitted!", sig);
  console.log("Run `bun run scripts/execute-pool-update.ts` after 48h.");
}

main().catch(err => { console.error("Failed:", err.message); process.exit(1); });
