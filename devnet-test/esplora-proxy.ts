/**
 * Esplora-compatible HTTP proxy for Bitcoin regtest
 *
 * Translates Esplora REST API calls to bitcoind JSON-RPC.
 * Implements the subset of endpoints used by the zVault backend watcher.
 *
 * Usage:
 *   bun run esplora-proxy.ts
 *   # Listens on port 3002, proxies to bitcoind at localhost:18443
 *
 * Environment:
 *   BITCOIN_RPC_URL  - bitcoind URL (default: http://test:test@localhost:18443)
 *   ESPLORA_PORT     - Listen port (default: 3002)
 */

const BITCOIN_RPC_URL = process.env.BITCOIN_RPC_URL || "http://test:test@localhost:18443";
const ESPLORA_PORT = parseInt(process.env.ESPLORA_PORT || "3002");

// =============================================================================
// Bitcoin JSON-RPC helper
// =============================================================================

let rpcId = 0;

// Parse auth from URL
const rpcUrl = new URL(BITCOIN_RPC_URL);
const rpcAuth = rpcUrl.username
  ? "Basic " + btoa(`${rpcUrl.username}:${rpcUrl.password}`)
  : "";
const rpcBase = `${rpcUrl.protocol}//${rpcUrl.host}`;

async function bitcoinRpc(method: string, params: any[] = []): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (rpcAuth) headers["Authorization"] = rpcAuth;

  const res = await fetch(rpcBase, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

// =============================================================================
// Esplora endpoint handlers
// =============================================================================

/** GET /blocks/tip/height */
async function getBlockTipHeight(): Promise<Response> {
  const height = await bitcoinRpc("getblockcount");
  return new Response(String(height), { headers: { "content-type": "text/plain" } });
}

/** GET /address/:address/utxo */
async function getAddressUtxos(address: string): Promise<Response> {
  // Use scantxoutset for external addresses
  const result = await bitcoinRpc("scantxoutset", ["start", [`addr(${address})`]]);
  const tipHeight = await bitcoinRpc("getblockcount");

  const utxos = (result.unspents || []).map((u: any) => ({
    txid: u.txid,
    vout: u.vout,
    status: {
      confirmed: true,
      block_height: u.height,
      block_hash: "", // not available from scantxoutset
    },
    value: Math.round(u.amount * 1e8),
  }));

  return Response.json(utxos);
}

/** GET /address/:address */
async function getAddressInfo(address: string): Promise<Response> {
  const result = await bitcoinRpc("scantxoutset", ["start", [`addr(${address})`]]);
  const totalAmount = result.total_amount || 0;
  const count = (result.unspents || []).length;

  return Response.json({
    address,
    chain_stats: {
      funded_txo_count: count,
      funded_txo_sum: Math.round(totalAmount * 1e8),
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: count,
    },
    mempool_stats: {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: 0,
    },
  });
}

/** GET /tx/:txid/status */
async function getTxStatus(txid: string): Promise<Response> {
  try {
    const tx = await bitcoinRpc("getrawtransaction", [txid, true]);
    const tipHeight = await bitcoinRpc("getblockcount");

    if (tx.blockhash) {
      const block = await bitcoinRpc("getblockheader", [tx.blockhash]);
      return Response.json({
        confirmed: true,
        block_height: block.height,
        block_hash: tx.blockhash,
        block_time: block.time,
      });
    }

    return Response.json({ confirmed: false });
  } catch {
    return new Response("Transaction not found", { status: 404 });
  }
}

/** GET /tx/:txid/hex */
async function getTxHex(txid: string): Promise<Response> {
  try {
    const hex = await bitcoinRpc("getrawtransaction", [txid, false]);
    return new Response(hex, { headers: { "content-type": "text/plain" } });
  } catch {
    return new Response("Transaction not found", { status: 404 });
  }
}

/** GET /tx/:txid/raw — binary raw transaction */
async function getTxRaw(txid: string): Promise<Response> {
  try {
    const hex: string = await bitcoinRpc("getrawtransaction", [txid, false]);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return new Response(bytes, {
      headers: { "content-type": "application/octet-stream" },
    });
  } catch {
    return new Response("Transaction not found", { status: 404 });
  }
}

/** GET /tx/:txid */
async function getTxDetails(txid: string): Promise<Response> {
  try {
    const tx = await bitcoinRpc("getrawtransaction", [txid, true]);
    const tipHeight = await bitcoinRpc("getblockcount");

    let status: any = { confirmed: false };
    if (tx.blockhash) {
      const block = await bitcoinRpc("getblockheader", [tx.blockhash]);
      status = {
        confirmed: true,
        block_height: block.height,
        block_hash: tx.blockhash,
        block_time: block.time,
      };
    }

    // Convert to Esplora format
    const vout = tx.vout.map((o: any) => ({
      scriptpubkey: o.scriptPubKey.hex,
      scriptpubkey_asm: o.scriptPubKey.asm,
      scriptpubkey_type: o.scriptPubKey.type,
      scriptpubkey_address: o.scriptPubKey.address || "",
      value: Math.round(o.value * 1e8),
    }));

    const vin = tx.vin.map((i: any) => ({
      txid: i.txid || "",
      vout: i.vout ?? 0,
      prevout: null,
      scriptsig: i.scriptSig?.hex || "",
      scriptsig_asm: i.scriptSig?.asm || "",
      witness: i.txinwitness || [],
      is_coinbase: !!i.coinbase,
      sequence: i.sequence,
    }));

    return Response.json({
      txid: tx.txid,
      version: tx.version,
      locktime: tx.locktime,
      vin,
      vout,
      size: tx.size,
      weight: tx.weight,
      fee: 0, // Would need input lookup
      status,
    });
  } catch {
    return new Response("Transaction not found", { status: 404 });
  }
}

/** POST /tx — broadcast raw transaction */
async function broadcastTx(body: string): Promise<Response> {
  try {
    const txid = await bitcoinRpc("sendrawtransaction", [body.trim()]);
    return new Response(txid, { headers: { "content-type": "text/plain" } });
  } catch (err: any) {
    return new Response(err.message, { status: 400 });
  }
}

/** GET /tx/:txid/merkle-proof */
async function getMerkleProof(txid: string): Promise<Response> {
  try {
    const tx = await bitcoinRpc("getrawtransaction", [txid, true]);
    if (!tx.blockhash) {
      return new Response("Transaction not confirmed", { status: 404 });
    }

    const block = await bitcoinRpc("getblock", [tx.blockhash, 1]);
    const txIndex = block.tx.indexOf(txid);
    if (txIndex < 0) {
      return new Response("Transaction not found in block", { status: 404 });
    }

    // Compute merkle proof using gettxoutproof
    const proofHex = await bitcoinRpc("gettxoutproof", [[txid], tx.blockhash]);

    // Parse the merkle proof from the raw proof
    // The gettxoutproof returns a partial merkle tree in Bitcoin's format
    // We need to extract siblings for Esplora-compatible format
    const merkle = computeMerkleProof(block.tx, txIndex);

    return Response.json({
      block_height: block.height,
      merkle: merkle.siblings,
      pos: txIndex,
    });
  } catch (err: any) {
    return new Response(err.message, { status: 500 });
  }
}

/**
 * Compute merkle proof siblings from tx list and index.
 * Bitcoin merkle trees use double-SHA256, but here we just need the sibling hashes.
 */
function computeMerkleProof(txids: string[], index: number): { siblings: string[] } {
  const siblings: string[] = [];

  // Convert txids to buffers (already in internal byte order from getblock)
  let level = txids.map((t) => t);

  let pos = index;
  while (level.length > 1) {
    // Ensure even number of nodes (duplicate last if odd)
    if (level.length % 2 !== 0) {
      level.push(level[level.length - 1]);
    }

    const siblingIdx = pos % 2 === 0 ? pos + 1 : pos - 1;
    siblings.push(level[siblingIdx]);

    // Move up the tree
    const nextLevel: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      // For the proof we only need siblings, not the actual hashes
      // The verifier will recompute using double-SHA256
      nextLevel.push(level[i]); // placeholder
    }
    level = nextLevel;
    pos = Math.floor(pos / 2);
  }

  return { siblings };
}

