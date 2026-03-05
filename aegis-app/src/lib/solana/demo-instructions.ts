/**
 * Demo Instructions for Mock Stealth Deposits
 *
 * Allows adding stealth commitments to the on-chain tree
 * without requiring actual BTC deposits. For demo/showcase only.
 *
 * Uses @aegis/sdk for instruction data building.
 * PDA derivation consolidated in instructions.ts (single source of truth).
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { getPriorityFeeInstructions } from "@/lib/helius";
import {
  buildAddDemoStealthData,
  DEMO_INSTRUCTION,
  PDA_SEEDS,
} from "@aegis/sdk";

// Import PDA functions from instructions.ts (single source of truth)
import {
  AEGIS_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ZBTC_MINT_ADDRESS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  derivePoolVaultATA,
} from "./instructions";

// Re-export for consumers
export { DEMO_INSTRUCTION };

// =============================================================================
// Stealth Announcement PDA (specific to demo - uses ephemeral key)
// =============================================================================

/**
 * Derive Stealth Announcement PDA
 *
 * Ed25519 ephemeral pub is 32 bytes — use directly as PDA seed.
 * Must match on-chain derivation: seeds = ["stealth", ephemeral_pub]
 */
export function deriveStealthAnnouncementPDA(
  ephemeralPub: Uint8Array,
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.STEALTH), ephemeralPub],
    programId
  );
}

// =============================================================================
// Demo Instruction Builder
// =============================================================================

export interface AddDemoStealthParams {
  payer: PublicKey;
  ephemeralPub: Uint8Array;
  npk: Uint8Array;
  amountSats: bigint;
}

/**
 * Build ADD_DEMO_STEALTH instruction (npk-based, matches real deposits)
 */
export function buildAddDemoStealthInstruction(
  params: AddDemoStealthParams
): TransactionInstruction {
  const { payer, ephemeralPub, npk, amountSats } = params;

  const [poolState] = derivePoolStatePDA();
  const [commitmentTree] = deriveCommitmentTreePDA();
  const [stealthAnnouncement] = deriveStealthAnnouncementPDA(ephemeralPub);
  const poolVault = derivePoolVaultATA();

  // Use SDK's data builder
  const data = buildAddDemoStealthData(ephemeralPub, npk, amountSats);

  return new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: stealthAnnouncement, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ZBTC_MINT_ADDRESS, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: AEGIS_PROGRAM_ID,
    data: Buffer.from(data),
  });
}

/**
 * Build ADD_DEMO_STEALTH transaction with Helius priority fees
 */
export async function buildAddDemoStealthTransaction(
  connection: Connection,
  params: AddDemoStealthParams
): Promise<Transaction> {
  const instruction = buildAddDemoStealthInstruction(params);

  const priorityFeeIxs = await getPriorityFeeInstructions([
    AEGIS_PROGRAM_ID.toBase58(),
  ]);

  const transaction = new Transaction();
  transaction.add(...priorityFeeIxs);
  transaction.add(instruction);
  transaction.feePayer = params.payer;

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return transaction;
}
