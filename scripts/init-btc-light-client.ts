#!/usr/bin/env bun
/**
 * Initialize BTC Light Client with genesis block from mempool.space.
 *
 * Usage: bun run scripts/init-btc-light-client.ts
 *
 * Env vars:
 *   BTC_LIGHT_CLIENT_PROGRAM_ID — required (env var or state file)
 *   BTC_API_URL      — mempool API base (default: https://mempool.space/testnet4/api)
 *   BTC_NETWORK_ID   — 0=mainnet, 1=testnet3, 2=testnet4, 3=regtest (default: 2)
 */

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { loadKeypair, loadState, sendTx, detectNetwork } from "./lib/common.ts";
import { Connection } from "@solana/web3.js";

const BTC_NETWORK_ID = parseInt(process.env.BTC_NETWORK_ID || "2", 10);
const BTC_API_URL = process.env.BTC_API_URL || "https://mempool.space/testnet4/api";

function resolveBtcLcId(): PublicKey {
  if (process.env.BTC_LIGHT_CLIENT_PROGRAM_ID) {
    return new PublicKey(process.env.BTC_LIGHT_CLIENT_PROGRAM_ID);
  }
  const state = loadState();
  if (state.btcLightClientId) return new PublicKey(state.btcLightClientId);
  throw new Error("BTC_LIGHT_CLIENT_PROGRAM_ID required (env var or state file)");
}

function hexToBytesReversed(hex: string): Buffer {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[31 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return buf;
}

async function main() {
  const rpcUrl = process.env.RPC_URL || (detectNetwork() === "localnet" ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com");
  const conn = new Connection(rpcUrl, "confirmed");
  const authority = loadKeypair();
  const btcLcId = resolveBtcLcId();

  console.log("BTC Light Client:", btcLcId.toBase58());
  console.log("Authority:", authority.publicKey.toBase58());

  const [lightClientPda] = PublicKey.findProgramAddressSync([Buffer.from("btc_light_client")], btcLcId);
  const existing = await conn.getAccountInfo(lightClientPda);
  if (existing?.data?.length && existing.data[0] === 0x01) {
    console.log("Already initialized — skipping");
    return;
  }

  console.log("Fetching tip...");
  const tipHeight = parseInt(await (await fetch(`${BTC_API_URL}/blocks/tip/height`)).text(), 10);
  const startHeight = tipHeight - 10;
  const blockHashHex = await (await fetch(`${BTC_API_URL}/block-height/${startHeight}`)).text();
  const blockHashBytes = hexToBytesReversed(blockHashHex);

  const heightBuf = Buffer.alloc(8);
  heightBuf.writeBigUInt64LE(BigInt(startHeight));
  const [heightIndexPda] = PublicKey.findProgramAddressSync([Buffer.from("height_index"), heightBuf], btcLcId);
  const [blockHeaderPda] = PublicKey.findProgramAddressSync([Buffer.from("block"), blockHashBytes], btcLcId);

  const data = Buffer.alloc(42);
  data[0] = 0; // INITIALIZE
  data.writeBigUInt64LE(BigInt(startHeight), 1);
  blockHashBytes.copy(data, 9);
  data[41] = BTC_NETWORK_ID;

  const sig = await sendTx(conn, authority, new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: heightIndexPda, isSigner: false, isWritable: true },
      { pubkey: blockHeaderPda, isSigner: false, isWritable: true },
    ],
    programId: btcLcId,
    data,
  }));
  console.log(`Initialized! height=${startHeight} sig=${sig}`);
}

main().catch(err => { console.error("Error:", err.message || err); process.exit(1); });
