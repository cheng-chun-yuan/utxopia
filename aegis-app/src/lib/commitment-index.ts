/**
 * Server-Side Commitment Tree Index
 *
 * Maintains a persistent commitment tree index for Merkle proof generation.
 * Uses the SDK's CommitmentTreeIndex with JSON file persistence.
 *
 * This module is server-only (runs in Next.js API routes).
 */

import {
  CommitmentTreeIndex,
  DEVNET_CONFIG,
  parseCommitmentTreeData,
  parseProgramEvents,
  type StealthAnnouncementEvent,
  initPoseidon,
} from "@aegis/sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { PublicKey } from "@solana/web3.js";
import { getHeliusConnection } from "./helius-server";

// Aegis Program ID from SDK
const AEGIS_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.aegisProgramId);

// Storage path for the commitment index
const DATA_DIR = process.cwd() + "/data";
const INDEX_FILE = DATA_DIR + "/commitment-index.json";

// Commitment tree PDA - from SDK config (single source of truth)
const COMMITMENT_TREE_ADDRESS = DEVNET_CONFIG.commitmentTreePda;

// Server-side singleton
let serverIndex: CommitmentTreeIndex | null = null;

// Poseidon initialization state
let poseidonInitialized = false;
let poseidonInitPromise: Promise<void> | null = null;

/**
 * Ensure Poseidon is initialized (required for Merkle tree operations)
 */
async function ensurePoseidonInit(): Promise<void> {
  if (poseidonInitialized) return;
  if (poseidonInitPromise) return poseidonInitPromise;

  poseidonInitPromise = initPoseidon().then(() => {
    poseidonInitialized = true;
    console.log("[CommitmentIndex] Poseidon initialized");
  });

  return poseidonInitPromise;
}

/**
 * Get or create the server-side commitment index singleton
 */
export function getServerCommitmentIndex(): CommitmentTreeIndex {
  if (!serverIndex) {
    serverIndex = new CommitmentTreeIndex();

    // Try to load from file
    try {
      if (existsSync(INDEX_FILE)) {
        const stored = readFileSync(INDEX_FILE, "utf-8");
        serverIndex.import(JSON.parse(stored));
        console.log(
          `[CommitmentIndex] Loaded ${serverIndex.size()} commitments from ${INDEX_FILE}`
        );
      }
    } catch (e) {
      console.warn("[CommitmentIndex] Failed to load from file:", e);
    }
  }
  return serverIndex;
}

/**
 * Save the commitment index to disk
 */
export function saveServerCommitmentIndex(): void {
  if (!serverIndex) return;

  try {
    // Ensure data directory exists
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }

    const data = serverIndex.export();
    writeFileSync(INDEX_FILE, JSON.stringify(data, null, 2));
    console.log(
      `[CommitmentIndex] Saved ${serverIndex.size()} commitments to ${INDEX_FILE}`
    );
  } catch (e) {
    console.error("[CommitmentIndex] Failed to save to file:", e);
    throw e;
  }
}

/**
 * Add a commitment to the index and persist
 * Note: This is async because Poseidon must be initialized first
 */
export async function addCommitmentToIndex(
  commitment: bigint,
  amount: bigint
): Promise<{ leafIndex: bigint; root: bigint }> {
  // Ensure Poseidon is initialized for Merkle tree hashing
  await ensurePoseidonInit();

  const index = getServerCommitmentIndex();
  const leafIndex = index.addCommitment(commitment, amount);
  saveServerCommitmentIndex();

  return {
    leafIndex,
    root: index.getRoot(),
  };
}

/**
 * Get Merkle proof for a commitment
 * Note: This is async because Poseidon must be initialized first for proof generation
 */
export async function getMerkleProof(commitment: bigint): Promise<{
  siblings: bigint[];
  indices: number[];
  leafIndex: bigint;
  root: bigint;
} | null> {
  // Ensure Poseidon is initialized for Merkle proof computation
  await ensurePoseidonInit();

  const index = getServerCommitmentIndex();
  return index.getMerkleProof(commitment);
}

/**
 * Get tree status
 */
export function getTreeStatus(): {
  root: string;
  nextIndex: number;
  size: number;
} {
  const index = getServerCommitmentIndex();
  return {
    root: index.getRoot().toString(16).padStart(64, "0"),
    nextIndex: index.size(),
    size: index.size(),
  };
}

/**
 * Fetch on-chain commitment tree state using SDK's parseCommitmentTreeData
 */
export async function fetchOnChainTreeState(): Promise<{
  currentRoot: string;
  nextIndex: bigint;
  rootHistoryIndex: number;
}> {
  const connection = getHeliusConnection("devnet");
  const pubkey = new PublicKey(COMMITMENT_TREE_ADDRESS);
  const accountInfo = await connection.getAccountInfo(pubkey);

  if (!accountInfo) {
    throw new Error("Commitment tree account not found on-chain");
  }

  // Use SDK's parseCommitmentTreeData (handles discriminator validation + parsing)
  const state = parseCommitmentTreeData(new Uint8Array(accountInfo.data));

  return {
    currentRoot: Buffer.from(state.currentRoot).toString("hex"),
    nextIndex: state.nextIndex,
    rootHistoryIndex: state.rootHistoryIndex,
  };
}

/**
 * Check if local index is synced with on-chain state
 */
