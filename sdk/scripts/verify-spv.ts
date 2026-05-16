/**
 * Full SPV Verification Script
 *
 * Usage: bun run scripts/verify-spv.ts
 *
 * Steps:
 * 1. Close existing StealthAnnouncement PDA (if exists)
 * 2. Fetch raw tx from mempool.space
 * 3. Strip SegWit witness data
 * 4. Upload to ChadBuffer
 * 5. Build verify_transaction + complete_deposit instructions
 * 6. Submit both in one Solana transaction
 * 7. Close ChadBuffer to reclaim rent
 * 8. Read back the StealthAnnouncement to verify extracted amount
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

// =============================================================================
// Configuration
// =============================================================================

const SWEEP_TXID = "13bd8f9ddd793a2d16e2eb6c471fbfca5900777074cc2c36fccf090270bf2891";
const BLOCK_HEIGHT = 124329;
const BLOCK_HASH = "0000000000000002b5f7bcef6e8b36d099243c6968efc3a135c9360861fff03b";
const EPHEMERAL_PUB = "5dc2e592fcd7c25b97a03b1013356fcf62ba615db9bc75b10829a3735bcf6b90";
const NPK = "1a721b70e048c86e94e573785a5ffc26e30cb409d56b814b494878cf81b27227";
const AMOUNT_SATS = 9778; // Actual sweep output amount (not the old 10000)

// Program IDs
const UTXOPIA_PROGRAM_ID = new PublicKey("7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ");
const BTC_LIGHT_CLIENT_PROGRAM_ID = new PublicKey("Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq");
const CHADBUFFER_PROGRAM_ID = new PublicKey("C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ZKBTC_MINT = new PublicKey("4pLu3qTY3kNWvvftPG22XzXxWuRPkg7GHWW8hcnoUPgd");

// Merkle proof from mempool.space
const MERKLE_PROOF = {
  pos: 28,
  merkle: [
    "fe237a373798d7e62b5cf6e625452b3d97d2d7ab1069cc065ff5b14fc6834ee2",
    "9b222ed0b54e2e4ce9ded5658c64558caa79488969290da5a1e90137d0b9cb6d",
    "0c417dc6b737ba748a63b8c32095cced41394cacf12ed442351a20dccc64a9eb",
    "0cfd995e8ed8bd146a748c5dd74aa1cf670f7eb33ebd03b57c13a3a932982107",
    "c6578f76975ef43a90696889f20bdac14c5227ef54ad0299115adc6b734b51cc",
    "f055cb538b9f19b61bc2bead9b56f5552334d73e43d6ed942447b4ec15a48115",
    "6f9c95290cc8f10295d634bca310ee0f773ce9aa1460bed2ea3b7c64210a0ec3",
  ],
};

// Relayer keypair — load from RELAYER_KEYPAIR env var or file
const RELAYER_SECRET_PATH = process.env.RELAYER_KEYPAIR || "../backend/verifier-keypair.json";
const RELAYER_SECRET: number[] = JSON.parse(
  require("fs").readFileSync(RELAYER_SECRET_PATH, "utf-8")
);

const AUTHORITY_SIZE = 32;
const CHADBUFFER_INIT = 0;
const CHADBUFFER_WRITE = 2;
const CHADBUFFER_CLOSE = 3;
const FIRST_CHUNK_SIZE = 800;
const MAX_CHUNK_SIZE = 950;

// =============================================================================
// Helpers
// =============================================================================

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function reverseBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

function stripWitness(raw: Uint8Array): Uint8Array {
  if (raw.length < 6 || raw[4] !== 0x00 || raw[5] !== 0x01) {
    return raw;
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const result: number[] = [];

  result.push(raw[0], raw[1], raw[2], raw[3]);

  let offset = 6;

  function readVarInt(): number {
    const first = raw[offset++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const val = view.getUint16(offset, true);
      offset += 2;
      return val;
    }
    if (first === 0xfe) {
      const val = view.getUint32(offset, true);
      offset += 4;
      return val;
    }
    const lo = view.getUint32(offset, true);
    offset += 8;
    return lo;
  }

  function pushVarInt(n: number) {
    if (n < 0xfd) {
      result.push(n);
    } else if (n <= 0xffff) {
      result.push(0xfd, n & 0xff, (n >> 8) & 0xff);
    } else {
      result.push(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    }
  }

  const inputCount = readVarInt();
  pushVarInt(inputCount);
  for (let i = 0; i < inputCount; i++) {
    for (let j = 0; j < 36; j++) result.push(raw[offset++]);
    const scriptLen = readVarInt();
    pushVarInt(scriptLen);
    for (let j = 0; j < scriptLen; j++) result.push(raw[offset++]);
    for (let j = 0; j < 4; j++) result.push(raw[offset++]);
  }

  const outputCount = readVarInt();
  pushVarInt(outputCount);
  for (let i = 0; i < outputCount; i++) {
    for (let j = 0; j < 8; j++) result.push(raw[offset++]);
    const scriptLen = readVarInt();
    pushVarInt(scriptLen);
    for (let j = 0; j < scriptLen; j++) result.push(raw[offset++]);
  }

  const locktime = raw.slice(raw.length - 4);
  result.push(locktime[0], locktime[1], locktime[2], locktime[3]);

  return new Uint8Array(result);
}

function buildPathBits(txIndex: number, depth: number): number {
  let bits = 0;
  let index = txIndex;
  for (let i = 0; i < depth; i++) {
    if ((index & 1) === 1) {
      bits |= 1 << i;
    }
    index = index >> 1;
  }
  return bits;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const relayer = Keypair.fromSecretKey(Uint8Array.from(RELAYER_SECRET));
  console.log("Relayer:", relayer.publicKey.toBase58());

  const balance = await connection.getBalance(relayer.publicKey);
  console.log("Balance:", (balance / 1e9).toFixed(4), "SOL");

  // Derive internal byte order
  const txidInternal = reverseBytes(hexToBytes(SWEEP_TXID));
  const blockHashInternal = reverseBytes(hexToBytes(BLOCK_HASH));

  // Derive PDAs
  const [poolStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")], UTXOPIA_PROGRAM_ID
  );
  const [commitmentTreePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("commitment_tree")], UTXOPIA_PROGRAM_ID
  );
  const [stealthAnnouncementPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("stealth"), Buffer.from(txidInternal)], UTXOPIA_PROGRAM_ID
  );
  const [lightClientPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("btc_light_client")], BTC_LIGHT_CLIENT_PROGRAM_ID
  );
  const blockHeaderPDA = PublicKey.findProgramAddressSync(
    [Buffer.from("block"), Buffer.from(blockHashInternal)], BTC_LIGHT_CLIENT_PROGRAM_ID
  )[0];
  const [verifiedTxPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("verified_tx"), Buffer.from(blockHashInternal), Buffer.from(txidInternal)],
    BTC_LIGHT_CLIENT_PROGRAM_ID
  );
  const poolVaultATA = getAssociatedTokenAddressSync(
    ZKBTC_MINT, poolStatePDA, true, TOKEN_2022_PROGRAM_ID
  );

  console.log("\n--- PDAs ---");
  console.log("Pool State:", poolStatePDA.toBase58());
  console.log("Stealth PDA:", stealthAnnouncementPDA.toBase58());
  console.log("VerifiedTx:", verifiedTxPDA.toBase58());
  console.log("Block Header:", blockHeaderPDA.toBase58());

  // =========================================================================
  // Step 0: Update pool min_deposit to 5000 (if needed)
  // =========================================================================
  console.log("\n=== Step 0: Propose pool min_deposit update (timelocked) ===");
  {
    const NEW_MIN_DEPOSIT = 5000n;
    const MAX_DEPOSIT = 100_000_000_000n;
    const SERVICE_FEE = 0n;

    // propose_pool_update: disc(1) + min_deposit(8) + max_deposit(8) + service_fee(8) = 25 bytes
    const proposeData = Buffer.alloc(25);
    proposeData[0] = 21; // PROPOSE_POOL_UPDATE discriminator
    proposeData.writeBigUInt64LE(NEW_MIN_DEPOSIT, 1);
    proposeData.writeBigUInt64LE(MAX_DEPOSIT, 9);
    proposeData.writeBigUInt64LE(SERVICE_FEE, 17);

    const proposeIx = new TransactionInstruction({
      programId: UTXOPIA_PROGRAM_ID,
      keys: [
        { pubkey: poolStatePDA, isSigner: false, isWritable: true },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: false },
      ],
      data: proposeData,
    });

    const { blockhash: bh0 } = await connection.getLatestBlockhash();
    const proposeTx = new Transaction();
    proposeTx.add(proposeIx);
    proposeTx.feePayer = relayer.publicKey;
    proposeTx.recentBlockhash = bh0;

    const proposeSig = await sendAndConfirmTransaction(connection, proposeTx, [relayer], {
      commitment: "confirmed",
    });
    console.log("Pool update proposed (48h timelock). Sig:", proposeSig);
    console.log("NOTE: execute_pool_update (disc 22) must be called after timelock expires.");
  }

  // =========================================================================
  // Step 1: Close existing StealthAnnouncement PDA
  // =========================================================================
  console.log("\n=== Step 1: Close existing StealthAnnouncement PDA ===");

  const existingAccount = await connection.getAccountInfo(stealthAnnouncementPDA);
  if (existingAccount) {
    console.log("Existing StealthAnnouncement found, closing...");

    const closePdaIx = new TransactionInstruction({
      programId: UTXOPIA_PROGRAM_ID,
      keys: [
        { pubkey: poolStatePDA, isSigner: false, isWritable: false },
        { pubkey: stealthAnnouncementPDA, isSigner: false, isWritable: true },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      ],
      data: Buffer.from([16]), // ADMIN_CLOSE_PDA discriminator
    });

    const { blockhash: bh1 } = await connection.getLatestBlockhash();
    const closeTx = new Transaction();
    closeTx.add(closePdaIx);
    closeTx.feePayer = relayer.publicKey;
    closeTx.recentBlockhash = bh1;

    const closeSig = await sendAndConfirmTransaction(connection, closeTx, [relayer], {
      commitment: "confirmed",
    });
    console.log("Closed! Sig:", closeSig);
  } else {
    console.log("No existing StealthAnnouncement PDA, proceeding...");
  }

  // =========================================================================
  // Step 2: Fetch and strip raw tx
  // =========================================================================
  console.log("\n=== Step 2: Fetch raw transaction ===");

  const rawTxHex = await fetch(`https://mempool.space/testnet4/api/tx/${SWEEP_TXID}/hex`)
    .then(r => r.text());
  const fullTxBytes = hexToBytes(rawTxHex.trim());
  const rawTxBytes = stripWitness(fullTxBytes);
  console.log(`Full: ${fullTxBytes.length} bytes, Non-witness: ${rawTxBytes.length} bytes`);

  // =========================================================================
  // Step 3: Upload to ChadBuffer
  // =========================================================================
  console.log("\n=== Step 3: Upload to ChadBuffer ===");

  const bufferKeypair = Keypair.generate();
  const bufferSize = AUTHORITY_SIZE + rawTxBytes.length;
  const rentExemption = await connection.getMinimumBalanceForRentExemption(bufferSize);

  const firstChunkSize = Math.min(FIRST_CHUNK_SIZE, rawTxBytes.length);
  const firstChunk = rawTxBytes.slice(0, firstChunkSize);

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: relayer.publicKey,
    newAccountPubkey: bufferKeypair.publicKey,
    lamports: rentExemption,
    space: bufferSize,
    programId: CHADBUFFER_PROGRAM_ID,
  });

  const initData = Buffer.alloc(1 + firstChunk.length);
  initData[0] = CHADBUFFER_INIT;
  Buffer.from(firstChunk).copy(initData, 1);

  const initIx = new TransactionInstruction({
    programId: CHADBUFFER_PROGRAM_ID,
    keys: [
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bufferKeypair.publicKey, isSigner: true, isWritable: true },
    ],
    data: initData,
  });

  const { blockhash: bh2 } = await connection.getLatestBlockhash();
  const bufferTx = new Transaction();
  bufferTx.add(createAccountIx, initIx);
  bufferTx.feePayer = relayer.publicKey;
  bufferTx.recentBlockhash = bh2;

  const bufferSig = await sendAndConfirmTransaction(connection, bufferTx, [relayer, bufferKeypair], {
    commitment: "confirmed",
  });
  console.log("Buffer created:", bufferKeypair.publicKey.toBase58(), "sig:", bufferSig);

  // Write remaining chunks if needed
  let dataOffset = firstChunkSize;
  while (dataOffset < rawTxBytes.length) {
    const chunkSize = Math.min(MAX_CHUNK_SIZE, rawTxBytes.length - dataOffset);
    const chunk = rawTxBytes.slice(dataOffset, dataOffset + chunkSize);
    const bufferOffset = AUTHORITY_SIZE + dataOffset;

    const writeData = Buffer.alloc(4 + chunk.length);
    writeData[0] = CHADBUFFER_WRITE;
    writeData[1] = bufferOffset & 0xff;
    writeData[2] = (bufferOffset >> 8) & 0xff;
    writeData[3] = (bufferOffset >> 16) & 0xff;
    Buffer.from(chunk).copy(writeData, 4);

    const writeIx = new TransactionInstruction({
      programId: CHADBUFFER_PROGRAM_ID,
      keys: [
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
      ],
      data: writeData,
    });

    const { blockhash } = await connection.getLatestBlockhash();
    const writeTx = new Transaction();
    writeTx.add(writeIx);
    writeTx.feePayer = relayer.publicKey;
    writeTx.recentBlockhash = blockhash;

    await sendAndConfirmTransaction(connection, writeTx, [relayer], {
      commitment: "confirmed",
    });
    dataOffset += chunkSize;
  }
  console.log("Buffer upload complete");

  // =========================================================================
  // Step 4: Build verify_transaction instruction (btc-light-client, disc=2)
  // =========================================================================
  console.log("\n=== Step 4: Build verify instructions ===");

  const merkleSiblings = MERKLE_PROOF.merkle.map((hash) =>
    reverseBytes(hexToBytes(hash))
  );
  const pathBits = buildPathBits(MERKLE_PROOF.pos, merkleSiblings.length);
  const pathLen = merkleSiblings.length;

  // disc(1) + txid(32) + blockHash(32) + txSize(4) + proofTxid(32) + pathBits(4) + pathLen(1) + txIndex(4) + siblings(32*N)
  const verifyTxDataSize = 1 + 32 + 32 + 4 + 32 + 4 + 1 + 4 + 32 * pathLen;
  const verifyTxData = Buffer.alloc(verifyTxDataSize);
  let off = 0;

  verifyTxData[off++] = 2; // discriminator
  Buffer.from(txidInternal).copy(verifyTxData, off); off += 32;
  Buffer.from(blockHashInternal).copy(verifyTxData, off); off += 32;
  verifyTxData.writeUInt32LE(rawTxBytes.length, off); off += 4;

  // Merkle proof
  Buffer.from(txidInternal).copy(verifyTxData, off); off += 32; // proof_txid = txid
  verifyTxData.writeUInt32LE(pathBits, off); off += 4;
  verifyTxData[off++] = pathLen;
  verifyTxData.writeUInt32LE(MERKLE_PROOF.pos, off); off += 4;
  for (const sibling of merkleSiblings) {
    Buffer.from(sibling).copy(verifyTxData, off); off += 32;
  }

  const verifyTxIx = new TransactionInstruction({
    programId: BTC_LIGHT_CLIENT_PROGRAM_ID,
    keys: [
      { pubkey: verifiedTxPDA, isSigner: false, isWritable: true },
      { pubkey: lightClientPDA, isSigner: false, isWritable: false },
      { pubkey: blockHeaderPDA, isSigner: false, isWritable: false },
      { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: false },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: verifyTxData,
  });

  // =========================================================================
  // Step 5: Build complete_deposit instruction (utxopia, disc=1)
  //         Amount is NO LONGER in instruction data — extracted on-chain from raw tx
  // =========================================================================

  const ephemeralPubBytes = hexToBytes(EPHEMERAL_PUB);
  const npkBytes = hexToBytes(NPK);

  // disc(1) + txid(32) + block_height(8) + tx_size(4) + ephemeral_pub(32) + npk(32) = 109
  const verifyDepositData = Buffer.alloc(109);
  let doff = 0;
  verifyDepositData[doff++] = 1; // discriminator
  Buffer.from(txidInternal).copy(verifyDepositData, doff); doff += 32;
  verifyDepositData.writeBigUInt64LE(BigInt(BLOCK_HEIGHT), doff); doff += 8;
  verifyDepositData.writeUInt32LE(rawTxBytes.length, doff); doff += 4;
  Buffer.from(ephemeralPubBytes).copy(verifyDepositData, doff); doff += 32;
  Buffer.from(npkBytes).copy(verifyDepositData, doff); doff += 32;

  const verifyDepositIx = new TransactionInstruction({
    programId: UTXOPIA_PROGRAM_ID,
    keys: [
      { pubkey: poolStatePDA, isSigner: false, isWritable: true },
      { pubkey: verifiedTxPDA, isSigner: false, isWritable: false },
      { pubkey: lightClientPDA, isSigner: false, isWritable: false },
      { pubkey: commitmentTreePDA, isSigner: false, isWritable: true },
      { pubkey: stealthAnnouncementPDA, isSigner: false, isWritable: true },
      { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: false },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ZKBTC_MINT, isSigner: false, isWritable: true },
      { pubkey: poolVaultATA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: verifyDepositData,
  });

  // =========================================================================
  // Step 6: Submit both instructions
  // =========================================================================
  console.log("\n=== Step 5: Submit verification transaction ===");

  const { blockhash: bh3 } = await connection.getLatestBlockhash();
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    verifyTxIx,
    verifyDepositIx
  );
  tx.feePayer = relayer.publicKey;
  tx.recentBlockhash = bh3;

  const sig = await sendAndConfirmTransaction(connection, tx, [relayer], {
    commitment: "confirmed",
  });
  console.log("\n✅ VERIFICATION CONFIRMED!");
  console.log("Signature:", sig);
  console.log("Explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet");

  // =========================================================================
  // Step 7: Close ChadBuffer
  // =========================================================================
  console.log("\n=== Step 6: Close ChadBuffer ===");

  try {
    const closeIx = new TransactionInstruction({
      programId: CHADBUFFER_PROGRAM_ID,
      keys: [
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([CHADBUFFER_CLOSE]),
    });

    const { blockhash: bh4 } = await connection.getLatestBlockhash();
    const closeTx = new Transaction();
    closeTx.add(closeIx);
    closeTx.feePayer = relayer.publicKey;
    closeTx.recentBlockhash = bh4;

    await sendAndConfirmTransaction(connection, closeTx, [relayer], {
      commitment: "confirmed",
    });
    console.log("Buffer closed, rent reclaimed");
  } catch (e) {
    console.warn("Failed to close buffer (non-critical):", e);
  }

  // =========================================================================
  // Step 8: Read back StealthAnnouncement to verify amount
  // =========================================================================
  console.log("\n=== Step 7: Verify on-chain StealthAnnouncement ===");

  const announcementAccount = await connection.getAccountInfo(stealthAnnouncementPDA);
  if (announcementAccount) {
    const buf = Buffer.from(announcementAccount.data);
    const discriminator = buf[0];
    const announcementType = buf[1];
    const ephPub = buf.slice(2, 34).toString("hex");
    const amountOnChain = buf.readBigUInt64LE(34);
    const commitment = buf.slice(42, 74).toString("hex");
    const leafIndex = buf.readBigUInt64LE(74);
    const createdAt = buf.readBigInt64LE(82);

    console.log("Discriminator:", discriminator);
    console.log("Type:", announcementType === 0 ? "deposit" : "transfer");
    console.log("EphemeralPub:", ephPub);
    console.log("Amount (on-chain extracted):", amountOnChain.toString(), "sats");
    console.log("Commitment:", commitment);
    console.log("Leaf Index:", leafIndex.toString());
    console.log("Created At:", new Date(Number(createdAt) * 1000).toISOString());

    if (amountOnChain === BigInt(9778)) {
      console.log("\n🎉 SUCCESS! On-chain amount matches actual sweep output (9778 sats)");
      console.log("   Previous (trusted caller): 10000 sats");
      console.log("   Now (extracted from tx):   9778 sats");
      console.log("   Difference (mining fee):   222 sats");
    } else {
      console.log(`\n⚠️  Amount mismatch: expected 9778, got ${amountOnChain}`);
    }
  } else {
    console.log("ERROR: StealthAnnouncement not found after verification");
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
