/**
 * Solana PDA Derivation & Config Helpers (web3.js)
 *
 * Thin wrapper that provides @solana/web3.js PublicKey constants and
 * synchronous PDA derivation using seed constants from @privacy-coin/sdk.
 *
 * All instruction data building lives in @privacy-coin/sdk — this file only
 * bridges SDK config → web3.js types for wallet-adapter compatibility.
 *
 * @module solana/pdas
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getConfig, PDA_SEEDS } from "@privacy-coin/sdk";

// =============================================================================
// Program IDs as web3.js PublicKeys (lazy, from SDK config)
// =============================================================================

export function getAegisProgramId(): PublicKey {
  return new PublicKey(getConfig().privacyCoinProgramId);
}

export function getBtcLightClientProgramId(): PublicKey {
  return new PublicKey(getConfig().btcLightClientProgramId);
}

export function getTokenProgramId(): PublicKey {
  return new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
}

export function getToken2022ProgramId(): PublicKey {
  return new PublicKey(getConfig().token2022ProgramId);
}

/** Get the token program that owns a mint (Token Program or Token-2022) */
export async function getTokenProgramForMint(
  connection: import("@solana/web3.js").Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
  return info.owner;
}

export function getZkbtcMint(): PublicKey {
  return new PublicKey(getConfig().zkbtcMint);
}

export function getChadbufferProgramId(): PublicKey {
  return new PublicKey(getConfig().chadbufferProgramId);
}

// =============================================================================
// PDA Derivation (sync, using PDA_SEEDS from SDK)
// =============================================================================

export function derivePoolStatePDA(
  programId: PublicKey = getAegisProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.POOL_STATE)],
    programId
  );
}

export function deriveCommitmentTreePDA(
  programId: PublicKey = getAegisProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.COMMITMENT_TREE)],
    programId
  );
}

export function deriveNullifierPDA(
  nullifierHash: Uint8Array,
  programId: PublicKey = getAegisProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.NULLIFIER), nullifierHash],
    programId
  );
}

export function deriveLightClientPDA(
  programId: PublicKey = getBtcLightClientProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.LIGHT_CLIENT)],
    programId
  );
}

export function deriveBlockHeaderPDA(
  blockHash: Uint8Array,
  programId: PublicKey = getBtcLightClientProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.BLOCK_HEADER), blockHash],
    programId
  );
}

export function deriveVkRegistryPDA(
  nInputs: number,
  nOutputs: number,
  programId: PublicKey = getAegisProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.VK_REGISTRY), new Uint8Array([nInputs]), new Uint8Array([nOutputs])],
    programId
  );
}

export function deriveRedemptionRequestPDA(
  userPubkey: PublicKey,
  nonce: bigint,
  programId: PublicKey = getAegisProgramId()
): [PublicKey, number] {
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, nonce, true);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redemption"), userPubkey.toBytes(), nonceBytes],
    programId
  );
}

export function deriveVerifiedTransactionPDA(
  blockHash: Uint8Array,
  txid: Uint8Array,
  programId: PublicKey = getBtcLightClientProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verified_tx"), Buffer.from(blockHash), Buffer.from(txid)],
    programId
  );
}

export function deriveDepositReceiptPDA(
  depositTxid: Uint8Array,
  programId: PublicKey = getAegisProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deposit_receipt"), Buffer.from(depositTxid)],
    programId
  );
}

export function deriveTokenConfigPDA(
  mint: PublicKey,
  programId: PublicKey = getAegisProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.TOKEN_CONFIG), mint.toBuffer()],
    programId
  );
}

// =============================================================================
// Utility
// =============================================================================

export function derivePoolVaultATA(
  programId: PublicKey = getAegisProgramId()
): PublicKey {
  const [poolState] = derivePoolStatePDA(programId);
  return getAssociatedTokenAddressSync(
    getZkbtcMint(),
    poolState,
    true,
    getToken2022ProgramId()
  );
}

export function getTokenAccountAddress(userPubkey: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    getZkbtcMint(),
    userPubkey,
    false,
    getToken2022ProgramId()
  );
}
