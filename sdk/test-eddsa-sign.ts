import { eddsaPoseidonSign, eddsaGetPubKey, eddsaPoseidonSignWithScalar, deriveKeysFromSeed, deriveMasterKey, initPoseidon, poseidonHashSync } from "./src/index";
import { babyJubMul, BABYJUB_BASE8, BABYJUB_ORDER } from "./src/crypto-babyjub";
import { babyJubAdd } from "./src/crypto";

async function test() {
  await initPoseidon();
  const seed = deriveMasterKey("alpha-test");
  const keys = deriveKeysFromSeed(seed);

  console.log("sync pubKey === privKey*B8:", babyJubMul(keys.spendingPrivKey, BABYJUB_BASE8).x === keys.spendingPubKey.x);

  const circomPub = await eddsaGetPubKey(keys.eddsaSeed);
  console.log("circom pubKey === sync pubKey:", circomPub.x === keys.spendingPubKey.x);

  const msg = 12345n;
  const [r8x, r8y, sigS] = eddsaPoseidonSignWithScalar(keys.spendingPrivKey, keys.spendingPubKey, msg);

  console.log("R8:", r8x.toString(16).slice(0, 20), r8y.toString(16).slice(0, 20));
  console.log("S:", sigS.toString(16).slice(0, 20));

  // Verify: S * BASE8 == R8 + hm * A
  const hm = poseidonHashSync([r8x, r8y, keys.spendingPubKey.x, keys.spendingPubKey.y, msg]);
  const lhs = babyJubMul(sigS, BABYJUB_BASE8);
  const hmA = babyJubMul(hm, keys.spendingPubKey);
  const rhs = babyJubAdd({x: r8x, y: r8y}, hmA);

  console.log("\nVerification:");
  console.log("LHS (S*B8).x:", lhs.x.toString(16).slice(0, 20));
  console.log("RHS (R8+hm*A).x:", rhs.x.toString(16).slice(0, 20));
  console.log("Signature valid:", lhs.x === rhs.x && lhs.y === rhs.y);
}

test().catch(console.error);