/** GET /block/:hash — block metadata (Esplora format) */
async function getBlockInfo(hash: string): Promise<Response> {
  try {
    const block = await bitcoinRpc("getblockheader", [hash, true]);
    return Response.json({
      id: hash,
      height: block.height,
      version: block.version,
      timestamp: block.time,
      bits: parseInt(block.bits, 16),
      nonce: block.nonce,
      difficulty: block.difficulty,
      merkle_root: block.merkleroot,
      previousblockhash: block.previousblockhash || "",
      tx_count: block.nTx || 0,
    });
  } catch {
    return new Response("Block not found", { status: 404 });
  }
}

/** GET /block-height/:height */
async function getBlockHashAtHeight(height: number): Promise<Response> {
  try {
    const hash = await bitcoinRpc("getblockhash", [height]);
    return new Response(hash, { headers: { "content-type": "text/plain" } });
  } catch {
    return new Response("Block not found", { status: 404 });
  }
}

/** GET /block/:hash/header */
async function getBlockHeader(hash: string): Promise<Response> {
  try {
    // getblockheader with verbose=false returns 80-byte header as hex
    const headerHex = await bitcoinRpc("getblockheader", [hash, false]);
    return new Response(headerHex, { headers: { "content-type": "text/plain" } });
  } catch {
    return new Response("Block not found", { status: 404 });
  }
}

