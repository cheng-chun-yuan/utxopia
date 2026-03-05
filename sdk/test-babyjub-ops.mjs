import { eddsaPoseidonSignWithScalar, deriveKeysFromSeed, deriveMasterKey, initPoseidon, poseidonHashSync } from "./dist/index.js";
import { babyJubMul, BABYJUB_BASE8 } from "./dist/crypto-babyjub.js";
import { buildEddsa } from "circomlibjs";

async function test() {
  await initPoseidon();
  const eddsa = await buildEddsa();
  const F = eddsa.babyJub.F;
  const babyJub = eddsa.babyJub;

  const seed = deriveMasterKey("alpha-test");
  const keys = deriveKeysFromSeed(seed);

  // Compare BASE8
  const B8 = babyJub.Base8;
  console.log("BASE8 match:");
  console.log("  circom x:", F.toObject(B8[0]).toString(16).slice(0, 20));
  console.log("  ours   x:", BABYJUB_BASE8.x.toString(16).slice(0, 20));
  console.log("  match:", F.toObject(B8[0]) === BABYJUB_BASE8.x);

  // Compare scalar mul: privKey * B8
  const scalar = keys.spendingPrivKey;

  // Our mul
  const ourResult = babyJubMul(scalar, BABYJUB_BASE8);

  // circomlibjs mul
  const circomResult = babyJub.mulPointEscalar(B8, scalar);
  const circomX = F.toObject(circomResult[0]);
  const circomY = F.toObject(circomResult[1]);

  console.log("\nscalar * B8:");
  console.log("  our   x:", ourResult.x.toString(16).slice(0, 20));
  console.log("  circom x:", circomX.toString(16).slice(0, 20));
  console.log("  match:", ourResult.x === circomX);

  // Simple small scalar test
  const testScalar = 7n;
  const ourSmall = babyJubMul(testScalar, BABYJUB_BASE8);
  const circomSmall = babyJub.mulPointEscalar(B8, testScalar);
  console.log("\n7 * B8:");
  console.log("  our   x:", ourSmall.x.toString(16).slice(0, 20));
  console.log("  circom x:", F.toObject(circomSmall[0]).toString(16).slice(0, 20));
  console.log("  match:", ourSmall.x === F.toObject(circomSmall[0]));
}

test().catch(console.error);
