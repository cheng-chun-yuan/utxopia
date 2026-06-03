import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SuinsClient, SuinsTransaction } from "@mysten/suins";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";

type SuiPocState = {
  network?: string;
  rpcUrl?: string;
  relayer?: {
    address?: string;
    keypairPath?: string;
  };
  suins?: {
    parentName?: string;
    parentNftId?: string;
    targetAddress?: string;
  };
};

const DEFAULT_PARENT_NAME = "utxopia.sui";
const DEFAULT_GAS_BUDGET = 30_000_000n;
const DEFAULT_MAX_PAYMENT = 1_000_000_000n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;

const root = path.resolve(process.cwd(), "..");
const stateFile = process.env.UTXOPIA_SUI_STATE_FILE ?? path.join(root, "chains/sui/sui-poc-state.json");
const state = existsSync(stateFile)
  ? (JSON.parse(readFileSync(stateFile, "utf8")) as SuiPocState)
  : {};

const rpcUrl = process.env.UTXOPIA_SUI_RPC_URL ?? state.rpcUrl ?? "https://fullnode.testnet.sui.io:443";
const network = state.network === "mainnet" ? "mainnet" : "testnet";
const parentName = process.env.UTXOPIA_SUINS_PARENT_NAME ?? state.suins?.parentName ?? DEFAULT_PARENT_NAME;
const signerAddress = process.env.UTXOPIA_SUI_RELAYER_ADDRESS ?? state.relayer?.address;
const keystorePath =
  process.env.UTXOPIA_SUI_RELAYER_KEYPAIR_PATH ??
  state.relayer?.keypairPath ??
  path.join(os.homedir(), ".sui/sui_config/sui.keystore");
const gasBudget = BigInt(process.env.UTXOPIA_SUINS_GAS_BUDGET ?? DEFAULT_GAS_BUDGET.toString());
const maxPayment = BigInt(process.env.UTXOPIA_SUINS_MAX_PAYMENT ?? DEFAULT_MAX_PAYMENT.toString());

function faucetUrl(address: string) {
  return `https://faucet.sui.io/?address=${address}`;
}

function normalizeAddress(address: string) {
  return address.startsWith("0x") ? address.toLowerCase() : `0x${address.toLowerCase()}`;
}

function loadKeypair() {
  if (!existsSync(keystorePath)) {
    throw new Error(`Sui keystore not found at ${keystorePath}`);
  }

  const keys = JSON.parse(readFileSync(keystorePath, "utf8")) as string[];
  for (const encoded of keys) {
    const decoded = fromBase64(encoded);
    const scheme = decoded[0];
    const secret = decoded.slice(1);
    const keypair =
      scheme === 0
        ? Ed25519Keypair.fromSecretKey(secret)
        : scheme === 1
          ? Secp256k1Keypair.fromSecretKey(secret)
          : scheme === 2
            ? Secp256r1Keypair.fromSecretKey(secret)
            : null;

    if (!keypair) continue;
    const address = normalizeAddress(keypair.getPublicKey().toSuiAddress());
    if (!signerAddress || address === normalizeAddress(signerAddress)) return keypair;
  }

  throw new Error(`No matching Sui key found in ${keystorePath}`);
}

function adaptCoreClientForSuins(client: SuiClient) {
  const core = client.core as any;
  const getObject = core.getObject.bind(core);

  core.getObject = async (args: any) => {
    const result = await getObject(args) as any;
    if (result.object) {
      result.object.objectId ??= result.object.id;
      if (result.object.content && typeof result.object.content.then === "function") {
        result.object.content = await result.object.content;
      }
    }
    return result;
  };

  core.getDynamicObjectField = async ({ parentId, name }: any) => {
    const fields = await core.getDynamicFields({ parentId, limit: 100 });
    const field = fields.dynamicFields.find((candidate: any) =>
      candidate.name.type === name.type &&
      Buffer.from(candidate.name.bcs).equals(Buffer.from(name.bcs))
    );
    if (!field) return {};

    const result = await core.getObject({
      objectId: field.id,
      include: { type: true, content: true, bcs: true, owner: true },
    } as any);
    if (result.object) result.object.objectId ??= result.object.id;
    return { object: result.object };
  };
}

async function main() {
  if (network !== "testnet") {
    throw new Error("This helper is intended for SuiNS testnet registration.");
  }

  const signer = loadKeypair();
  const address = normalizeAddress(signer.getPublicKey().toSuiAddress());
  if (!ADDRESS_RE.test(address)) throw new Error(`Invalid signer address: ${address}`);

  const client = new SuiClient({ url: rpcUrl });
  adaptCoreClientForSuins(client);
  const suins = new SuinsClient({ client, network });

  const balance = await client.getBalance({ owner: address });
  console.log(JSON.stringify({
    step: "balance",
    address,
    mist: balance.totalBalance,
    sui: Number(balance.totalBalance) / 1_000_000_000,
  }));

  const existing = await suins.getNameRecord(parentName).catch((error) => {
    const message = String(error?.message ?? error);
    if (message.includes("not found") || message.includes("does not exist")) return null;
    throw error;
  });
  if (existing?.nftId) {
    state.suins = {
      ...(state.suins ?? {}),
      parentName,
      parentNftId: existing.nftId,
      targetAddress: existing.targetAddress || state.suins?.targetAddress,
    };
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, alreadyRegistered: true, parentName, parentNftId: existing.nftId }, null, 2));
    return;
  }

  const tx = new Transaction();
  tx.setSender(address);
  tx.setGasBudget(gasBudget);
  const suinsTx = new SuinsTransaction(suins, tx);
  const [priceInfoObjectId] = await suins.getPriceInfoObject(tx, suins.config.coins.SUI.feed);
  const intent = suinsTx.initRegistration(parentName);
  const basePrice = suinsTx.calculatePriceAfterDiscount(intent, suins.config.coins.SUI.type);
  const suiPrice = suinsTx.calculatePrice(basePrice, suins.config.coins.SUI.type, priceInfoObjectId);
  const [payment] = tx.splitCoins(tx.gas, [suiPrice]);
  const receipt = suinsTx.handlePayment(
    intent,
    payment,
    suins.config.coins.SUI.type,
    priceInfoObjectId,
    maxPayment,
  );
  const nft = suinsTx.finalizeRegister(receipt);
  tx.transferObjects([nft], address);

  const dryRun = await client.dryRunTransactionBlock({ transactionBlock: await tx.build({ client }) });
  if (dryRun.effects.status.status !== "success") {
    const error = dryRun.effects.status.error ?? "SuiNS registration dry run failed";
    if (error.includes("InsufficientCoinBalance")) {
      throw new Error(`Insufficient SUI for registration. Fund ${address}: ${faucetUrl(address)}`);
    }
    throw new Error(error);
  }

  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: result.digest, options: { showEffects: true } });
  if (result.effects?.status.status !== "success") {
    throw new Error(result.effects?.status.error ?? "SuiNS registration failed");
  }

  const record = await suins.getNameRecord(parentName);
  if (!record?.nftId) throw new Error(`${parentName} registered but NFT ID was not discoverable`);

  state.suins = {
    ...(state.suins ?? {}),
    parentName,
    parentNftId: record.nftId,
    targetAddress: record.targetAddress || state.suins?.targetAddress,
  };
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    parentName,
    parentNftId: record.nftId,
    digest: result.digest,
    next: "Run `UTXOPIA_NETWORK=sui-regtest ./scripts/sync-env.sh` to refresh web/backend env.",
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    parentName,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
