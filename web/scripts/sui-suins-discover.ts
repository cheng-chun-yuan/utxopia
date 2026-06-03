import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SuinsClient } from "@mysten/suins";
import { SuiClient } from "@mysten/sui/client";

type SuiPocState = {
  network?: string;
  rpcUrl?: string;
  suins?: {
    parentName?: string;
    parentNftId?: string;
    targetAddress?: string;
  };
};

const root = path.resolve(process.cwd(), "..");
const stateFile = process.env.UTXOPIA_SUI_STATE_FILE ?? path.join(root, "chains/sui/sui-poc-state.json");
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8")) as SuiPocState
  : {};

const rpcUrl = process.env.UTXOPIA_SUI_RPC_URL ?? state.rpcUrl ?? "https://fullnode.testnet.sui.io:443";
const network = state.network === "mainnet" ? "mainnet" : "testnet";
const parentName = process.env.UTXOPIA_SUINS_PARENT_NAME ?? state.suins?.parentName ?? "utxopia.sui";

const client = new SuiClient({ url: rpcUrl });
const suins = new SuinsClient({ client, network });

try {
  const record = await suins.getNameRecord(parentName);
  if (!record?.nftId) {
    throw new Error(`${parentName} exists but has no NFT ID`);
  }

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
    targetAddress: record.targetAddress || null,
    note: "Run `UTXOPIA_NETWORK=sui-regtest ./scripts/sync-env.sh` to refresh web/backend env.",
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    parentName,
    error: error instanceof Error ? error.message : String(error),
    next: "Register utxopia.sui on SuiNS testnet, then rerun `bun run sui:suins:discover`.",
  }, null, 2));
  process.exit(1);
}
