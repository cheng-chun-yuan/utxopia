#!/usr/bin/env bun
import { Connection, Keypair } from "@solana/web3.js";
import { Transaction, SigHash } from "../../sdk/node_modules/@scure/btc-signer/index.js";
import {
  VersionedDWalletDataAttestation,
  loadGrpcClient,
  requestPresign,
  requestSign,
  type DWalletSetup,
} from "./lib/ika-setup-vendored.ts";

const STATE_PATH = process.env.STATE_PATH || "scripts/devnet-regtest-state.json";
const PAYER_KEYPAIR_PATH =
  process.env.PAYER_KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`;
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const ESPLORA_URL =
  process.env.ESPLORA_URL || "http://localhost:3002/regtest/api";

const APPROVAL_SIG =
  process.env.APPROVAL_SIG ||
  "n5UTG8T2sW7kEh8CqGmkebXF69gdnxFyu1Cs1RoQ4hUQKDG5Num4PaAz6HEoSFuZTiTCTH86KzNvoya3wyE1uid";

const POOL_TXID =
  process.env.POOL_TXID ||
  "000481f0d8a4630e8b8b2e1370db1bc012173b2fc0585524689315f4a268cf1a";
const POOL_VOUT = Number(process.env.POOL_VOUT || "0");
const POOL_AMOUNT = BigInt(process.env.POOL_AMOUNT || "99778");
const POOL_SCRIPT =
  process.env.POOL_SCRIPT ||
  "5120fee6779b254c746ae4b691ddb650756ab4bfb7a47cdc4416464c76f15e25291d";
const DEST_SCRIPT =
  process.env.DEST_SCRIPT ||
  "0014f129ad8151b7e64047a6c4344c5f5f1ef5a09385";
const DEST_AMOUNT = BigInt(process.env.DEST_AMOUNT || "97579");
const CHANGE_AMOUNT = BigInt(process.env.CHANGE_AMOUNT || "659");

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await Bun.file(path).text());
}

async function readKeypair(path: string): Promise<Keypair> {
  const raw = JSON.parse(await Bun.file(path).text());
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadAttestation(state: any): DWalletSetup["attestation"] {
  const att = state.ika?.attestation;
  if (!att) throw new Error(`missing ika.attestation in ${STATE_PATH}`);
  return {
    attestationData: hexToBytes(att.attestationData),
    networkSignature: hexToBytes(att.networkSignature),
    networkPubkey: hexToBytes(att.networkPubkey),
    epoch: BigInt(att.epoch),
  };
}

function dwalletPublicKeyFromAttestation(attestation: DWalletSetup["attestation"]): Uint8Array {
  const parsed = VersionedDWalletDataAttestation.parse(attestation.attestationData);
  if (!parsed.V1) {
    throw new Error(`unsupported dWallet attestation payload: ${JSON.stringify(parsed)}`);
  }
  return Uint8Array.from(parsed.V1.public_key);
}

function buildWithdrawalTx(): Transaction {
  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: hexToBytes(POOL_TXID),
    index: POOL_VOUT,
    sequence: 0xfffffffd,
    witnessUtxo: {
      script: hexToBytes(POOL_SCRIPT),
      amount: POOL_AMOUNT,
    },
  });
  tx.addOutput({ script: hexToBytes(DEST_SCRIPT), amount: DEST_AMOUNT });
  if (CHANGE_AMOUNT > 0n) {
    tx.addOutput({ script: hexToBytes(POOL_SCRIPT), amount: CHANGE_AMOUNT });
  }
  return tx;
}

async function broadcast(rawHex: string): Promise<string> {
  const resp = await fetch(`${ESPLORA_URL}/tx`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: rawHex,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`broadcast failed ${resp.status}: ${text}`);
  }
  return text.trim();
}

async function maybeMineBlock() {
  const cli = "/srv/explorer/bitcoin/bin/bitcoin-cli";
  const args = [
    "exec",
    "utxopia-esplora-regtest",
    cli,
    "-regtest",
    "-datadir=/data/bitcoin",
    "-rpcwallet=test",
  ];
  const addressProc = Bun.spawn(["docker", ...args, "getnewaddress"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const address = (await new Response(addressProc.stdout).text()).trim();
  if ((await addressProc.exited) !== 0 || !address) {
    console.warn("skip mining: could not get regtest address");
    return;
  }
  const mineProc = Bun.spawn(["docker", ...args, "generatetoaddress", "1", address], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(mineProc.stdout).text()).trim();
  const err = (await new Response(mineProc.stderr).text()).trim();
  if ((await mineProc.exited) !== 0) {
    console.warn(`skip mining: ${err || out}`);
    return;
  }
  console.log(`mined regtest block: ${out}`);
}

async function main() {
  const state = await readJson(STATE_PATH);
  const payer = await readKeypair(PAYER_KEYPAIR_PATH);
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const approvalTx = await connection.getTransaction(APPROVAL_SIG, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!approvalTx) throw new Error(`approval tx not found: ${APPROVAL_SIG}`);

  const attestation = loadAttestation(state);
  const dwalletPublicKey = dwalletPublicKeyFromAttestation(attestation);
  const tx = buildWithdrawalTx();
  const sighash = tx.preimageWitnessV1(
    0,
    [hexToBytes(POOL_SCRIPT)],
    SigHash.DEFAULT,
    [POOL_AMOUNT],
  );

  console.log(`approval slot: ${approvalTx.slot}`);
  console.log(`dwallet pubkey: ${bytesToHex(dwalletPublicKey)}`);
  console.log(`btc sighash: ${bytesToHex(sighash)}`);
  console.log(`unsigned txid: ${tx.id}`);

  const grpc = loadGrpcClient(state.ika.grpcEndpoint);
  const presignId = await requestPresign(
    grpc,
    payer,
    dwalletPublicKey,
    attestation,
  );
  console.log(`presign id: ${bytesToHex(presignId)}`);

  const signature = await requestSign(
    grpc,
    payer,
    dwalletPublicKey,
    attestation,
    sighash,
    presignId,
    APPROVAL_SIG,
    BigInt(approvalTx.slot),
  );
  console.log(`signature (${signature.length} bytes): ${bytesToHex(signature)}`);

  tx.updateInput(0, { tapKeySig: signature }, true);
  tx.finalize();
  const rawHex = tx.hex;
  console.log(`signed txid: ${tx.id}`);
  console.log(`signed raw tx: ${rawHex}`);

  const broadcastTxid = await broadcast(rawHex);
  console.log(`broadcast txid: ${broadcastTxid}`);
  await maybeMineBlock();
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
