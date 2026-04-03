#!/usr/bin/env bun
/**
 * Shared module for E2E localnet tests
 *
 * Exports: connection, authority, program IDs, PDA derivations, helpers, constants.
 * Reads/writes localnet-state.json for inter-step persistence.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

// =============================================================================
// SDK Re-exports — use these instead of reimplementing crypto/merkle/instructions
// =============================================================================

// Import SDK functions for local use + re-export
import {
  initPoseidon as _initPoseidon,
  poseidonHashSync as _poseidonHashSync,
  computeNPKSync as _computeNPKSync,
  computeMPKSync as _computeMPKSync,
  computeJoinSplitCommitmentSync as _computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync as _computeJoinSplitNullifierSync,
  bigintToBytes as _bigintToBytes,
  bytesToBigint as _bytesToBigint,
  randomFieldElement as _randomFieldElement,
  BN254_FIELD_PRIME as _BN254_FIELD_PRIME,
  TREE_DEPTH as _TREE_DEPTH,
  eddsaPoseidonSignWithScalar as _eddsaPoseidonSignWithScalar,
  eddsaPoseidonSign as _eddsaPoseidonSign,
  eddsaGetPrivScalar as _eddsaGetPrivScalar,
  eddsaGetPubKey as _eddsaGetPubKey,
  computeBoundParamsHash as _computeBoundParamsHash,
  createUnshieldBoundParams as _createUnshieldBoundParams,
  createRedeemBoundParams as _createRedeemBoundParams,
  computeStealthDataHash as _computeStealthDataHash,
  createTransferBoundParams as _createTransferBoundParams,
  deriveKeysFromSeedCircuit as _deriveKeysFromSeedCircuit,
  buildTransactInstructionData as _buildTransactInstructionData,
  buildUnshieldInstructionData as _buildUnshieldInstructionData,
  buildRedemptionRequestInstructionData as _buildRedemptionRequestInstructionData,
} from "../../sdk/dist/index.js";

// Re-export with e2e-friendly names
export const initPoseidon = _initPoseidon;
export const poseidonHashSync = _poseidonHashSync;
export const computeNPKSync = _computeNPKSync;
export const computeMPKSync = _computeMPKSync;
export const computeJoinSplitCommitmentSync = _computeJoinSplitCommitmentSync;
export const computeJoinSplitNullifierSync = _computeJoinSplitNullifierSync;
export const bigintToBytes32BE = _bigintToBytes;
export const bytes32ToBigintBE = _bytesToBigint;
export const randomFieldElement = _randomFieldElement;
export const BN254_FIELD_PRIME = _BN254_FIELD_PRIME;
export const TREE_DEPTH = _TREE_DEPTH;
export const eddsaPoseidonSignWithScalar = _eddsaPoseidonSignWithScalar;
export const eddsaPoseidonSign = _eddsaPoseidonSign;
export const eddsaGetPrivScalar = _eddsaGetPrivScalar;
export const eddsaGetPubKey = _eddsaGetPubKey;
export const computeBoundParamsHash = _computeBoundParamsHash;
export const createUnshieldBoundParams = _createUnshieldBoundParams;
export const createRedeemBoundParams = _createRedeemBoundParams;
export const computeStealthDataHash = _computeStealthDataHash;
export const createTransferBoundParams = _createTransferBoundParams;
export const deriveKeysFromSeedCircuit = _deriveKeysFromSeedCircuit;
export const buildTransactInstructionData = _buildTransactInstructionData;
export const buildUnshieldInstructionData = _buildUnshieldInstructionData;
export const buildRedemptionRequestInstructionData = _buildRedemptionRequestInstructionData;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Shared helpers — used across multiple test steps
// =============================================================================

/**
 * Parse a stealth announcement event from Solana transaction log messages.
 * Returns commitment hex, plaintext amount, and leaf index — or null if not found.
 */