export async function checkSyncStatus(): Promise<{
  localRoot: string;
  onChainRoot: string;
  localSize: number;
  onChainNextIndex: bigint;
  synced: boolean;
}> {
  const local = getTreeStatus();
  const onChain = await fetchOnChainTreeState();

  return {
    localRoot: local.root,
    onChainRoot: onChain.currentRoot,
    localSize: local.size,
    onChainNextIndex: onChain.nextIndex,
    synced: local.root === onChain.currentRoot,
  };
}

/**
 * Sync local index from on-chain transaction log events.
 *
 * Scans program transaction logs for stealth announcement events (disc=0x03)
 * and leaf_inserted events (disc=0x01) to rebuild the local commitment index.
 */
export async function syncFromOnChain(): Promise<{
  synced: number;
  skipped: number;
  root: string;
}> {
  // Ensure Poseidon is initialized for Merkle tree hashing
  await ensurePoseidonInit();

  const connection = getHeliusConnection("devnet");

  console.log("[CommitmentIndex] Fetching commitments from transaction events...");

  // Fetch tree state to get nextIndex
  let treeNextIndex = Number.MAX_SAFE_INTEGER;
  try {
    const treePda = new PublicKey(COMMITMENT_TREE_ADDRESS);
    const treeAccount = await connection.getAccountInfo(treePda);
    if (treeAccount) {
      const treeState = parseCommitmentTreeData(new Uint8Array(treeAccount.data));
      treeNextIndex = Number(treeState.nextIndex);
      console.log(`[CommitmentIndex] Tree nextIndex: ${treeNextIndex}`);
    }
  } catch (e) {
    console.warn("[CommitmentIndex] Failed to fetch tree state:", e);
  }

  // Try backend indexer first (has full history in SQLite)
  const commitments: Array<{ commitment: bigint; leafIndex: number; amount: bigint }> = [];
  let fromBackend = false;

  try {
    const backendUrl = process.env.BACKEND_URL || "http://localhost:8080";
    const resp = await fetch(`${backendUrl}/api/announcements`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json();
      for (const a of data.announcements) {
        if (a.leaf_index >= treeNextIndex) continue;
        // commitment is hex string from backend
        const commitmentBigint = BigInt("0x" + a.commitment);
        commitments.push({
          commitment: commitmentBigint,
          leafIndex: a.leaf_index,
          amount: 0n,
        });
      }
      fromBackend = true;
      console.log(`[CommitmentIndex] Fetched ${commitments.length} commitments from backend`);
    }
  } catch {
    console.warn("[CommitmentIndex] Backend unavailable, falling back to RPC event scanning");
  }

  // Fallback: scan transaction logs directly
  if (!fromBackend) {
    const signatures = await connection.getSignaturesForAddress(AEGIS_PROGRAM_ID, { limit: 1000 }, "confirmed");
    console.log(`[CommitmentIndex] Scanning ${signatures.length} transactions for events...`);

    const BATCH_SIZE = 20;
    for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
      const batch = signatures.slice(i, i + BATCH_SIZE);
      const txResults = await Promise.all(
        batch.map((sig) =>
          connection.getTransaction(sig.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
        )
      );

      for (const tx of txResults) {
        if (!tx?.meta?.logMessages) continue;
        const events = parseProgramEvents(tx.meta.logMessages);
        for (const event of events) {
          if (event.type !== "stealth_announcement") continue;
          const sa = event as StealthAnnouncementEvent;
          if (sa.leafIndex >= treeNextIndex) continue;

          let commitmentBigint = 0n;
          for (let j = 0; j < sa.commitment.length; j++) {
            commitmentBigint = (commitmentBigint << 8n) | BigInt(sa.commitment[j]);
          }
          commitments.push({
            commitment: commitmentBigint,
            leafIndex: sa.leafIndex,
            amount: 0n,
          });
        }
      }
    }
  }

  // Sort by leaf index and deduplicate
  commitments.sort((a, b) => a.leafIndex - b.leafIndex);
  const deduped: typeof commitments = [];
  for (const c of commitments) {
    if (deduped.length > 0 && deduped[deduped.length - 1].leafIndex === c.leafIndex) {
      deduped[deduped.length - 1] = c;
    } else {
      deduped.push(c);
    }
  }

  console.log(`[CommitmentIndex] ${deduped.length} valid commitments after dedup`);

  // Reset and rebuild index
  serverIndex = new CommitmentTreeIndex();
  let synced = 0;
  let skipped = 0;

  for (const { commitment, leafIndex, amount } of deduped) {
    try {
      const addedIndex = serverIndex.addCommitment(commitment, amount);
      const addedIndexNum = Number(addedIndex);
      if (addedIndexNum === leafIndex) {
        synced++;
      } else {
        console.warn(`[CommitmentIndex] Leaf index mismatch: expected ${leafIndex}, got ${addedIndex}`);
        skipped++;
      }
    } catch (e) {
      console.warn("[CommitmentIndex] Failed to add commitment:", e);
      skipped++;
    }
  }

  // Save to disk
  saveServerCommitmentIndex();

  const root = serverIndex.getRoot().toString(16).padStart(64, "0");
  console.log(`[CommitmentIndex] Synced ${synced} commitments, root: ${root.slice(0, 16)}...`);

  return { synced, skipped, root };
}
