/**
 * PSBT builder for UTXOpia non-interactive deposits.
 *
 * Creates a Partially-Signed Bitcoin Transaction with:
 *   - Input(s): user's UTXOs (P2TR or P2WPKH)
 *   - Output 1: P2TR deposit (commitment-bound Taproot address)
 *   - Output 2: OP_RETURN (64 bytes: ephemeralPub || npk)
 *   - Output 3: change back to user (if needed)
 *
 * Uses @scure/btc-signer for PSBT construction.
 */

import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";

// =============================================================================
// Types
// =============================================================================

/** UTXO descriptor for PSBT inputs */
export interface UtxoDescriptor {
  /** Transaction ID (hex, 64 chars) */
  txid: string;
  /** Output index */
  vout: number;
  /** Value in satoshis */
  value: number;
  /** Raw scriptPubkey (hex) */
  scriptPubkeyHex: string;
  /** Witness UTXO script type (inferred from scriptPubkey if omitted) */
  type?: "p2tr" | "p2wpkh";
}

/** Parameters for building a deposit PSBT */
export interface BuildDepositPsbtParams {
  /** Sender's UTXOs to spend */
  senderUtxos: UtxoDescriptor[];
  /** Taproot deposit address (bc1p... or tb1p...) */
  depositAddress: string;
  /** Deposit amount in satoshis */
  depositAmountSats: number;
  /** 64-byte OP_RETURN payload (from buildDepositOpReturn) */
  opReturnPayload: Uint8Array;
  /** Change address (same type as sender) */
  changeAddress: string;
  /** Fee rate in sats/vbyte */
  feeRate: number;
  /** Bitcoin network */
  network?: "mainnet" | "testnet" | "signet";
}

/** Result of PSBT construction */
export interface BuildDepositPsbtResult {
  /** PSBT encoded as base64 */
  psbtBase64: string;
  /** PSBT encoded as hex */
  psbtHex: string;
  /** Estimated transaction fee in satoshis */
  estimatedFee: number;
  /** Total input value in satoshis */
  totalInput: number;
  /** Change amount in satoshis (0 if no change) */
  changeAmount: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Dust limit for Bitcoin outputs (satoshis) */
const DUST_LIMIT = 546;

/** Estimated vbytes per P2TR key-path input */
const P2TR_INPUT_VBYTES = 58;

/** Estimated vbytes per P2WPKH input */
const P2WPKH_INPUT_VBYTES = 68;

/** Estimated vbytes for P2TR output */
const P2TR_OUTPUT_VBYTES = 43;

/** Estimated vbytes for OP_RETURN output (with 64-byte payload) */
const OP_RETURN_OUTPUT_VBYTES = 75; // 8 value + 1 script_len + 1 OP_RETURN + 1 push + 64 payload

/** Transaction overhead (version + locktime + segwit marker + input/output count) */
const TX_OVERHEAD_VBYTES = 11;

// =============================================================================
// Fee Estimation
// =============================================================================

/**
 * Estimate the transaction fee for a deposit PSBT.
 */
export function estimateDepositFee(
  numInputs: number,
  feeRate: number,
  inputType: "p2tr" | "p2wpkh" = "p2tr",
  hasChange: boolean = true,
): number {
  const inputVbytes = inputType === "p2tr" ? P2TR_INPUT_VBYTES : P2WPKH_INPUT_VBYTES;
  const outputCount = hasChange ? 3 : 2; // deposit + OP_RETURN + optional change

  const vsize =
    TX_OVERHEAD_VBYTES +
    numInputs * inputVbytes +
    P2TR_OUTPUT_VBYTES + // deposit output
    OP_RETURN_OUTPUT_VBYTES + // OP_RETURN output
    (hasChange ? P2TR_OUTPUT_VBYTES : 0); // change output

  return Math.ceil(vsize * feeRate);
}

// =============================================================================
// PSBT Builder
// =============================================================================

/**
 * Build a deposit PSBT with OP_RETURN for non-interactive stealth deposits.
 *
 * The PSBT is unsigned — it must be signed by the user's wallet (e.g. via sats-connect).
 */
export function buildDepositPsbt(params: BuildDepositPsbtParams): BuildDepositPsbtResult {
  const {
    senderUtxos,
    depositAddress,
    depositAmountSats,
    opReturnPayload,
    changeAddress,
    feeRate,
    network = "testnet",
  } = params;

  if (senderUtxos.length === 0) {
    throw new Error("No UTXOs provided");
  }
  if (depositAmountSats < DUST_LIMIT) {
    throw new Error(`Deposit amount ${depositAmountSats} is below dust limit ${DUST_LIMIT}`);
  }
  if (opReturnPayload.length !== 64) {
    throw new Error(`OP_RETURN payload must be 64 bytes, got ${opReturnPayload.length}`);
  }

  const btcNetwork = network === "mainnet" ? btc.NETWORK : btc.TEST_NETWORK;

  // Calculate total input value
  const totalInput = senderUtxos.reduce((sum, u) => sum + u.value, 0);

  // Detect input type from first UTXO
  const firstScript = hex.decode(senderUtxos[0].scriptPubkeyHex);
  const inputType = firstScript[0] === 0x51 ? "p2tr" : "p2wpkh";

  // Estimate fee with change
  const feeWithChange = estimateDepositFee(senderUtxos.length, feeRate, inputType, true);
  const changeAmount = totalInput - depositAmountSats - feeWithChange;

  // Check if we have enough funds
  const feeWithoutChange = estimateDepositFee(senderUtxos.length, feeRate, inputType, false);
  if (totalInput < depositAmountSats + feeWithoutChange) {
    throw new Error(
      `Insufficient funds: have ${totalInput} sats, need ${depositAmountSats + feeWithoutChange} sats (including fee)`,
    );
  }

  const hasChange = changeAmount > DUST_LIMIT;
  const actualFee = hasChange ? feeWithChange : totalInput - depositAmountSats;

  // Build the transaction using @scure/btc-signer
  // allowUnknownOutputs is required for the OP_RETURN output script
  const tx = new btc.Transaction({ allowUnknownOutputs: true });

  // Add inputs
  for (const utxo of senderUtxos) {
    const scriptPubkey = hex.decode(utxo.scriptPubkeyHex);

    if (scriptPubkey[0] === 0x51 && scriptPubkey.length === 34) {
      // P2TR input
      tx.addInput({
        txid: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: scriptPubkey,
          amount: BigInt(utxo.value),
        },
        tapInternalKey: scriptPubkey.slice(2), // x-only pubkey from OP_1 <32 bytes>
      });
    } else if (scriptPubkey[0] === 0x00 && scriptPubkey.length === 22) {
      // P2WPKH input
      tx.addInput({
        txid: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: scriptPubkey,
          amount: BigInt(utxo.value),
        },
      });
    } else {
      throw new Error(`Unsupported input script type for UTXO ${utxo.txid}:${utxo.vout}`);
    }
  }

  // Output 1: P2TR deposit
  tx.addOutputAddress(depositAddress, BigInt(depositAmountSats), btcNetwork);

  // Output 2: OP_RETURN with 72-byte payload
  // Build script: OP_RETURN (0x6a) + OP_PUSHDATA1 (0x4c) + length (0x48 = 72) + payload
  // Actually for 72 bytes (> 75? No, 72 <= 75), use direct push opcode
  const opReturnScript = new Uint8Array(2 + opReturnPayload.length);
  opReturnScript[0] = 0x6a; // OP_RETURN
  opReturnScript[1] = opReturnPayload.length; // push 72 bytes (72 = 0x48)
  opReturnScript.set(opReturnPayload, 2);

  tx.addOutput({
    script: opReturnScript,
    amount: 0n,
  });

  // Output 3: Change (if above dust)
  if (hasChange) {
    tx.addOutputAddress(changeAddress, BigInt(changeAmount), btcNetwork);
  }

  // Extract PSBT
  const psbtBytes = tx.toPSBT();
  const psbtHex = hex.encode(psbtBytes);
  const psbtBase64 = btoa(String.fromCharCode(...psbtBytes));

  return {
    psbtBase64,
    psbtHex,
    estimatedFee: actualFee,
    totalInput,
    changeAmount: hasChange ? changeAmount : 0,
  };
}

