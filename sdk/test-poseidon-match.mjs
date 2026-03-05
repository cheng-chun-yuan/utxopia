import { eddsaPoseidonSign, eddsaGetPubKey, eddsaPoseidonSignWithScalar, deriveKeysFromSeed, deriveMasterKey, initPoseidon, poseidonHashSync } from "./dist/index.js";
import { buildEddsa } from "circomlibjs";

async function test() {
  await initPoseidon();
  const eddsa = await buildEddsa();
  const F = eddsa.babyJub.F;

  const seed = deriveMasterKey("alpha-test");
  const keys = deriveKeysFromSeed(seed);

  // Test Poseidon: circomlibjs vs our sync
  const inputs = [123n, 456n, 789n];

  // Our Poseidon
  const ourResult = poseidonHashSync(inputs);

  // circomlibjs Poseidon
  const poseidon = await (await import("circomlibjs")).buildPoseidon();
  const circomResult = poseidon.F.toObject(poseidon(inputs.map(x => poseidon.F.e(x))));

  console.log("Poseidon match:", ourResult === circomResult);
  console.log("  ours:   ", ourResult.toString(16).slice(0, 20));
  console.log("  circom: ", circomResult.toString(16).slice(0, 20));

  // Now test 5-input Poseidon (as used in EdDSA hash)
  const msg = 12345n;
  const [r8x, r8y, sigS] = eddsaPoseidonSignWithScalar(keys.spendingPrivKey, keys.spendingPubKey, msg);

  // Our hash of (R8x, R8y, Ax, Ay, M)
  const ourHm = poseidonHashSync([r8x, r8y, keys.spendingPubKey.x, keys.spendingPubKey.y, msg]);

  // circomlibjs hash of same
  const circomHm = poseidon.F.toObject(poseidon([r8x, r8y, keys.spendingPubKey.x, keys.spendingPubKey.y, msg].map(x => poseidon.F.e(x))));

  console.log("\n5-input Poseidon (EdDSA hm) match:", ourHm === circomHm);
  console.log("  ours:   ", ourHm.toString(16).slice(0, 20));
  console.log("  circom: ", circomHm.toString(16).slice(0, 20));

  // Now verify using circomlibjs
  const circomPub = eddsa.prv2pub(Buffer.from(keys.eddsaSeed));
  console.log("\ncircomlibjs pub (from eddsaSeed):");
  console.log("  x:", F.toObject(circomPub[0]).toString(16).slice(0, 20));
  console.log("sync pub:");
  console.log("  x:", keys.spendingPubKey.x.toString(16).slice(0, 20));

  // Verify our signature using circomlibjs verify
  const sigObj = {
    R8: [F.e(r8x), F.e(r8y)],
    S: sigS
  };
  const pubSync = [F.e(keys.spendingPubKey.x), F.e(keys.spendingPubKey.y)];
  const isValid = eddsa.verifyPoseidon(F.e(msg), sigObj, pubSync);
  console.log("\ncircomlibjs verifyPoseidon (sync pub + custom sig):", isValid);
}

test().catch(console.error);
