/**
 * Simplified debug script to verify merkle proof computation
 */
import { Connection, PublicKey } from "@solana/web3.js";

// Import only what we need from specific files
import { buildCommitmentTreeFromChain, getMerkleProofFromTree, parseCommitmentTreeData } from "../dist/commitment-tree";
import { initPoseidon, poseidonHashSync } from "../dist/poseidon";
import { bytesToBigint } from "../dist/crypto";
import { DEVNET_CONFIG } from "../dist/config";

async function main() {
  await initPoseidon();

  // The commitment from the pay flow (leaf index 9)
  const commitmentHex = "1352bd123349fc94c04383449ee632d9e8c14212ac39df192d81e5f76a8dad77";
  const commitment = BigInt("0x" + commitmentHex);

  console.log("=== Debug Merkle Proof ===");
  console.log("Commitment hex:", commitmentHex);
  console.log("Commitment bigint:", commitment.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com");

  // 1. Build tree from chain
  console.log("\n1. Building tree from chain...");
  const tree = await buildCommitmentTreeFromChain(
    {
      getProgramAccounts: async (programId, config) => {
        const filters = config?.filters
          ?.map((f: { memcmp?: { offset: number; bytes: string }; dataSize?: number }) => {
            if (f.memcmp) {
              return { memcmp: { offset: f.memcmp.offset, bytes: f.memcmp.bytes } };
            }
            if (f.dataSize !== undefined) {
              return { dataSize: f.dataSize };
            }
            return null;
          })
          .filter((f): f is NonNullable<typeof f> => f !== null);

        const accounts = await connection.getProgramAccounts(
          new PublicKey(programId),
          { filters }
        );
        return accounts.map((acc) => ({
          pubkey: acc.pubkey.toBase58(),
          account: { data: acc.account.data },
        }));
      },
    },
    DEVNET_CONFIG.zvaultProgramId
  );

  console.log("Tree size:", tree.size());

  // 2. Get merkle proof from tree
  console.log("\n2. Getting merkle proof...");
  const proof = getMerkleProofFromTree(tree, commitment);

  if (!proof) {
    console.error("ERROR: Commitment not found in tree!");
    return;
  }

  console.log("Leaf index:", proof.leafIndex);
  console.log("Computed root:", proof.root.toString(16).padStart(64, "0"));
  console.log("Siblings count:", proof.siblings.length);
  console.log("Indices:", proof.indices.join(", "));

  // 3. Fetch on-chain root
  console.log("\n3. Fetching on-chain root...");
  const commitmentTreePda = new PublicKey(DEVNET_CONFIG.commitmentTreePda);
  const treeAccountInfo = await connection.getAccountInfo(commitmentTreePda);

  if (!treeAccountInfo) {
    console.error("ERROR: Could not fetch commitment tree account");
    return;
  }

  const treeState = parseCommitmentTreeData(new Uint8Array(treeAccountInfo.data));
  const onChainRoot = bytesToBigint(treeState.currentRoot);
  console.log("On-chain root:", onChainRoot.toString(16).padStart(64, "0"));
  console.log("Computed root matches on-chain:", proof.root === onChainRoot);

  // 4. Manually verify merkle proof (circuit logic)
  console.log("\n4. Manually verifying merkle proof (simulating circuit)...");
  let current = commitment;
  console.log("Starting with commitment:", current.toString(16).padStart(64, "0"));

  for (let i = 0; i < 20; i++) {
    const sibling = proof.siblings[i];
    const isRight = proof.indices[i] === 1;

    let left: bigint, right: bigint;
    if (isRight) {
      // Current is right child, sibling is left
      left = sibling;
      right = current;
    } else {
      // Current is left child, sibling is right
      left = current;
      right = sibling;
    }

    current = poseidonHashSync([left, right]);

    if (i < 3) {
      console.log(`Level ${i}: isRight=${isRight}, sibling=${sibling.toString(16).slice(0, 16)}..., result=${current.toString(16).slice(0, 16)}...`);
    }
  }

  console.log("\nFinal computed root:", current.toString(16).padStart(64, "0"));
  console.log("Expected root:      ", onChainRoot.toString(16).padStart(64, "0"));
  console.log("ROOTS MATCH:", current === onChainRoot);

  // 5. Check the values the frontend is using
  console.log("\n5. Frontend values check...");
  const pubKeyX = BigInt("0x1bf558ef08822e6822b76f8a334a15dad6a386de5dfefd62377f89c7c21098ca");
  const amount = 100000n;

  // Compute commitment as circuit would
  const computedCommitment = poseidonHashSync([pubKeyX, amount]);
  console.log("pubKeyX:", pubKeyX.toString(16).padStart(64, "0"));
  console.log("amount:", amount.toString());
  console.log("Computed commitment:", computedCommitment.toString(16).padStart(64, "0"));
  console.log("Expected commitment:", commitmentHex);
  console.log("COMMITMENT MATCH:", computedCommitment.toString(16).padStart(64, "0") === commitmentHex);
}

main().catch(console.error);
