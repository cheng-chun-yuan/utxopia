import { eddsaPoseidonSign, eddsaGetPubKey, eddsaPoseidonSignWithScalar, deriveKeysFromSeed, deriveMasterKey, initPoseidon, poseidonHashSync, babyJubAdd, BABYJUB_ORDER } from "./dist/index.js";
import { babyJubMul, BABYJUB_BASE8 } from "./dist/crypto-babyjub.js";

async function test() {
  await initPoseidon();
  const seed = deriveMasterKey("alpha-test");
  const keys = deriveKeysFromSeed(seed);

  console.log("sync pubKey === privKey*B8:", babyJubMul(keys.spendingPrivKey, BABYJUB_BASE8).x === keys.spendingPubKey.x);

  const circomPub = await eddsaGetPubKey(keys.eddsaSeed);
  console.log("circom pubKey === sync pubKey:", circomPub.x === keys.spendingPubKey.x);

  const msg = 12345n;
  const [r8x, r8y, sigS] = eddsaPoseidonSignWithScalar(keys.spendingPrivKey, keys.spendingPubKey, msg);

  // Verify: S * BASE8 == R8 + hm * A
  const hm = poseidonHashSync([r8x, r8y, keys.spendingPubKey.x, keys.spendingPubKey.y, msg]);
  const lhs = babyJubMul(sigS, BABYJUB_BASE8);
  const hmA = babyJubMul(hm, keys.spendingPubKey);
  const rhs = babyJubAdd({x: r8x, y: r8y}, hmA);

  console.log("Signature valid (S*B8 == R8 + hm*A):", lhs.x === rhs.x && lhs.y === rhs.y);
}

test().catch(console.error);
