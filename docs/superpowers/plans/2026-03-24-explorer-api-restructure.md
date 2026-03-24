# Explorer API Restructure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure explorer API to return per-output arrays with typed outputs (commitment/unshield/withdraw) and align endpoint naming with explorer tabs (shield/transfer/unshield).

**Architecture:** Backend `/api/transfers` becomes the single source for all transaction data, returning a unified structure where each tx has typed `inputs[]` and `outputs[]` arrays. Frontend consolidates 3 separate hooks into one unified data model. Each output carries its own amount/fee/payout/recipient.

**Tech Stack:** Rust (backend storage + routes), TypeScript (Next.js API routes + React hooks + components)

---

## Target API Response Structure

All 3 tx types share the same top-level shape. Outputs are polymorphic by `type`:

```json
{
  "txSignature": "2xGwcP...",
  "type": "unshield",
  "tokenId": "251a91...",
  "tokenSymbol": "BTC",
  "timestamp": 1774366134,
  "status": "confirmed",
  "inputs": [
    { "nullifierHash": "240e3d...", "nullifierPda": "2b3mdU..." }
  ],
  "outputs": [
    {
      "type": "commitment",
      "commitment": "1a2b3c...",
      "leafIndex": 4
    },
    {
      "type": "unshield",
      "amount": 10976,
      "fee": 2021,
      "payout": 8955,
      "recipient": "3ni5KH..."
    },
    {
      "type": "withdraw",
      "amount": 10976,
      "fee": 2021,
      "payout": 8955,
      "recipient": "3ni5KH...",
      "requestId": "1774352660098",
      "btcScript": "0014..."
    }
  ]
}
```

**Shield transactions** have deposit-specific input fields:

```json
{
  "type": "shield",
  "inputs": [
    {
      "grossAmount": 24000,
      "fee": 2048,
      "netAmount": 21952,
      "btcDepositTxid": "65aa00...",
      "btcSweepTxid": "b9a622..."
    }
  ],
  "outputs": [
    { "type": "commitment", "commitment": "0e84f3...", "leafIndex": 0 }
  ]
}
```

**Private transfers** have no public amounts:

```json
{
  "type": "transfer",
  "inputs": [
    { "nullifierHash": "267a9a...", "nullifierPda": "..." }
  ],
  "outputs": [
    { "type": "commitment", "commitment": "185e7c...", "leafIndex": 4 },
    { "type": "commitment", "commitment": "0a2b3c...", "leafIndex": 5 }
  ]
}
```

---

## Task 1: Store per-output UnshieldMeta as JSON in backend

**Files:**
- Modify: `backend/src/event_indexer/service.rs` (build JSON from unshield_metas)
- Modify: `backend/src/event_indexer/storage.rs` (read `unshield_outputs` column in queries)

Currently the indexer matches `unshield_metas[i]` to `nullifiers[i]`, losing extra outputs when there are more metas than nullifiers (multi-output). Fix: serialize ALL metas as a JSON array on the first nullifier.

- [ ] **Step 1:** In `service.rs`, build `unshield_outputs_json` from `unshield_metas` before the nullifier loop

```rust
let outputs_json = if !unshield_metas.is_empty() {
    let arr: Vec<serde_json::Value> = unshield_metas.iter().map(|um| {
        serde_json::json!({
            "amount": um.amount,
            "fee": um.fee,
            "payout": um.payout,
            "recipient": bs58::encode(&um.recipient).into_string(),
        })
    }).collect();
    Some(serde_json::to_string(&arr).unwrap_or_default())
} else {
    None
};
```

- [ ] **Step 2:** Pass `outputs_json.as_deref()` to `insert_nullifier()` for each nullifier in the loop

- [ ] **Step 3:** Update `solana_ws.rs` caller to pass `None` for the new param

- [ ] **Step 4:** Update test in `storage.rs` to pass `None` for the new param

- [ ] **Step 5:** `cargo check` — compiles clean

---

## Task 2: Add `unshield_outputs` to backend transfer response