export function parseStealthAnnouncementFromLogs(logMessages: string[]): { commitment: string; amount: number; leafIndex: number } | null {
  for (const logLine of logMessages) {
    if (!logLine.startsWith("Program data: ")) continue;
    const parts = logLine.slice(14).split(" ");
    const bufs = parts.map(p => Buffer.from(p, "base64"));
    const full = Buffer.concat(bufs);
    // Stealth announcement: disc(0x03) + type(1) + ephemeral(32) + amount(8) + commitment(32) + leaf_index(4)
    if (full.length >= 78 && full[0] === 0x03 && full[1] === 0x00) {
      const amount = Number(full.readBigUInt64LE(34));
      const commitment = full.subarray(42, 74).toString("hex");
      const leafIndex = full.readUInt32LE(74);
      return { commitment, amount, leafIndex };
    }
  }
  return null;
}

/**
 * Precompute ZERO_HASHES for the merkle tree.
 * Must be called after initPoseidon().
 */
let _zeroHashes: bigint[] | null = null;
export function getZeroHashes(): bigint[] {
  if (_zeroHashes) return _zeroHashes;
  _zeroHashes = [0n];
  for (let i = 1; i <= _TREE_DEPTH; i++) {
    _zeroHashes[i] = _poseidonHashSync([_zeroHashes[i - 1], _zeroHashes[i - 1]]);
  }
  return _zeroHashes;
}

/**
 * Build a Merkle tree from leaves and return root + proof accessor.
 * Must be called after initPoseidon().
 */
export function buildMerkleTree(leaves: bigint[]): { root: bigint; getProof: (idx: number) => { siblings: bigint[]; indices: number[] } } {
  const ZERO = getZeroHashes();
  const layers: bigint[][] = [new Array(1 << _TREE_DEPTH).fill(0n)];
  for (let i = 0; i < leaves.length; i++) layers[0][i] = leaves[i];

  for (let level = 0; level < _TREE_DEPTH; level++) {
    const prev = layers[level];
    const next: bigint[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(_poseidonHashSync([prev[i], prev[i + 1] ?? ZERO[level]]));
    }
    layers.push(next);
  }

  return {
    root: layers[_TREE_DEPTH][0],
    getProof(idx: number) {
      const siblings: bigint[] = [];
      const indices: number[] = [];
      let i = idx;
      for (let level = 0; level < _TREE_DEPTH; level++) {
        const bit = i & 1;
        indices.push(bit);
        siblings.push(bit === 0 ? layers[level][i + 1] ?? ZERO[level] : layers[level][i - 1]);
        i >>= 1;
      }
      return { siblings, indices };
    },
  };
}

// =============================================================================
// Constants
// =============================================================================

export const RPC_URL = "http://127.0.0.1:8899";
export const ESPLORA_URL = "http://localhost:3002/regtest/api";
export const STATE_FILE = path.join(__dirname, "localnet-state.json");
export const CONTRACTS_DIR = path.resolve(__dirname, "../../contracts");
export const SDK_DIR = path.resolve(__dirname, "../../sdk");
export const CIRCUITS_DIR = path.resolve(__dirname, "../../circuits");

export const ZKBTC_TOKEN_ID = 0x7a627463n; // "zkbtc" as u32

export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID;
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Instruction discriminators (sequential 0-19)
export const Disc = {
  INITIALIZE: 0,
  SET_PAUSED: 1,
  SET_POOL_CONFIG: 2,
  PROPOSE_POOL_UPDATE: 3,
  EXECUTE_POOL_UPDATE: 4,
  CANCEL_POOL_UPDATE: 5,
  INIT_VK_REGISTRY: 6,
  UPDATE_VK_REGISTRY: 7,
  REGISTER_TOKEN: 8,
  UPDATE_TOKEN_CONFIG: 9,
  CLAIM_FEES: 10,
  VERIFY_STEALTH_DEPOSIT: 11,
  SHIELD: 12,
  TRANSACT: 13,
  UNSHIELD: 14,
  REDEEM: 15,
  REQUEST_REDEMPTION: 16,
  COMPLETE_REDEMPTION: 17,
  MARK_PROCESSING: 18,
  CANCEL_REDEMPTION: 19,
} as const;

