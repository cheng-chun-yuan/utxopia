"use client";

import {
  bytesToHex,
  createNonInteractiveDeposit,
  generateRandomAuthSignature,
  setupKeysFromAuthSignature,
} from "@utxopia/sdk";
import type { AuthSignatureKeyDerivationOptions } from "@utxopia/sdk";

const DEV_REGTEST_GROUP_PUBKEY = hexToBytes(
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
);

export interface SuiUtxopiaAuthPreview {
  signatureHex: string;
  rootHex: string;
  spendingPubKey: {
    x: string;
    y: string;
  };
  nullifierFingerprint: string;
  viewingPubKeyHex: string;
  encodedStealthAddress: string;
  directDeposit: {
    btcAddress: string;
    ephemeralPubHex: string;
    npkHex: string;
    opReturnHex: string;
  };
}

export async function createRandomSuiUtxopiaAuthPreview(
  options: AuthSignatureKeyDerivationOptions = {},
): Promise<SuiUtxopiaAuthPreview> {
  const signature = generateRandomAuthSignature();
  return createSuiUtxopiaAuthPreviewFromSignature(signature, options);
}

export async function createSuiUtxopiaAuthPreviewFromSignature(
  signature: Uint8Array,
  options: AuthSignatureKeyDerivationOptions = {},
): Promise<SuiUtxopiaAuthPreview> {
  const setup = setupKeysFromAuthSignature(signature, {
    chain: "sui",
    network: "sui-regtest",
    ...options,
  });
  const directDeposit = await createNonInteractiveDeposit(
    setup.stealthMetaAddress,
    DEV_REGTEST_GROUP_PUBKEY,
    "regtest",
  );

  return {
    signatureHex: bytesToHex(signature),
    rootHex: bytesToHex(setup.root),
    spendingPubKey: {
      x: setup.keys.spendingPubKey.x.toString(),
      y: setup.keys.spendingPubKey.y.toString(),
    },
    nullifierFingerprint: setup.keys.nullifyingKey.toString(16).slice(0, 16),
    viewingPubKeyHex: bytesToHex(setup.keys.viewingPubKey),
    encodedStealthAddress: setup.encodedStealthAddress,
    directDeposit: {
      btcAddress: directDeposit.btcAddress,
      ephemeralPubHex: bytesToHex(directDeposit.ephemeralPub),
      npkHex: bytesToHex(directDeposit.npk),
      opReturnHex: bytesToHex(directDeposit.opReturnPayload),
    },
  };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
