import { Keypair } from "@solana/web3.js";

/**
 * Load the relayer keypair from the RELAYER_KEYPAIR environment variable.
 * Returns null if the env var is missing or malformed.
 */
export function getRelayerKeypair(): Keypair | null {
  const keypairJson = process.env.RELAYER_KEYPAIR;
  if (!keypairJson) {
    return null;
  }
  try {
    const secretKey = JSON.parse(keypairJson);
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch {
    return null;
  }
}
