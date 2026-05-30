import type { BitcoinTransaction, UtxopiaDepositOpReturn } from "./types";

export const UTXOPIA_DEPOSIT_OP_RETURN_SIZE = 64;

export function extractUtxopiaDepositOpReturn(
  tx: BitcoinTransaction | undefined,
): UtxopiaDepositOpReturn | undefined {
  if (!tx) {
    return undefined;
  }

  for (const output of tx.vout) {
    const payload = parseOpReturnPayload(output.scriptpubkey);
    if (payload?.length !== UTXOPIA_DEPOSIT_OP_RETURN_SIZE) {
      continue;
    }

    return {
      ephemeralPubkey: payload.slice(0, 32),
      npk: payload.slice(32, 64),
      rawPayload: payload,
    };
  }

  return undefined;
}

export function parseOpReturnPayload(scriptPubkeyHex: string): Uint8Array | undefined {
  const script = hexToBytes(scriptPubkeyHex);
  if (script.length < 2 || script[0] !== 0x6a) {
    return undefined;
  }

  const pushOpcode = script[1];
  if (pushOpcode > 0 && pushOpcode <= 75) {
    const end = 2 + pushOpcode;
    return end === script.length ? script.slice(2, end) : undefined;
  }

  if (pushOpcode === 0x4c && script.length >= 3) {
    const len = script[2];
    const end = 3 + len;
    return end === script.length ? script.slice(3, end) : undefined;
  }

  return undefined;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

