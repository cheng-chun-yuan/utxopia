import { PublicKey } from "@solana/web3.js";
import { PDA_SEEDS, getConfig } from "@utxopia/sdk";
import { getSolanaRpcUrl } from "@/lib/api/constants";

/** Derive nullifier PDA address (base58) from nullifier hash hex */
export function nullifierHashToPDA(hashHex: string): string {
  const clean = hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.NULLIFIER), bytes],
    new PublicKey(getConfig().privacyCoinProgramId)
  );
  return pda.toBase58();
}

// Module-level cache for incremental sync
const cache = { pdas: new Set<string>(), latestSlot: 0, total: 0 };

/** Fetch spent nullifier PDAs: backend primary, on-chain fallback */
export async function fetchSpentNullifierPDAs(backendUrl: string): Promise<Set<string>> {
  // Primary: backend incremental sync
  try {
    const since = cache.latestSlot > 0 ? `?since=${cache.latestSlot}` : "";
    const resp = await fetch(`${backendUrl}/api/nullifiers${since}`);
    const data = await resp.json();
    for (const pda of (data.pdas || [])) cache.pdas.add(pda);
    if (data.latest_slot > cache.latestSlot) cache.latestSlot = data.latest_slot;
    cache.total = data.total ?? cache.pdas.size;
    return cache.pdas;
  } catch {
    // Fallback: on-chain getProgramAccounts(dataSize: 1)
    try {
      const rpcUrl = getSolanaRpcUrl();
      const resp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getProgramAccounts",
          params: [
            getConfig().privacyCoinProgramId,
            { filters: [{ dataSize: 1 }], encoding: "base64" },
          ],
        }),
      });
      const result = await resp.json();
      return new Set(
        (result?.result || []).map((a: { pubkey: string }) => a.pubkey)
      );
    } catch {
      return cache.pdas; // return whatever we have cached
    }
  }
}
