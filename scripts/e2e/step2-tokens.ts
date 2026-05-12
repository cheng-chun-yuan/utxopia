#!/usr/bin/env bun
/**
 * Step 2: Additional Tokens
 *
 * Create tUSDC (6 dec) and tWSOL (9 dec), register their TokenConfigs.
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  createMintToInstruction,
} from "@solana/spl-token";

import {
  connection,
  loadAuthority,
  loadState,
  updateState,
  stepHeader,
  log,
  Disc,
  derivePoolStatePDA,
  deriveTokenConfigPDA,
  sendIx,
  TOKEN_2022,
} from "./shared.js";

stepHeader(2, "Additional Tokens");

async function createToken(
  authority: Keypair,
  decimals: number,
  label: string,
  poolState: PublicKey,
  utxo: PublicKey,
): Promise<{ mint: PublicKey; vault: PublicKey; userAta: PublicKey }> {
  // Create mint
  const mintKp = Keypair.generate();
  const mintLen = getMintLen([]);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: mintKp.publicKey,
      lamports,
      space: mintLen,
      programId: TOKEN_2022,
    }),
    createInitializeMintInstruction(mintKp.publicKey, decimals, authority.publicKey, null, TOKEN_2022),
  );
  await sendAndConfirmTransaction(connection, createMintTx, [authority, mintKp]);
  log(`${label} Mint: ${mintKp.publicKey.toBase58()}`);

  // Create vault ATA (owner = pool PDA)
  const vaultAccount = await getOrCreateAssociatedTokenAccount(
    connection, authority, mintKp.publicKey, poolState, true, undefined, undefined, TOKEN_2022,
  );
  log(`${label} Vault: ${vaultAccount.address.toBase58()}`);

  // Create user ATA and mint test tokens
  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, authority, mintKp.publicKey, authority.publicKey, false, undefined, undefined, TOKEN_2022,
  );

  return { mint: mintKp.publicKey, vault: vaultAccount.address, userAta: userAta.address };
}

async function registerTokenConfig(
  authority: Keypair,
  poolState: PublicKey,
  mint: PublicKey,
  vault: PublicKey,
  utxo: PublicKey,
  label: string,
  serviceFee: bigint = 0n,
) {
  const [tokenConfig] = deriveTokenConfigPDA(utxopia, mint);
  const regPayload = Buffer.alloc(32);
  regPayload.writeBigUInt64LE(serviceFee, 0);          // service_fee
  regPayload.writeBigUInt64LE(1000n, 8);               // min_deposit
  regPayload.writeBigUInt64LE(1_000_000_000_000n, 16);  // max_deposit (1M in native)
  regPayload.writeBigUInt64LE(10_000_000_000_000n, 24); // deposit_cap (10M in native)

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolState, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: tokenConfig, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: utxopia,
    data: Buffer.concat([Buffer.from([Disc.REGISTER_TOKEN]), regPayload]),
  });
  await sendIx([ix], [authority]);
  log(`${label} TokenConfig registered`);
}

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const UTXOPIA = new PublicKey(state.privacyCoinProgramId);
  const [poolState] = derivePoolStatePDA(UTXOPIA);

  // tUSDC (6 decimals)
  log("Creating tUSDC...");
  const usdc = await createToken(authority, 6, "tUSDC", poolState, UTXOPIA);
  // USDC: service_fee = 2_000_000 (= $2.00 at 6 decimals)
  await registerTokenConfig(authority, poolState, usdc.mint, usdc.vault, UTXOPIA, "tUSDC", 2_000_000n);

  // Mint 1M tUSDC to user
  const mintUsdcIx = createMintToInstruction(
    usdc.mint, usdc.userAta, authority.publicKey, 1_000_000_000_000n, [], TOKEN_2022,
  );
  await sendIx([mintUsdcIx], [authority]);
  log("Minted 1M tUSDC to user");

  // tWSOL (9 decimals)
  log("Creating tWSOL...");
  const wsol = await createToken(authority, 9, "tWSOL", poolState, UTXOPIA);
  // SOL: service_fee = 10_000_000 (= 0.01 SOL ≈ $2 at 9 decimals)
  await registerTokenConfig(authority, poolState, wsol.mint, wsol.vault, UTXOPIA, "tWSOL", 10_000_000n);

  // Mint 100 tWSOL to user
  const mintWsolIx = createMintToInstruction(
    wsol.mint, wsol.userAta, authority.publicKey, 100_000_000_000n, [], TOKEN_2022,
  );
  await sendIx([mintWsolIx], [authority]);
  log("Minted 100 tWSOL to user");

  updateState({
    tUsdcMint: usdc.mint.toBase58(),
    tUsdcVault: usdc.vault.toBase58(),
    tWsolMint: wsol.mint.toBase58(),
    tWsolVault: wsol.vault.toBase58(),
  });

  console.log("\nStep 2: Additional Tokens ....... PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
