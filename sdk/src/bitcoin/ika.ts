/**
 * Ika dWallet → Bitcoin P2TR address derivation.
 *
 * UTXOpia v2 custody is held by an Ika dWallet on Solana. The dWallet's
 * compressed secp256k1 public key (or its x-only form) is the BIP-341 internal
 * key for a Taproot output with no script tree. Spending happens via key-path
 * only — Ika produces a Schnorr signature over the BTC sighash on demand.
 */

import { taggedHash, hexToBytes, bytesToHex } from "../crypto";
import { bech32m } from "bech32";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/**
 * Reference to an Ika dWallet for address derivation.
 *
 * `literal-pubkey` is the synchronous form — pass a 33-byte compressed or
 * 32-byte x-only pubkey directly. The `id` form is async and must be resolved
 * to a pubkey via the Ika SDK before reaching this helper.
 */
export type IkaDWalletRef =
  | { type: "literal-xonly"; xonlyPubkey: Uint8Array } // 32 bytes
  | { type: "literal-compressed"; compressedPubkey: Uint8Array } // 33 bytes (0x02/0x03 || x)
  | { type: "id"; dwalletId: string };

/**
 * Derive the BIP-341 P2TR (key-path-only) address controlled by an Ika dWallet.
 *
 * BIP-341 (no script tree):
 *   t = h_tapTweak(P)
 *   Q = P + t*G
 *   output_key = x(Q)
 *   address = bech32m(hrp, [witness_version=1, ...words(output_key)])
 *
 * @param ref       The Ika dWallet reference (literal pubkey, or future async id).
 * @param network   "mainnet" | "testnet" | "regtest"
 * @returns         The P2TR address (`bc1p…` / `tb1p…` / `bcrt1p…`)
 */
export function deriveCustodyAddressFromIkaDWallet(
  ref: IkaDWalletRef,
  network: "mainnet" | "testnet" | "regtest"
): string {
  const xonly = extractXOnly(ref);
  const tweak = taggedHash("TapTweak", xonly);
  const tweakScalar = bytesToBigIntBe(tweak);

  // Lift x-only to a full point with even y (BIP-340 convention).
  const internalPoint = secp256k1.Point.fromHex("02" + bytesToHex(xonly));
  const tweakPoint = secp256k1.Point.BASE.multiply(tweakScalar);
  const outputPoint = internalPoint.add(tweakPoint);

  // Drop the 1-byte parity prefix to get the x-only output key.
  const outputKey = hexToBytes(outputPoint.toHex(true).slice(2));

  const hrp =
    network === "mainnet" ? "bc" : network === "regtest" ? "bcrt" : "tb";
  const words = bech32m.toWords(outputKey);
  return bech32m.encode(hrp, [1, ...words]);
}

function extractXOnly(ref: IkaDWalletRef): Uint8Array {
  if (ref.type === "literal-xonly") {
    if (ref.xonlyPubkey.length !== 32) {
      throw new Error("xonlyPubkey must be 32 bytes");
    }
    return ref.xonlyPubkey;
  }
  if (ref.type === "literal-compressed") {
    if (ref.compressedPubkey.length !== 33) {
      throw new Error("compressedPubkey must be 33 bytes");
    }
    return ref.compressedPubkey.subarray(1);
  }
  throw new Error(
    "deriveCustodyAddressFromIkaDWallet: 'id' resolution requires the Ika SDK; " +
      "resolve dwalletId → pubkey first and pass via literal-xonly or literal-compressed"
  );
}

function bytesToBigIntBe(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
