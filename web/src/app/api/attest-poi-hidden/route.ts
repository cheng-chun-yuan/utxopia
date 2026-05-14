/**
 * Submit a hidden-commitment Proof-of-Innocence attestation on behalf of
 * the user (Phase 3d-lite).
 *
 * Same flow as `/api/attest-poi` but the 32-byte public input is the
 * `blinded_id = Poseidon(commitment, nonce)` rather than the commitment
 * itself. Chain watchers see only the blinded ID; the user shares
 * `nonce` with their auditor out-of-band so the auditor can verify the
 * binding.
 *
 * The on-chain event `EVENT_POI_HIDDEN_ATTESTED` (disc 0x16) carries
 * `(association_root, blinded_id, version)` — no payer, no commitment.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import { getUTXOpiaProgramId } from "@/lib/solana/pdas";
import { getRelayerKeypair as getRelayerKeypairShared } from "@/lib/server/relayer";
import { getHeliusRpcUrl } from "@/lib/helius-server";
import { checkRateLimit, getClientIp } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

const ASSOCIATION_SET_SEED = new TextEncoder().encode("poi_association_set");
const ATTEST_POI_HIDDEN = 23;

function deriveAssociationSetPDA(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([ASSOCIATION_SET_SEED], programId);
  return pda;
}

function getRelayerKeypair(): Keypair {
  const shared = getRelayerKeypairShared();
  if (shared) return shared;
  const keypairJson = process.env.RELAYER_KEYPAIR;
  if (!keypairJson) throw new Error("RELAYER_KEYPAIR not configured");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairJson)));
}

interface AttestPoIHiddenRequest {
  /** 32-byte hex Poseidon(commitment, nonce). No 0x prefix. */
  blindedId: string;
  /** Groth16 proof bytes (256-byte hex). */
  proofBytes: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Same 5/min/IP cap as the clear-text route. Hidden mode doesn't change
  // the cost or chain footprint, just the privacy surface.
  const ip = getClientIp(req.headers);
  const rl = checkRateLimit(ip, "attest-poi-hidden", { maxTokens: 5, windowMs: 60_000 });
  if (rl.limited) {
    return NextResponse.json(
      { ok: false, error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 12000) / 1000)) } },
    );
  }

  let body: AttestPoIHiddenRequest;
  try {
    body = (await req.json()) as AttestPoIHiddenRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const blindedIdHex = body.blindedId?.replace(/^0x/, "") ?? "";
  const proofHex = body.proofBytes?.replace(/^0x/, "") ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(blindedIdHex)) {
    return NextResponse.json(
      { ok: false, error: "blindedId must be 32-byte hex (64 chars)" },
      { status: 400 },
    );
  }
  if (!/^[0-9a-fA-F]{512}$/.test(proofHex)) {
    return NextResponse.json(
      { ok: false, error: "proofBytes must be 256-byte hex (512 chars)" },
      { status: 400 },
    );
  }

  const blindedId = Buffer.from(blindedIdHex, "hex");
  const proofBytes = Buffer.from(proofHex, "hex");

  let relayer: Keypair;
  try {
    relayer = getRelayerKeypair();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  const programId = getUTXOpiaProgramId();
  const associationSet = deriveAssociationSetPDA(programId);

  // Instruction data: disc(1) + blinded_id(32) + proof(256) = 289 bytes
  const data = Buffer.alloc(1 + 32 + 256);
  data[0] = ATTEST_POI_HIDDEN;
  blindedId.copy(data, 1);
  proofBytes.copy(data, 1 + 32);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: associationSet, isSigner: false, isWritable: false },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
    ],
    data,
  });

  const connection = new Connection(getHeliusRpcUrl(), "confirmed");
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ix,
  );
  try {
    const { blockhash } = await connection.getLatestBlockhash();
    tx.feePayer = relayer.publicKey;
    tx.recentBlockhash = blockhash;
    const signature = await sendAndConfirmTransaction(connection, tx, [relayer], {
      commitment: "confirmed",
    });
    return NextResponse.json({ ok: true, signature, associationSet: associationSet.toBase58() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: `attest_poi_hidden tx failed: ${msg.slice(0, 400)}` },
      { status: 502 },
    );
  }
}
