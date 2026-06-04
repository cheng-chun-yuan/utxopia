import { expect, test } from "bun:test";
import { UTXOpiaSuiAdapter } from "../src/sui-adapter";
import { UTXOpiaSuiIkaAdapter, defaultIkaConfig } from "../src/ika";

const objectId = `0x${"1".padStart(64, "0")}`;

function adapter() {
  return new UTXOpiaSuiAdapter({
    rpcUrl: "http://127.0.0.1:9000",
    packageId: objectId,
    poolObjectId: objectId,
    poolInitialSharedVersion: 1,
    btcDepositRegistryObjectId: objectId,
    btcDepositRegistryInitialSharedVersion: 1,
    adminCapObjectId: objectId,
    adminCapVersion: "1",
    adminCapDigest: "11111111111111111111111111111111",
    verifyingKeyRegistryObjectId: objectId,
    verifyingKeyRegistryInitialSharedVersion: 1,
    nullifierRegistryObjectId: objectId,
    nullifierRegistryInitialSharedVersion: 1,
    redemptionQueueObjectId: objectId,
    redemptionQueueInitialSharedVersion: 1,
    redemptionCapObjectId: objectId,
    redemptionCapVersion: "1",
    redemptionCapDigest: "11111111111111111111111111111111",
  });
}

test("rejects generic Sui shield PTBs offline", async () => {
  await expect(adapter().buildShieldTransaction({
    recipient: "recipient",
    tokenId: "zkbtc",
    amount: 1n,
    metadata: {
      commitment: "11".repeat(32),
    },
  })).rejects.toThrow("Sui generic shield PTBs are disabled");
});

test("builds register verifying key PTB transaction-kind bytes offline", async () => {
  const tx = await adapter().buildRegisterVerifyingKeyTransaction({
    nInputs: 2,
    nOutputs: 2,
    nPublic: 6,
    vkHash: new Uint8Array(32).fill(1),
    vkGammaAbcG1Bytes: new Uint8Array([1]),
    alphaG1BetaG2Bytes: new Uint8Array([2]),
    gammaG2NegPcBytes: new Uint8Array([3]),
    deltaG2NegPcBytes: new Uint8Array([4]),
  });

  expect(tx.kind).toBe("sui-programmable-transaction-block");
  expect(tx.bytes.length).toBeGreaterThan(0);
});

test("rejects Sui verifying keys for unsupported shared circuit shapes", async () => {
  await expect(adapter().buildRegisterVerifyingKeyTransaction({
    nInputs: 6,
    nOutputs: 1,
    nPublic: 9,
    vkHash: new Uint8Array(32).fill(1),
    vkGammaAbcG1Bytes: new Uint8Array([1]),
    alphaG1BetaG2Bytes: new Uint8Array([2]),
    gammaG2NegPcBytes: new Uint8Array([3]),
    deltaG2NegPcBytes: new Uint8Array([4]),
  })).rejects.toThrow("supports at most 8");
});

test("rejects Sui verifying keys with incorrect public input counts", async () => {
  await expect(adapter().buildRegisterVerifyingKeyTransaction({
    nInputs: 2,
    nOutputs: 2,
    nPublic: 7,
    vkHash: new Uint8Array(32).fill(1),
    vkGammaAbcG1Bytes: new Uint8Array([1]),
    alphaG1BetaG2Bytes: new Uint8Array([2]),
    gammaG2NegPcBytes: new Uint8Array([3]),
    deltaG2NegPcBytes: new Uint8Array([4]),
  })).rejects.toThrow("joinsplit_2x2 expects 6 public inputs");
});

test("builds verified BTC deposit PTB transaction-kind bytes offline", async () => {
  const tx = await adapter().buildBtcDepositTransaction({
    verifiedDepositObjectId: objectId,
    verifiedDepositVersion: "1",
    verifiedDepositDigest: "11111111111111111111111111111111",
  });

  expect(tx.kind).toBe("sui-programmable-transaction-block");
  expect(tx.bytes.length).toBeGreaterThan(0);
  expect(tx.objectIds).toContain(objectId);
});

test("builds transact PTB transaction-kind bytes offline", async () => {
  const tx = await adapter().buildTransactTransaction({
    inputNotes: [
      {
        commitment: "11".repeat(32),
        nullifier: "22".repeat(32),
        tokenId: "zkbtc",
        leafIndex: 0,
      },
    ],
    outputs: [
      {
        recipient: "recipient",
        tokenId: "zkbtc",
        amount: 1n,
      },
    ],
    proof: new Uint8Array(),
    boundParamsHash: "33".repeat(32),
    vkHash: new Uint8Array(32).fill(4),
    publicInputs: new Uint8Array(32 * 4).fill(5),
    proofPoints: new Uint8Array(128).fill(6),
    commitmentsOut: [new Uint8Array(32).fill(7)],
  });

  expect(tx.kind).toBe("sui-programmable-transaction-block");
  expect(tx.bytes.length).toBeGreaterThan(0);
});

test("builds redemption PTB transaction-kind bytes offline", async () => {
  const tx = await adapter().buildRedemptionTransaction({
    inputNotes: [],
    btcAddress: `0014${"22".repeat(20)}`,
    amountSats: 1n,
    maxFeeSats: 1n,
    proof: new Uint8Array(),
  });

  expect(tx.kind).toBe("sui-programmable-transaction-block");
  expect(tx.bytes.length).toBeGreaterThan(0);
});

test("builds Ika approval PTB transaction-kind bytes offline", async () => {
  const tx = await adapter().buildIkaApprovalTransaction({
    redemptionId: 0,
    sighash: new Uint8Array(32).fill(9),
  });

  expect(tx.kind).toBe("sui-programmable-transaction-block");
  expect(tx.bytes.length).toBeGreaterThan(0);
});

test("builds redemption completion PTB transaction-kind bytes offline", async () => {
  const tx = await adapter().buildCompleteRedemptionTransaction({
    redemptionId: 0,
    btcTxid: new Uint8Array(32).fill(10),
  });

  expect(tx.kind).toBe("sui-programmable-transaction-block");
  expect(tx.bytes.length).toBeGreaterThan(0);
});

test("loads native Ika Sui testnet config", () => {
  const config = defaultIkaConfig("testnet");

  expect(config.packages.ikaPackage.startsWith("0x")).toBe(true);
  expect(config.objects.ikaSystemObject.objectID.startsWith("0x")).toBe(true);
  expect(config.objects.ikaDWalletCoordinator.objectID.startsWith("0x")).toBe(true);
});

test("validates native Ika Taproot approval inputs before PTB build", async () => {
  const ika = new UTXOpiaSuiIkaAdapter({
    rpcUrl: "https://fullnode.testnet.sui.io:443",
    network: "testnet",
    dWalletCapObjectId: objectId,
  });

  await expect(ika.buildApproveTaprootMessageTransaction({
    message: new Uint8Array(31).fill(9),
  })).rejects.toThrow("32 bytes");
});
