import { eddsaPoseidonSignWithScalar, deriveKeysFromSeed, deriveMasterKey, initPoseidon, poseidonHashSync } from "./dist/index.js";
import { babyJubMul, BABYJUB_BASE8 } from "./dist/crypto-babyjub.js";
import { babyJubAdd } from "./dist/crypto.js";
import { buildEddsa, buildPoseidon } from "circomlibjs";

async function test() {
  await initPoseidon();
  const eddsa = await buildEddsa();
  const poseidon = await buildPoseidon();
  const F = eddsa.babyJub.F;
  const babyJub = eddsa.babyJub;

  const seed = deriveMasterKey("alpha-test");
  const keys = deriveKeysFromSeed(seed);
  const msg = 12345n;

  const [r8x, r8y, sigS] = eddsaPoseidonSignWithScalar(keys.spendingPrivKey, keys.spendingPubKey, msg);

  // Step 1: hm (already verified to match)
  const hm = poseidonHashSync([r8x, r8y, keys.spendingPubKey.x, keys.spendingPubKey.y, msg]);

  // Step 2: S * B8 (our implementation)
  const ourSB8 = babyJubMul(sigS, BABYJUB_BASE8);
  // S * B8 (circomlibjs)
  const circomSB8 = babyJub.mulPointEscalar(babyJub.Base8, sigS);
  console.log("S * B8 match:", ourSB8.x === F.toObject(circomSB8[0]));

  // Step 3: hm * A (our implementation)
  const ourHmA = babyJubMul(hm, keys.spendingPubKey);
  // hm * A (circomlibjs)
  const A_circom = [F.e(keys.spendingPubKey.x), F.e(keys.spendingPubKey.y)];
  const circomHmA = babyJub.mulPointEscalar(A_circom, hm);
  console.log("hm * A match:", ourHmA.x === F.toObject(circomHmA[0]));

  // Step 4: R8 + hm*A (our implementation)
  const ourRhs = babyJubAdd({x: r8x, y: r8y}, ourHmA);
  // R8 + hm*A (circomlibjs)
  const R8_circom = [F.e(r8x), F.e(r8y)];
  const circomRhs = babyJub.addPoint(R8_circom, circomHmA);
  console.log("R8 + hm*A match:", ourRhs.x === F.toObject(circomRhs[0]));

  // Step 5: Final comparison
  console.log("\nS*B8:", ourSB8.x.toString(16).slice(0, 20));
  console.log("R8+hm*A (ours):", ourRhs.x.toString(16).slice(0, 20));
  console.log("R8+hm*A (circom):", F.toObject(circomRhs[0]).toString(16).slice(0, 20));
  console.log("S*B8 (circom):", F.toObject(circomSB8[0]).toString(16).slice(0, 20));

  console.log("\nFinal check: S*B8 === R8+hm*A (our):", ourSB8.x === ourRhs.x && ourSB8.y === ourRhs.y);
  console.log("Final check: S*B8 === R8+hm*A (circom):", F.toObject(circomSB8[0]) === F.toObject(circomRhs[0]));

  // Also try: what if the issue is R8 not being on the curve?
  console.log("\nR8 on curve (circom):", babyJub.inCurve(R8_circom));
  console.log("A on curve (circom):", babyJub.inCurve(A_circom));
}

test().catch(console.error);
