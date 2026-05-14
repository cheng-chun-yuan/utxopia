/**
 * Submit a Proof-of-Innocence attestation on behalf of the user.
 *
 * The user generates the Groth16 PoI proof in the browser, posts the
 * commitment + proof bytes here, and we sign + submit the on-chain
 * `attest_poi` instruction (disc 22) as the relayer. The commitment is a
 * public input of the PoI proof, so it's already in clear on-chain;
 * relaying just shields the user's Solana identity from the attestation
 * event.
 *
 * The on-chain event `EVENT_POI_ATTESTED` carries `(association_root,
 * commitment, version)` — no payer identity — so anyone watching the
 * attestation stream sees only what's already public.
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

interface AttestPoIRequest {
  /** Commitment to attest (32-byte hex, no 0x prefix). */
  commitment: string;
  /** Groth16 proof bytes (256-byte hex). */
  proofBytes: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Rate limit: PoI attestation isn't cheap (256-byte tx), and a flood would
  // spam the on-chain attestation stream. 5/min per IP is enough headroom.
  const ip = getClientIp(req.headers);
  const rl = checkRateLimit(ip, "attest-poi", { maxTokens: 5, windowMs: 60_000 });
  if (rl.limited) {
    return NextResponse.json(
      { ok: false, error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 12000) / 1000)) } },
    );
  }

  let body: AttestPoIRequest;
  try {
    body = (await req.json()) as AttestPoIRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const commitmentHex = body.commitment?.replace(/^0x/, "") ?? "";
  const proofHex = body.proofBytes?.replace(/^0x/, "") ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(commitmentHex)) {
    return NextResponse.json(
      { ok: false, error: "commitment must be 32-byte hex (64 chars)" },
      { status: 400 },
    );
  }
  if (!/^[0-9a-fA-F]{512}$/.test(proofHex)) {
    return NextResponse.json(
      { ok: false, error: "proofBytes must be 256-byte hex (512 chars)" },
      { status: 400 },
    );
  }

  const commitment = Buffer.from(commitmentHex, "hex");
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

  // Build instruction data: disc(1) + commitment(32) + proof(256) = 289 bytes
  const data = Buffer.alloc(1 + 32 + 256);
  data[0] = 22; // ATTEST_POI
  commitment.copy(data, 1);
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
      { ok: false, error: `attest_poi tx failed: ${msg.slice(0, 400)}` },
      { status: 502 },
    );
  }
}
