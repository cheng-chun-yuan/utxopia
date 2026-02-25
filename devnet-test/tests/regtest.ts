/**
 * Bitcoin Regtest Helpers
 *
 * Provides JSON-RPC wrappers for a local bitcoind regtest node.
 * Used when TEST_MODE=local to fund deposit addresses and mine blocks instantly.
 */

const BITCOIN_RPC_URL =
  process.env.BITCOIN_RPC_URL || "http://test:test@localhost:18443";

// ---------------------------------------------------------------------------
// Low-level JSON-RPC
// ---------------------------------------------------------------------------

let rpcIdCounter = 0;

export async function bitcoinRpc<T = any>(
  method: string,
  params: any[] = []
): Promise<T> {
  const id = ++rpcIdCounter;

  // Parse auth from URL if present (http://user:pass@host:port)
  const url = new URL(BITCOIN_RPC_URL);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (url.username) {
    const auth = Buffer.from(`${url.username}:${url.password}`).toString(
      "base64"
    );
    headers["Authorization"] = `Basic ${auth}`;
    // Strip credentials from URL for fetch
    url.username = "";
    url.password = "";
  }

  const res = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`bitcoind RPC HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`bitcoind RPC error: ${JSON.stringify(json.error)}`);
  }
  return json.result as T;
}

// ---------------------------------------------------------------------------
// Wallet management
// ---------------------------------------------------------------------------

const DEFAULT_WALLET = "testwallet";

/**
 * Create or load a wallet. Idempotent — silently succeeds if already loaded.
 */
export async function createWallet(
  name: string = DEFAULT_WALLET
): Promise<void> {
  try {
    await bitcoinRpc("createwallet", [name]);
  } catch (err: any) {
    // Already exists — try loading it
    if (err.message?.includes("Database already exists")) {
      try {
        await bitcoinRpc("loadwallet", [name]);
      } catch {
        // Already loaded — fine
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

/**
 * Mine `n` blocks. If no address is given, mines to the wallet's own address.
 */
export async function mineBlocks(
  n: number,
  address?: string
): Promise<string[]> {
  if (!address) {
    address = await bitcoinRpc<string>("getnewaddress", [
      "",
      "bech32m",
    ]);
  }
  return bitcoinRpc<string[]>("generatetoaddress", [n, address]);
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

/**
 * Send `btcAmount` BTC to `address`, then mine 1 block to confirm.
 * Returns the txid of the funding transaction.
 */
export async function fundAddress(
  address: string,
  btcAmount: number
): Promise<string> {
  const txid = await bitcoinRpc<string>("sendtoaddress", [address, btcAmount]);
  await mineBlocks(1);
  return txid;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface ListUnspentEntry {
  txid: string;
  vout: number;
  address: string;
  amount: number;
  confirmations: number;
}

/**
 * Get the total confirmed balance for a specific address.
 * Uses scantxoutset to find UTXOs for any address (not just wallet-owned).
 */
export async function getAddressBalance(address: string): Promise<number> {
  const result = await bitcoinRpc<{ total_amount: number }>("scantxoutset", [
    "start",
    [`addr(${address})`],
  ]);
  return result.total_amount;
}

/**
 * Get wallet balance (total).
 */
export async function getWalletBalance(): Promise<number> {
  return bitcoinRpc<number>("getbalance");
}

/**
 * Get current block height.
 */
export async function getBlockCount(): Promise<number> {
  return bitcoinRpc<number>("getblockcount");
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Check if the regtest bitcoind node is reachable and on regtest.
 */
export async function isRegtestAvailable(): Promise<boolean> {
  try {
    const info = await bitcoinRpc<{ chain: string }>("getblockchaininfo");
    return info.chain === "regtest";
  } catch {
    return false;
  }
}

/**
 * One-time bootstrap: create wallet and mine 101 blocks so coinbase is spendable.
 */
export async function bootstrapRegtest(): Promise<void> {
  await createWallet();
  const height = await getBlockCount();
  if (height < 101) {
    console.log(`  Regtest height=${height}, mining to 101 for spendable coinbase...`);
    await mineBlocks(101 - height);
  }
}