**Files:**
- Modify: `backend/src/event_indexer/routes.rs` (add field to `TransferItem`)
- Modify: `backend/src/event_indexer/storage.rs` (read column in `get_orphan_nullifier_transfers` + `enrich_with_nullifiers`)

- [ ] **Step 1:** Add `unshield_outputs` field to `TransferItem` struct

```rust
/// Per-output detail for multi-output unshield/withdraw (JSON array)
#[serde(skip_serializing_if = "Option::is_none")]
pub unshield_outputs: Option<Vec<serde_json::Value>>,
```

- [ ] **Step 2:** Add `unshield_outputs` to `TransferRow` struct

- [ ] **Step 3:** In `get_orphan_nullifier_transfers()`, read `unshield_outputs` column (index 14) and parse JSON

```rust
let uoutputs: Option<String> = row.get(14)?;
let unshield_outputs: Option<Vec<serde_json::Value>> = uoutputs
    .and_then(|s| serde_json::from_str(&s).ok());
```

- [ ] **Step 4:** Add `MAX(n.unshield_outputs) AS uoutputs` to the orphan query SQL

- [ ] **Step 5:** In `enrich_with_nullifiers()`, read `unshield_outputs` from the first nullifier row

- [ ] **Step 6:** Add the field to both `TransferRow` construction sites (orphan + enriched)

- [ ] **Step 7:** Map `TransferRow.unshield_outputs` → `TransferItem.unshield_outputs` in route handler

- [ ] **Step 8:** `cargo check` + `cargo test --lib` — all pass

---

## Task 3: Restructure frontend `/api/transfers` response

**Files:**
- Modify: `aegis-app/src/app/api/transfers/route.ts` (transform backend response to new structure)

The frontend API route transforms the flat backend response into the typed-output structure before sending to the client.

- [ ] **Step 1:** Define the new response types

```typescript
interface TxOutput {
  type: "commitment" | "unshield" | "withdraw";
  // commitment fields
  commitment?: string;
  leafIndex?: number;
  // unshield/withdraw fields
  amount?: number;
  fee?: number;
  payout?: number;
  recipient?: string;
  // withdraw-only fields
  requestId?: string;
  btcScript?: string;
}

interface TxInput {
  nullifierHash?: string;
  nullifierPda?: string;
  // shield-only
  grossAmount?: number;
  fee?: number;
  netAmount?: number;
  btcDepositTxid?: string;
  btcSweepTxid?: string;
}

interface ExplorerTransaction {
  txSignature: string;
  type: "shield" | "transfer" | "unshield" | "withdraw";
  tokenId: string | null;
  tokenSymbol: string | null;
  timestamp: number;
  status: string;
  inputs: TxInput[];
  outputs: TxOutput[];
}
```

- [ ] **Step 2:** Transform each backend `TransferItem` into `ExplorerTransaction`

For each transfer from backend:
- Map `nullifier_hashes[]` + `nullifier_pdas[]` → `inputs[]`
- Map `commitments[]` + `leaf_indices[]` → `outputs[]` with `type: "commitment"`
- If `unshield_outputs` array exists: append each as `type: "unshield"` or `type: "withdraw"` (based on `transfer_type`)
- Fall back to flat `unshield_amount/fee/payout/recipient` for single-output txs without the array

- [ ] **Step 3:** Resolve `token_symbol` server-side (already done, keep it)

- [ ] **Step 4:** Return new structure: `{ success, transactions, count }`

---

## Task 4: Restructure frontend `/api/explorer/deposits` response

**Files:**
- Modify: `aegis-app/src/app/api/explorer/deposits/route.ts` (transform to same structure)

- [ ] **Step 1:** Transform each deposit into `ExplorerTransaction` with `type: "shield"`

