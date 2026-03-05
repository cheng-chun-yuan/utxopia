import { eddsaPoseidonSignWithScalar, deriveKeysFromSeed, deriveMasterKey, initPoseidon } from "./dist/index.js";
import { buildEddsa } from "circomlibjs";

async function test() {
  await initPoseidon();
  const eddsa = await buildEddsa();
  const F = eddsa.babyJub.F;

  const seed = deriveMasterKey("alpha-test");
  const keys = deriveKeysFromSeed(seed);
  const msg = 12345n;

  const [r8x, r8y, sigS] = eddsaPoseidonSignWithScalar(keys.spendingPrivKey, keys.spendingPubKey, msg);

  // Call verifyPoseidon
  const sig = { R8: [F.e(r8x), F.e(r8y)], S: sigS };
  const A = [F.e(keys.spendingPubKey.x), F.e(keys.spendingPubKey.y)];

  // Try both: msg as field element and as bigint
  console.log("verifyPoseidon(F.e(msg)):", eddsa.verifyPoseidon(F.e(msg), sig, A));
  console.log("verifyPoseidon(msg):", eddsa.verifyPoseidon(msg, sig, A));

  // Also sign with circomlibjs and verify
  const circomSig = eddsa.signPoseidon(Buffer.from(keys.eddsaSeed), F.e(msg));
  const circomPub = eddsa.prv2pub(Buffer.from(keys.eddsaSeed));
  console.log("\ncircomlibjs sign+verify (circom pub):", eddsa.verifyPoseidon(F.e(msg), circomSig, circomPub));

  // Verify circom signature with sync pub (should fail)
  console.log("circomlibjs sign, verify with sync pub:", eddsa.verifyPoseidon(F.e(msg), circomSig, A));
}

test().catch(console.error);