// PDA seeds
export const Seeds = {
  POOL_STATE: "pool_state",
  COMMITMENT_TREE: "commitment_tree",
  VK_REGISTRY: "vk_registry",
  NULLIFIER: "nullifier",
  STEALTH: "stealth",
  REDEMPTION: "redemption",
  DEPOSIT: "deposit",
  UTXO: "utxo",
  TOKEN_CONFIG: "token_config",
  BTC_LIGHT_CLIENT: "btc_light_client",
  BLOCK: "block",
  HEIGHT_INDEX: "height_index",
};

// =============================================================================
// Connection + Authority
// =============================================================================

export const connection = new Connection(RPC_URL, "confirmed");

export function loadAuthority(): Keypair {
  const keyPath = process.env.KEYPAIR
    || (process.env.HOME + "/.config/solana/id.json");
  const secretKey = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

// =============================================================================
// Localnet State Persistence
// =============================================================================

export interface NoteState {
  npk: string;
  random: string;
  amount: number;
  leafIndex: number;
  commitment: string;
  tokenId: string;
}

export interface LocalnetState {
  privacyCoinProgramId: string;
  btcLightClientId: string;
  chadbufferId: string;
  zkbtcMint: string;
  poolState: string;
  commitmentTree: string;
  poolVault: string;
  frostVault: string;
  authority: string;
  tUsdcMint?: string;
  tUsdcVault?: string;
  tWsolMint?: string;
  tWsolVault?: string;
  btcNote?: NoteState;
  btcNote2?: NoteState;
  usdcNote?: NoteState;
  wsolNote?: NoteState;
  transferNotes?: { send: NoteState; change: NoteState };
  /** All commitments in insertion order (hex strings) for full tree rebuild */
  commitments?: string[];
  // BTC signing config
  btcSigningKey?: string;     // hex, secp256k1 private key (single-key mode)
  btcXOnlyPubKey?: string;    // hex, x-only public key
  poolBtcAddress?: string;    // bech32m Taproot address (bcrt1p... for regtest)
  signingMode?: "single" | "frost";
  // Crypto keys (hex)
  spendingSeed?: string;
  pubKeyX?: string;
  pubKeyY?: string;
  nullifyingKey?: string;
  mpk?: string;
}

export function loadState(): LocalnetState {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`State file not found: ${STATE_FILE}. Run step1-infra.ts first.`);
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

export function saveState(state: LocalnetState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function updateState(partial: Partial<LocalnetState>): void {
  const state = loadState();
  Object.assign(state, partial);
  saveState(state);
}

/** Append commitments to the state (preserves insertion order for tree rebuild) */
export function trackCommitments(...commitmentHexes: string[]): void {
  const state = loadState();
  if (!state.commitments) state.commitments = [];
  state.commitments.push(...commitmentHexes);
  saveState(state);
}

// =============================================================================
// PDA Derivation
// =============================================================================

export function derivePoolStatePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(Seeds.POOL_STATE)], programId);
}

export function deriveCommitmentTreePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(Seeds.COMMITMENT_TREE)], programId);
}

export function deriveVkRegistryPDA(programId: PublicKey, nIn: number, nOut: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.VK_REGISTRY), Buffer.from([nIn]), Buffer.from([nOut])],
    programId,
  );
}

export function deriveNullifierPDA(programId: PublicKey, nullifierHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.NULLIFIER), Buffer.from(nullifierHash)],
    programId,
  );
}

export function deriveRedemptionPDA(programId: PublicKey, user: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.REDEMPTION), user.toBuffer(), nonceBuf],
    programId,
  );
}

/** Derive UTXO PDA: seeds = ["utxo", txid_internal(32), vout_le(4)] */
export function deriveUtxoPDA(programId: PublicKey, txidInternal: Uint8Array, vout: number): [PublicKey, number] {
  const voutBuf = Buffer.alloc(4);
  voutBuf.writeUInt32LE(vout);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.UTXO), Buffer.from(txidInternal), voutBuf],
    programId,
  );
}