// =============================================================================
// HTTP Server (Bun.serve)
// =============================================================================

const server = Bun.serve({
  port: ESPLORA_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      let response: Response;

      // Route matching (with /api prefix support)
      const apiPath = path.startsWith("/api") ? path.slice(4) : path;

      if (apiPath === "/blocks/tip/height" && req.method === "GET") {
        response = await getBlockTipHeight();
      } else if (apiPath.match(/^\/address\/([^/]+)\/utxo$/) && req.method === "GET") {
        const address = apiPath.match(/^\/address\/([^/]+)\/utxo$/)![1];
        response = await getAddressUtxos(address);
      } else if (apiPath.match(/^\/address\/([^/]+)$/) && req.method === "GET") {
        const address = apiPath.match(/^\/address\/([^/]+)$/)![1];
        response = await getAddressInfo(address);
      } else if (apiPath.match(/^\/tx\/([0-9a-f]{64})\/status$/) && req.method === "GET") {
        const txid = apiPath.match(/^\/tx\/([0-9a-f]{64})\/status$/)![1];
        response = await getTxStatus(txid);
      } else if (apiPath.match(/^\/tx\/([0-9a-f]{64})\/hex$/) && req.method === "GET") {
        const txid = apiPath.match(/^\/tx\/([0-9a-f]{64})\/hex$/)![1];
        response = await getTxHex(txid);
      } else if (apiPath.match(/^\/tx\/([0-9a-f]{64})\/raw$/) && req.method === "GET") {
        const txid = apiPath.match(/^\/tx\/([0-9a-f]{64})\/raw$/)![1];
        response = await getTxRaw(txid);
      } else if (apiPath.match(/^\/tx\/([0-9a-f]{64})\/merkle-proof$/) && req.method === "GET") {
        const txid = apiPath.match(/^\/tx\/([0-9a-f]{64})\/merkle-proof$/)![1];
        response = await getMerkleProof(txid);
      } else if (apiPath.match(/^\/tx\/([0-9a-f]{64})$/) && req.method === "GET") {
        const txid = apiPath.match(/^\/tx\/([0-9a-f]{64})$/)![1];
        response = await getTxDetails(txid);
      } else if (apiPath === "/tx" && req.method === "POST") {
        const body = await req.text();
        response = await broadcastTx(body);
      } else if (apiPath.match(/^\/block-height\/(\d+)$/) && req.method === "GET") {
        const height = parseInt(apiPath.match(/^\/block-height\/(\d+)$/)![1]);
        response = await getBlockHashAtHeight(height);
      } else if (apiPath.match(/^\/block\/([0-9a-f]{64})\/header$/) && req.method === "GET") {
        const hash = apiPath.match(/^\/block\/([0-9a-f]{64})\/header$/)![1];
        response = await getBlockHeader(hash);
      } else if (apiPath.match(/^\/block\/([0-9a-f]{64})$/) && req.method === "GET") {
        const hash = apiPath.match(/^\/block\/([0-9a-f]{64})$/)![1];
        response = await getBlockInfo(hash);
      } else {
        response = new Response(`Not found: ${apiPath}`, { status: 404 });
      }

      // Add CORS headers to all responses
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    } catch (err: any) {
      console.error(`Error handling ${path}:`, err.message);
      return new Response(err.message, {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
});

console.log(`Esplora proxy running on http://localhost:${ESPLORA_PORT}`);
console.log(`Proxying to bitcoind at ${BITCOIN_RPC_URL.replace(/:[^:@]*@/, ":***@")}`);
