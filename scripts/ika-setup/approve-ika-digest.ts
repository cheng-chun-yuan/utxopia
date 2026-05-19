#!/usr/bin/env bun
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { VersionedDWalletDataAttestation } from "./lib/ika-setup-vendored.ts";

const STATE_PATH = process.env.STATE_PATH || "scripts/devnet-regtest-state.json";
const PAYER_KEYPAIR_PATH =
  process.env.PAYER_KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`;
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const BTC_SIGHASH =
  process.env.BTC_SIGHASH ||
  "c49823540c6f744212d60c4e33db3538b9dce744922adb0f9d33aabeec2e1c86";
const IKA_MESSAGE_DIGEST = process.env.IKA_MESSAGE_DIGEST;
const MINER_FEE_SATS = BigInt(process.env.MINER_FEE_SATS || "1540");
const SIGNATURE_SCHEME = Number(process.env.SIGNATURE_SCHEME || "3");
const REDEMPTION_PDA =
  process.env.REDEMPTION_PDA || "2mwetE7eEbqX2h9gxnFEm5nAoRpceBmVMb2BnzWtzYZg";

if (!IKA_MESSAGE_DIGEST) {
  throw new Error("IKA_MESSAGE_DIGEST env is required");
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await Bun.file(path).text());
}

async function readKeypair(path: string): Promise<Keypair> {
  const raw = JSON.parse(await Bun.file(path).text());
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function dwalletPublicKeyFromState(state: any): Uint8Array {
  const attestationData = hexToBytes(state.ika.attestation.attestationData);
  const parsed = VersionedDWalletDataAttestation.parse(attestationData);
  if (!parsed.V1) throw new Error("unsupported dWallet attestation payload");
  return Uint8Array.from(parsed.V1.public_key);
}

function deriveMessageApproval(
  ikaProgram: PublicKey,
  dwalletPublicKey: Uint8Array,
  ikaMessageDigest: Uint8Array,
): PublicKey {
  const payload = Buffer.alloc(2 + dwalletPublicKey.length);
  payload.writeUInt16LE(0, 0);
  Buffer.from(dwalletPublicKey).copy(payload, 2);
  const schemeLe = Buffer.alloc(2);
  schemeLe.writeUInt16LE(SIGNATURE_SCHEME, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("dwallet"),
      payload.subarray(0, 32),
      payload.subarray(32),
      Buffer.from("message_approval"),
      schemeLe,
      ikaMessageDigest,
    ],
    ikaProgram,
  );
  return pda;
}

async function main() {
  const state = await readJson(STATE_PATH);
  const payer = await readKeypair(PAYER_KEYPAIR_PATH);
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");

  const programId = new PublicKey(state.utxopiaProgramId);
  const ikaProgram = new PublicKey(state.ika.programId);
  const ikaDwallet = new PublicKey(state.ika.dwallet);
  const poolState = new PublicKey(state.poolState);
  const redemptionPda = new PublicKey(REDEMPTION_PDA);
  const dwalletPublicKey = dwalletPublicKeyFromState(state);
  const ikaMessageDigest = hexToBytes(IKA_MESSAGE_DIGEST);
  if (ikaMessageDigest.length !== 32) throw new Error("IKA_MESSAGE_DIGEST must be 32 bytes");

  const [poolConfig] = PublicKey.findProgramAddressSync([Buffer.from("pool_config")], programId);
  const [ikaCoordinator] = PublicKey.findProgramAddressSync(
    [Buffer.from("dwallet_coordinator")],
    ikaProgram,
  );
  const [cpiAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__ika_cpi_authority")],
    programId,
  );
  const messageApproval = deriveMessageApproval(
    ikaProgram,
    dwalletPublicKey,
    ikaMessageDigest,
  );

  const data = Buffer.alloc(1 + 32 + 32 + 2 + 8);
  data[0] = 27;
  Buffer.from(hexToBytes(BTC_SIGHASH)).copy(data, 1);
  Buffer.from(ikaMessageDigest).copy(data, 33);
  data.writeUInt16LE(SIGNATURE_SCHEME, 65);
  data.writeBigUInt64LE(MINER_FEE_SATS, 67);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: false },
      { pubkey: redemptionPda, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolConfig, isSigner: false, isWritable: false },
      { pubkey: ikaProgram, isSigner: false, isWritable: false },
      { pubkey: ikaCoordinator, isSigner: false, isWritable: false },
      { pubkey: messageApproval, isSigner: false, isWritable: true },
      { pubkey: ikaDwallet, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: cpiAuthority, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");

  console.log(`message approval: ${messageApproval.toBase58()}`);
  console.log(`approval tx: ${sig}`);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