export function deriveDepositRecordPDA(programId: PublicKey, txid: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.DEPOSIT), Buffer.from(txid)],
    programId,
  );
}

export function deriveTokenConfigPDA(programId: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.TOKEN_CONFIG), mint.toBuffer()],
    programId,
  );
}

export function deriveLightClientPDA(btcLcId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(Seeds.BTC_LIGHT_CLIENT)], btcLcId);
}

export function deriveBlockHeaderPDA(btcLcId: PublicKey, blockHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.BLOCK), Buffer.from(blockHash)],
    btcLcId,
  );
}

export function deriveHeightIndexPDA(btcLcId: PublicKey, height: bigint): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(height);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.HEIGHT_INDEX), buf],
    btcLcId,
  );
}

export function deriveATA(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

// =============================================================================
// Helpers
// =============================================================================

export function dsha256(buf: Buffer | Uint8Array): Buffer {
  const h1 = crypto.createHash("sha256").update(buf).digest();
  return crypto.createHash("sha256").update(h1).digest();
}

// bigintToBytes32BE, bytes32ToBigintBE, randomFieldElement — re-exported from SDK above

export function amountToLE8(amount: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let v = amount;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

export async function sendIx(
  ixs: TransactionInstruction[],
  signers: Keypair[],
  cu = 400_000,
): Promise<string> {
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: cu });
  const tx = new Transaction().add(budget, ...ixs);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

export async function ensureFunded(kp: Keypair, minLamports = 5 * LAMPORTS_PER_SOL): Promise<void> {
  const balance = await connection.getBalance(kp.publicKey);
  if (balance < minLamports) {
    const sig = await connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  }
}

// =============================================================================
// On-chain parsers
// =============================================================================

export function parseCommitmentTree(data: Buffer) {
  if (data[0] !== 0x05) return null;
  // Layout: disc(1) + bump(1) + padding(6) + root(32) + next_index(8) + frontier(16*32)
  return {
    discriminator: data[0],
    bump: data[1],
    currentRoot: data.subarray(8, 40),
    nextIndex: data.readBigUInt64LE(40),
    frontier: data.subarray(48, 48 + TREE_DEPTH * 32),
  };
}

export function extractFrontier(treeData: NonNullable<ReturnType<typeof parseCommitmentTree>>): bigint[] {
  const frontier: bigint[] = [];
  for (let i = 0; i < TREE_DEPTH; i++) {
    frontier.push(bytes32ToBigintBE(new Uint8Array(treeData.frontier.subarray(i * 32, (i + 1) * 32))));
  }
  return frontier;
}

export function parsePoolState(data: Buffer) {
  if (data[0] !== 0x01) return null;
  return {
    totalMinted: data.readBigUInt64LE(140),
    totalBurned: data.readBigUInt64LE(148),
    pendingRedemptions: data.readBigUInt64LE(156),
    totalShielded: data.readBigUInt64LE(188),
    feePool: data.readBigUInt64LE(204),
    totalBtcHeld: data.readBigUInt64LE(248),
    utxoCount: data.readUInt16LE(256),
  };
}

export function parseTokenConfig(data: Buffer) {
  if (data[0] !== 0x0b) return null;
  return {
    bump: data[1],
    mint: new PublicKey(data.subarray(2, 34)),
    tokenId: data.subarray(34, 66),
    vault: new PublicKey(data.subarray(66, 98)),
    decimals: data[98],
    enabled: data[99] !== 0,
    serviceFee: data.readBigUInt64LE(100),
    minDeposit: data.readBigUInt64LE(108),
    maxDeposit: data.readBigUInt64LE(116),
    depositCap: data.readBigUInt64LE(124),
    totalShielded: data.readBigUInt64LE(132),
    accumulatedFees: data.readBigUInt64LE(140),
  };
}

// =============================================================================
// Logging
// =============================================================================

export function log(msg: string): void {
  console.log(`  ${msg}`);
}

export function stepHeader(step: number, title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Step ${step}: ${title}`);
  console.log("=".repeat(60));
}
