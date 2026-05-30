import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const xonly = Buffer.from("87a1014ea16e42c825026889874902875aec7650b39c2b334a4d04d49b904c76", "hex");
const compressed02 = Buffer.concat([Buffer.from([0x02]), xonly]);

// ECDSA run: msg = 720a09...d127, sig = f0bd20...acc4bf
const msg = Buffer.from("720a09a9a3afa3b9969e49a95dc5d55d0828e03c881658efd5f7b6537003d127", "hex");
const sig = Buffer.from("f0bd20f686816ee05308d4513ae70005149a4545dae17ca50dcb212114d8968665eb4ab133e07c68647892edc2b499ca2525742d36e9a83e4b5a41ef43acc4bf", "hex");

// Try multiple digest candidates
const cands: Record<string, Uint8Array> = {
  "raw": new Uint8Array(msg),
  "sha256(msg)": sha256(new Uint8Array(msg)),
  "keccak256(msg)": keccak_256(new Uint8Array(msg)),
  "double-sha256(msg)": sha256(sha256(new Uint8Array(msg))),
};
const r = sig.subarray(0, 32);
const s = sig.subarray(32, 64);
const sigObj = new secp256k1.Signature(BigInt("0x" + r.toString("hex")), BigInt("0x" + s.toString("hex")));

for (const [name, m] of Object.entries(cands)) {
  try {
    const ok = secp256k1.verify(sigObj, m, new Uint8Array(compressed02));
    console.log(`  ECDSA verify(${name}): ${ok ? "✅" : "❌"}`);
  } catch (e: any) {
    console.log(`  ECDSA verify(${name}): err - ${e.message}`);
  }
}