// =============================================================================
// UTXO Fetching (mempool.space API)
// =============================================================================

/** UTXO as returned by mempool.space API */
interface MempoolUtxo {
  txid: string;
  vout: number;
  status: {
    confirmed: boolean;
    block_height?: number;
  };
  value: number;
}

/**
 * Fetch UTXOs for an address from mempool.space API.
 */
export async function fetchUtxos(
  address: string,
  network: "mainnet" | "testnet" | "signet" = "testnet",
): Promise<UtxoDescriptor[]> {
  const baseUrl =
    network === "mainnet"
      ? "https://mempool.space/api"
      : network === "signet"
        ? "https://mempool.space/signet/api"
        : "https://mempool.space/testnet/api";

  // Fetch UTXOs
  const utxoRes = await fetch(`${baseUrl}/address/${address}/utxo`);
  if (!utxoRes.ok) {
    throw new Error(`Failed to fetch UTXOs: ${utxoRes.status} ${utxoRes.statusText}`);
  }
  const utxos: MempoolUtxo[] = await utxoRes.json();

  // We need scriptPubkey for each UTXO. Fetch from the tx details.
  // For efficiency, batch unique txids.
  const txidSet = new Set(utxos.map((u) => u.txid));
  const txCache = new Map<string, any>();

  await Promise.all(
    [...txidSet].map(async (txid) => {
      const txRes = await fetch(`${baseUrl}/tx/${txid}`);
      if (txRes.ok) {
        txCache.set(txid, await txRes.json());
      }
    }),
  );

  return utxos
    .filter((u) => u.status.confirmed) // Only confirmed UTXOs
    .map((u) => {
      const tx = txCache.get(u.txid);
      const output = tx?.vout?.[u.vout];
      const scriptPubkeyHex = output?.scriptpubkey ?? "";

      return {
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        scriptPubkeyHex,
      };
    })
    .filter((u) => u.scriptPubkeyHex.length > 0);
}

/**
 * Select UTXOs to cover the target amount + estimated fee.
 * Simple greedy algorithm: sort descending by value, take until covered.
 */
export function selectUtxos(
  utxos: UtxoDescriptor[],
  targetSats: number,
  feeRate: number,
): UtxoDescriptor[] {
  // Sort descending by value
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const selected: UtxoDescriptor[] = [];
  let total = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;

    // Estimate fee for current selection
    const fee = estimateDepositFee(selected.length, feeRate);
    if (total >= targetSats + fee) {
      return selected;
    }
  }

  // Not enough funds
  const fee = estimateDepositFee(selected.length, feeRate);
  if (total < targetSats + fee) {
    throw new Error(
      `Insufficient funds: have ${total} sats, need ${targetSats + fee} sats`,
    );
  }

  return selected;
}
