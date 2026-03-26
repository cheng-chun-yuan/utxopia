#!/usr/bin/env bun
/**
 * Execute a pending pool parameter update after timelock expires.
 * Usage: bun run scripts/execute-pool-update.ts
 */

import { TransactionInstruction } from "@solana/web3.js";
import { buildExecutePoolUpdateInstructionData } from "@aegis/sdk";
import { setupScript, sendTx } from "./lib/common.ts";

async function main() {
  const { conn, authority, programId, poolState } = setupScript();
  const poolAccount = await conn.getAccountInfo(poolState);
  if (!poolAccount) { console.error("Pool state not found!"); process.exit(1); }

  const d = poolAccount.data;
  const executeAfter = Number(d.readBigInt64LE(236));
  if (executeAfter === 0) { console.log("No pending proposal."); return; }

  const remaining = executeAfter - Math.floor(Date.now() / 1000);
  if (remaining > 0) {
    console.log(`Timelock not expired. ${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m remaining.`);
    process.exit(1);
  }

  const ixData = buildExecutePoolUpdateInstructionData();

  const sig = await sendTx(conn, authority, new TransactionInstruction({
    programId,
    keys: [{ pubkey: poolState, isSigner: false, isWritable: true }],
    data: Buffer.from(ixData),
  }));
  console.log("Executed!", sig);

  const updated = await conn.getAccountInfo(poolState);
  if (updated) {
    console.log("New fee_base:", updated.data.readBigUInt64LE(196).toString());
    console.log("New fee_bps:", updated.data.readUInt16LE(244));
  }
}

main().catch(err => { console.error("Failed:", err.message); process.exit(1); });
