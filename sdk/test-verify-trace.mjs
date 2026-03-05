import { eddsaPoseidonSignWithScalar, deriveKeysFromSeed, deriveMasterKey, initPoseidon, poseidonHashSync } from "./dist/index.js";
import { buildEddsa } from "circomlibjs";

async function test() {
  await initPoseidon();
  const eddsa = await buildEddsa();
  const F = eddsa.babyJub.F;
  const babyJub = eddsa.babyJub;
  const poseidon = eddsa.poseidon;

  const seed = deriveMasterKey("alpha-test");
  const keys = deriveKeysFromSeed(seed);
  const msg = 12345n;

  const [r8x, r8y, sigS] = eddsaPoseidonSignWithScalar(keys.spendingPrivKey, keys.spendingPubKey, msg);

  const sig = { R8: [F.e(r8x), F.e(r8y)], S: sigS };
  const A = [F.e(keys.spendingPubKey.x), F.e(keys.spendingPubKey.y)];
  const M = F.e(msg);

  // Exactly replicate verifyPoseidon
  console.log("inCurve(R8):", babyJub.inCurve(sig.R8));
  console.log("inSubgroup(R8):", babyJub.inSubgroup(sig.R8));
  console.log("S < subOrder:", sig.S < babyJub.subOrder);
  console.log("inCurve(A):", babyJub.inCurve(A));

  // Poseidon hash — this is what verifyPoseidon does
  const hm = poseidon([sig.R8[0], sig.R8[1], A[0], A[1], M]);
  console.log("\nhm (eddsa.poseidon):", F.toObject(hm).toString(16).slice(0, 30));

  // My poseidonHashSync for comparison
  const myHm = poseidonHashSync([r8x, r8y, keys.spendingPubKey.x, keys.spendingPubKey.y, msg]);
  console.log("hm (my poseidon):   ", myHm.toString(16).slice(0, 30));
  console.log("hm match:", F.toObject(hm) === myHm);

  // The verification uses hm as field element for mulPointEscalar
  // But mulPointEscalar takes a bigint scalar, not a field element!
  // Let me check what circomlibjs does here...
  const hmBigint = F.toObject(hm);
  console.log("\nhm as bigint for mul:", hmBigint.toString(16).slice(0, 30));

  const Pleft = babyJub.mulPointEscalar(babyJub.Base8, sig.S);
  // NOTE: verifyPoseidon passes hm (field element), not hmBigint to mulPointEscalar
  const Pright1 = babyJub.mulPointEscalar(A, hm);
  const Pright1_bigint = babyJub.mulPointEscalar(A, hmBigint);

  console.log("\nPright (hm as field):", F.toObject(Pright1[0]).toString(16).slice(0, 20));
  console.log("Pright (hm as bigint):", F.toObject(Pright1_bigint[0]).toString(16).slice(0, 20));
  console.log("Same?:", F.eq(Pright1[0], Pright1_bigint[0]));

  const Pright = babyJub.addPoint(sig.R8, Pright1);
  const Pright_b = babyJub.addPoint(sig.R8, Pright1_bigint);

  console.log("\nPleft:", F.toObject(Pleft[0]).toString(16).slice(0, 20));
  console.log("Pright (field hm):", F.toObject(Pright[0]).toString(16).slice(0, 20));
  console.log("Pright (bigint hm):", F.toObject(Pright_b[0]).toString(16).slice(0, 20));
  console.log("eq (field):", F.eq(Pleft[0], Pright[0]));
  console.log("eq (bigint):", F.eq(Pleft[0], Pright_b[0]));
}

test().catch(console.error);
