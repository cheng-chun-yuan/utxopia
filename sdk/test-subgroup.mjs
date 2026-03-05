import { eddsaPoseidonSignWithScalar, deriveKeysFromSeed, deriveMasterKey, initPoseidon } from "./dist/index.js";
import { buildEddsa } from "circomlibjs";

async function test() {
  await initPoseidon();
  const eddsa = await buildEddsa();
  const F = eddsa.babyJub.F;
  const babyJub = eddsa.babyJub;

  const seed = deriveMasterKey("alpha-test");
  const keys = deriveKeysFromSeed(seed);
  const msg = 12345n;

  const [r8x, r8y, sigS] = eddsaPoseidonSignWithScalar(keys.spendingPrivKey, keys.spendingPubKey, msg);

  const R8 = [F.e(r8x), F.e(r8y)];
  const A = [F.e(keys.spendingPubKey.x), F.e(keys.spendingPubKey.y)];

  console.log("R8 in curve:", babyJub.inCurve(R8));
  console.log("R8 in subgroup:", babyJub.inSubgroup(R8));
  console.log("A in curve:", babyJub.inCurve(A));
  console.log("A in subgroup:", babyJub.inSubgroup(A));
  console.log("S < subOrder:", sigS < babyJub.subOrder);
  console.log("S:", sigS);
  console.log("subOrder:", babyJub.subOrder);

  // Now try verifyPoseidon manually
  const poseidon = eddsa.poseidon;
  const hm = poseidon([R8[0], R8[1], A[0], A[1], F.e(msg)]);
  console.log("\nhm:", F.toObject(hm).toString(16).slice(0, 20));

  const Pleft = babyJub.mulPointEscalar(babyJub.Base8, sigS);
  let Pright = babyJub.mulPointEscalar(A, F.toObject(hm));
  Pright = babyJub.addPoint(R8, Pright);

  console.log("Pleft.x:", F.toObject(Pleft[0]).toString(16).slice(0, 20));
  console.log("Pright.x:", F.toObject(Pright[0]).toString(16).slice(0, 20));
  console.log("eq:", F.eq(Pleft[0], Pright[0]) && F.eq(Pleft[1], Pright[1]));
}

test().catch(console.error);
