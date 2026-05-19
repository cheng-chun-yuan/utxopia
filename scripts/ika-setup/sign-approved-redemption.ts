#!/usr/bin/env bun
import { Connection, Keypair } from "@solana/web3.js";
import { secp256k1, schnorr } from "../../sdk/node_modules/@noble/curves/secp256k1.js";
import { sha256 } from "../../sdk/node_modules/@noble/hashes/sha2.js";
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
const IMPORT_PRIV = process.env.IMPORT_PRIV;

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function xOnlyFromCompressedSecp256k1(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 33 || (publicKey[0] !== 0x02 && publicKey[0] !== 0x03)) {
    throw new Error(`expected compressed secp256k1 public key, got ${publicKey.length} bytes`);
  }
  return publicKey.subarray(1);
}

function compactSizeBytes(length: number): Buffer {
  if (length < 0xfd) return Buffer.from([length]);
  if (length <= 0xffff) {
    const out = Buffer.alloc(3);
    out[0] = 0xfd;
    out.writeUInt16LE(length, 1);
    return out;
  }
  if (length <= 0xffffffff) {
    const out = Buffer.alloc(5);
    out[0] = 0xfe;
    out.writeUInt32LE(length, 1);
    return out;
  }
  const out = Buffer.alloc(9);
  out[0] = 0xff;
  out.writeBigUInt64LE(BigInt(length), 1);
  return out;
}

function u32le(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function i32le(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeInt32LE(value, 0);
  return out;
}

function u64le(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}

function taggedTapSighashPreimage(
  tx: Transaction,
  inputIndex: number,
  prevOutScripts: Uint8Array[],
  hashType: number,
  amounts: bigint[],
): Uint8Array {
  const inputs = tx.inputs.map((input: any) => ({
    txid: Buffer.from(input.txid).reverse(),
    index: input.index,
    sequence: input.sequence ?? 0xffffffff,
  }));
  const outputs = tx.outputs.map((output: any) => ({
    amount: BigInt(output.amount),
    script: Buffer.from(output.script),
  }));
  const outType = hashType === SigHash.DEFAULT ? SigHash.ALL : hashType & 0b11;
  const inType = hashType & SigHash.ANYONECANPAY;

  const chunks: Buffer[] = [
    Buffer.from([0]),
    Buffer.from([hashType]),
    i32le((tx as any).version),
    u32le((tx as any).lockTime),
  ];

  if (inType !== SigHash.ANYONECANPAY) {
    chunks.push(
      Buffer.from(
        sha256(
          Buffer.concat(inputs.map((input) => Buffer.concat([input.txid, u32le(input.index)]))),
        ),
      ),
      Buffer.from(sha256(Buffer.concat(amounts.map(u64le)))),
      Buffer.from(
        sha256(
          Buffer.concat(
            prevOutScripts.map((script) =>
              Buffer.concat([compactSizeBytes(script.length), Buffer.from(script)]),
            ),
          ),
        ),
      ),
      Buffer.from(sha256(Buffer.concat(inputs.map((input) => u32le(input.sequence))))),
    );
  }

  if (outType === SigHash.ALL) {
    chunks.push(
      Buffer.from(
        sha256(
          Buffer.concat(
            outputs.map((output) =>
              Buffer.concat([
                u64le(output.amount),
                compactSizeBytes(output.script.length),
                output.script,
              ]),
            ),
          ),
        ),
      ),
    );
  }

  chunks.push(Buffer.from([0]));
  if (inType === SigHash.ANYONECANPAY) {
    const input = inputs[inputIndex];
    const prevOutScript = Buffer.from(prevOutScripts[inputIndex]);
    chunks.push(
      input.txid,
      u32le(input.index),
      u64le(amounts[inputIndex]),
      compactSizeBytes(prevOutScript.length),
      prevOutScript,
      u32le(input.sequence),
    );
  } else {
    chunks.push(u32le(inputIndex));
  }

  if (outType === SigHash.SINGLE) {
    const output = outputs[inputIndex];
    chunks.push(
      output
        ? Buffer.from(
            sha256(
              Buffer.concat([
                u64le(output.amount),
                compactSizeBytes(output.script.length),
                output.script,
              ]),
            ),
          )
        : Buffer.alloc(32),
    );
  }

  const tagHash = sha256(new TextEncoder().encode("TapSighash"));
  return Buffer.concat([Buffer.from(tagHash), Buffer.from(tagHash), ...chunks]);
}

async function assertSchnorrSignatureVerifies(
  signature: Uint8Array,
  message: Uint8Array,
  dwalletPublicKey: Uint8Array,
) {
  const dwalletXOnly = xOnlyFromCompressedSecp256k1(dwalletPublicKey);
  const verifiesWithDwallet = schnorr.verify(signature, message, dwalletXOnly);
  console.log(`verify signature with dWallet x-only: ${verifiesWithDwallet}`);

  if (IMPORT_PRIV) {
    const importPrivateKey = hexToBytes(IMPORT_PRIV);
    if (importPrivateKey.length !== 32) {
      throw new Error("IMPORT_PRIV must be 32-byte hex");
    }
    const importedPublicKey = secp256k1.getPublicKey(importPrivateKey, true);
    const importedXOnly = xOnlyFromCompressedSecp256k1(importedPublicKey);
    const verifiesWithImportKey = schnorr.verify(signature, message, importedXOnly);
    const localSignature = await schnorr.sign(message, importPrivateKey);
    const localSignatureVerifies = schnorr.verify(localSignature, message, importedXOnly);

    console.log(`import pubkey: ${bytesToHex(importedPublicKey)}`);
    console.log(`verify signature with IMPORT_PRIV x-only: ${verifiesWithImportKey}`);
    console.log(`local IMPORT_PRIV signature verifies: ${localSignatureVerifies}`);
  }

  if (!verifiesWithDwallet) {
    throw new Error(
      [
        "Ika returned a Schnorr signature that does not verify for the configured dWallet.",
        `message: ${bytesToHex(message)}`,
        `dWallet pubkey: ${bytesToHex(dwalletPublicKey)}`,
        `signature: ${bytesToHex(signature)}`,
      ].join("\n"),
    );
  }
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
  const tapSighashPreimage = taggedTapSighashPreimage(
    tx,
    0,
    [hexToBytes(POOL_SCRIPT)],
    SigHash.DEFAULT,
    [POOL_AMOUNT],
  );
  const preimageHash = sha256(tapSighashPreimage);
  if (bytesToHex(preimageHash) !== bytesToHex(sighash)) {
    throw new Error(
      `TapSighash preimage mismatch: sha256(preimage)=${bytesToHex(preimageHash)} sighash=${bytesToHex(sighash)}`,
    );
  }

  console.log(`approval slot: ${approvalTx.slot}`);
  console.log(`dwallet pubkey: ${bytesToHex(dwalletPublicKey)}`);
  console.log(`btc sighash: ${bytesToHex(sighash)}`);
  console.log(`ika sign message: ${bytesToHex(tapSighashPreimage)}`);
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
    tapSighashPreimage,
    presignId,
    APPROVAL_SIG,
    BigInt(approvalTx.slot),
  );
  console.log(`signature (${signature.length} bytes): ${bytesToHex(signature)}`);
  await assertSchnorrSignatureVerifies(signature, sighash, dwalletPublicKey);

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