```typescript
{
  txSignature: dep.txSignature,
  type: "shield",
  tokenId: dep.tokenId,
  tokenSymbol: dep.tokenSymbol,
  timestamp: dep.timestamp,
  status: dep.status ?? "confirmed",
  inputs: [{
    grossAmount: dep.grossAmount,
    fee: dep.fee,
    netAmount: dep.amountSats,
    btcDepositTxid: dep.btcMeta?.depositTxid,
    btcSweepTxid: dep.btcMeta?.sweepTxid,
  }],
  outputs: [{
    type: "commitment",
    commitment: dep.commitment,
    leafIndex: dep.leafIndex,
  }],
}
```

- [ ] **Step 2:** Keep `btcMeta` as an extra field for BTC-specific deposit lifecycle (optional enrichment, not part of the core output structure)

- [ ] **Step 3:** Return `{ success, transactions, count }`

---

## Task 5: Merge redemptions into unshield transactions

**Files:**
- Modify: `aegis-app/src/app/api/explorer/redemptions/route.ts`
- OR: Remove this route and merge its logic into `/api/transfers`

Completed redemptions (with BTC txid) should enrich the withdraw outputs, not create separate entries.

- [ ] **Step 1:** In the transfers route, after building `ExplorerTransaction[]`, fetch redemption data from `/api/redemption/all`

- [ ] **Step 2:** For each `type: "withdraw"` output, match by `requestTxSignature` and enrich with:
  - `btcTxid` (from tracking)
  - `actualReceived` (from completion event)
  - `completeTxSignature`
  - `status` (Pending/Processing/Completed)

- [ ] **Step 3:** For completed redemptions NOT in transfers (PDA closed, data from events only), create standalone `ExplorerTransaction` entries with `type: "withdraw"`

- [ ] **Step 4:** Deduplicate: no more separate redemptions list in the unified view

---

## Task 6: Update frontend hooks

**Files:**
- Modify: `aegis-app/src/hooks/use-explorer.ts`

- [ ] **Step 1:** Define shared `ExplorerTransaction` type matching the API response

- [ ] **Step 2:** Update `useTransfers()` to parse new `inputs[]`/`outputs[]` structure

- [ ] **Step 3:** Update `useDeposits()` to parse new structure (or merge into `useTransfers` if deposits are also served from the same endpoint)

- [ ] **Step 4:** Keep `useRedemptions()` for now but simplify — it only needs to provide enrichment data for withdraw outputs, not standalone entries

---

## Task 7: Update explorer page + components

**Files:**
- Modify: `aegis-app/src/app/explorer/page.tsx` (unified list builder)
- Modify: `aegis-app/src/app/explorer/components/transfers-tab.tsx` (render outputs array)
- Modify: `aegis-app/src/app/explorer/components/deposits-tab.tsx` (render from new structure)

- [ ] **Step 1:** Unified list builder uses `ExplorerTransaction` directly — no more `getTransferKind()` heuristics, just read `tx.type`

- [ ] **Step 2:** `TransferRow` renders `tx.outputs.map()` — each output renders based on its `type`:
  - `commitment` → commitment hash + leaf index
  - `unshield` → amount → fee → payout + recipient
  - `withdraw` → amount → fee → payout + BTC script + request status

- [ ] **Step 3:** `DepositRow` renders from same `ExplorerTransaction` shape (inputs = deposit source, outputs = commitment)

- [ ] **Step 4:** Remove `WithdrawalRow` — withdraw outputs are rendered inline by `TransferRow`

- [ ] **Step 5:** Filter tabs work off `tx.type`: shield | transfer | unshield (withdraw is a sub-type of unshield)

---

## Task 8: Verify everything

- [ ] **Step 1:** `cargo test --lib` — all Rust tests pass
- [ ] **Step 2:** `bun run build` in aegis-app — TypeScript compiles
- [ ] **Step 3:** `./scripts/localnet-dev.sh` — full E2E + explorer verification
- [ ] **Step 4:** Check explorer: shields show deposit source + commitment output
- [ ] **Step 5:** Check explorer: unshields show per-output amount/fee/payout
- [ ] **Step 6:** Check explorer: multi-output unshield shows 2 outputs in array
- [ ] **Step 7:** Check explorer: withdraw shows fee + BTC status
- [ ] **Step 8:** Check explorer: private transfers show inputs + commitment outputs
