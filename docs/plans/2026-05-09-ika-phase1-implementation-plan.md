# Phase 1 — Ika dWallet Custody Replacing FROST: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Subagents in this project are plan-only; the main agent executes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the entire FROST custody subsystem with Ika dWallet-controlled BTC custody. By the end of this plan, BTC deposits land at an Ika-controlled P2TR address; redemptions are signed by Ika; `frost_server/` is decommissioned behind a feature flag, then deleted.

**Architecture:** The on-chain `privacy-coin` Pinocchio program adds the `ika-dwallet-pinocchio` git dep and CPIs `DWalletContext::approve_message(...)` from `complete_redemption`. The Ika devnet program (`87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY`) creates a `MessageApproval` PDA on our behalf; its mock signer (pre-alpha) populates a `Sign` account with the resulting signature. A thin off-chain watcher polls `Sign` PDAs, assembles the BTC witness, and broadcasts to Bitcoin testnet. **No Sui sidecar, no Node IPC bridge** — that earlier plan version was wrong (built against `@ika.xyz/sdk` which is Sui-only; the right tooling is `dwallet-labs/ika-pre-alpha` which is Solana-native).

**Tech stack:** Rust (Pinocchio program with `ika-dwallet-pinocchio` git dep, backend watcher), TypeScript (`@privacy-coin/sdk`, web), Bitcoin (testnet, P2TR), Solana devnet, Ika devnet (gRPC `pre-alpha-dev-1.ika.ika-network.net:443`).

**Phase 1 acceptance:** End-to-end test passes — deposit BTC to an Ika-controlled P2TR → SPV-verify on Solana → see shielded note in SDK → transfer privately → request redemption → Ika signs the BTC tx → BTC arrives at withdrawal address. No `frost_server/` process running. Phase 2 (Encrypt swap) is a separate plan written after this one ships.

---

## File-Structure Map

Locked-in changes. Each file has one clear responsibility.

| File | Status | Responsibility |
|---|---|---|
| `docs/recon/2026-05-09-ika-sdk-brief.md` | **NEW** | Output of Task 0. Concrete `ika-dwallet-pinocchio` CPI call signatures, `DWallet` and `Sign` PDA layouts, devnet endpoints. Used by every later task. |
| `scripts/ika-setup/Cargo.toml` | **NEW** | Standalone Rust workspace member that runs the one-shot dWallet DKG against Ika devnet. |
| `scripts/ika-setup/src/main.rs` | **NEW** | Creates SECP256K1 dWallet via Ika devnet, transfers authority to Privacy Coin CPI authority PDA, prints dWallet ID + pubkey, writes them into the appropriate state JSON. |
| `contracts/programs/privacy-coin/Cargo.toml` | **MODIFY** | Add `ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha", rev = "<pinned>" }`. |
| `contracts/programs/privacy-coin/src/state/pool_config.rs` | **MODIFY** | Add `ika_dwallet: [u8; 32]` (the Solana account holding the dWallet) and `ika_dwallet_pubkey: [u8; 33]` (compressed secp256k1) fields. Keep `group_pub_key` for migration. |
| `contracts/programs/privacy-coin/src/instructions/set_pool_config.rs` | **MODIFY** | Allow setting `ika_dwallet` and `ika_dwallet_pubkey`. |
| `contracts/programs/privacy-coin/src/instructions/complete_redemption.rs` | **MODIFY** | After existing redemption validation, build BTC tx → compute taproot sighash → CPI `DWalletContext::approve_message(...)` to create `MessageApproval` PDA. Adds new accounts: ika_program, coordinator, message_approval, dwallet, cpi_authority, payer. |
| `contracts/programs/privacy-coin/src/cpi/ika.rs` | **NEW** | Thin wrapper around `DWalletContext::approve_message` with our specific account layout. CPI authority bump is computed once and stored in `pool_config`. |
| `contracts/programs/privacy-coin/src/utils/policy.rs` | **NEW** | Migrated from `frost_server/policy.rs`. Pure on-chain validation: amount limits, destination whitelist, paused-state. Called from `complete_redemption` before the CPI. |
| `backend/src/bitcoin/ika_watcher.rs` | **NEW** | Thin off-chain watcher: polls Ika `Sign` PDAs (gRPC + Solana RPC) for completed signatures matching pending redemptions. Assembles witness onto unsigned BTC tx, broadcasts to bitcoind. |
| `backend/src/redemption/signer.rs` | **MODIFY** | Add `IkaSigner` enum variant — much thinner than FROST: no MPC orchestration, just sighash computation + handing off the sighash to the on-chain `complete_redemption` ix. The actual signature comes back through the watcher. Existing `SingleKeySigner` stays for tests. `FrostSigner` gated behind `frost-legacy` feature. |
| `backend/src/redemption/types.rs` | **MODIFY** | Add `Ika { dwallet: [u8; 32], dwallet_pubkey: [u8; 33] }` variant to `SigningMode`. |
| `backend/src/redemption/service.rs` | **MODIFY** | Wire `Ika` variant: `complete_redemption` ix now includes the Ika accounts; the watcher reads back the sig. |
| `sdk/src/bitcoin/ika.ts` | **NEW** | `deriveCustodyAddressFromIkaDWallet(pubkey, network)` → P2TR. Pure synchronous helper from a 33-byte compressed pubkey. |
| `sdk/src/stealth-deposit.ts` | **MODIFY** | `createNonInteractiveDeposit` reads `pool_config.ika_dwallet_pubkey` and uses the new helper; falls back to `group_pub_key`-derived address only if `ika_dwallet_pubkey` is zero (legacy pools). |
| `web/src/lib/networks.json` | **MODIFY** | Add `ikaProgram` (Ika devnet program ID `87W54k...`), `ikaDwallet`, `ikaDwalletPubkey`, `ikaGrpcEndpoint`. Generated by `sync-env.sh`. |
| `scripts/sync-env.sh` | **MODIFY** | Read new ika.* fields from state JSON. |
| `scripts/e2e/localnet-state.json` | **MODIFY** | Add `ika.program`, `ika.dwallet`, `ika.dwalletPubkey`, `ika.grpcEndpoint`. |
| `scripts/devnet-state.json` | **MODIFY** | Same fields for devnet. |
| `frost_server/` | **DELETE** | After Task 8 acceptance. Until then, kept compilable behind the `frost-legacy` feature flag for fallback. |
| `docker-compose.regtest.yml` | **MODIFY** | Remove FROST signer services. Ika watcher runs in the existing backend process — no new container needed. |
| `README.md` | **MODIFY** | Architecture diagram + custody story. |
| `docs/TECHNICAL.md` | **MODIFY** | Replace FROST section with Ika section. |
| `docs/MIGRATION_v1_to_v2.md` | **NEW** | One-page migration guide. |

---

## Pre-flight check

- [ ] **Step P.1: Confirm clean working tree on `ika` branch**

```bash
git status
git branch --show-current
```

Expected: `nothing to commit, working tree clean` and `ika`.

- [ ] **Step P.2: Confirm baseline tests pass**

```bash
cd contracts && cargo test --quiet 2>&1 | tail -5
cd ../sdk && bun test 2>&1 | tail -5
cd ../backend && cargo test --quiet 2>&1 | tail -5
```

Expected: all three suites green. If anything is red on `main`/`ika` head, **stop** — fix before pivoting. Don't pile new failures on existing ones.

---

## Task 0 — Recon spike (≤4h, blocking gate for everything else)

**Why this exists:** Solana-native Ika is pre-alpha (`dwallet-labs/ika-pre-alpha`). We need to *prove* (1) the `ika-dwallet-pinocchio` CPI compiles and works against a local validator, (2) we can run their DKG flow against Ika devnet to produce a real SECP256K1 dWallet, and (3) the resulting `Sign` PDA returns a verifiable signature. Without these, the integration is fiction.

**Files:**
- Create: `docs/recon/2026-05-09-ika-sdk-brief.md`
- (Working scratch dir: `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/` — already cloned)

**Hard cut:** if Task 0 doesn't produce a verified Ika-signed message within 4 hours, **escalate to user**. Options at that point: (a) ship Phase 1 with `SingleKeySigner` mode and document the Ika integration as architectural-only, (b) defer pivot and ship FROST-with-better-UX.

- [ ] **Step 0.1: Confirm the scratch repo is up to date**

```bash
cd /tmp/ika-pre-alpha-scratch/ika-pre-alpha
git log --oneline -5
git rev-parse HEAD
```

Record the HEAD SHA — Step 0.5 pins this commit in our `Cargo.toml` git dep.

- [ ] **Step 0.2: Build the Ika repo's voting example to confirm the CPI surface compiles**

```bash
cd /tmp/ika-pre-alpha-scratch/ika-pre-alpha
cargo build --workspace 2>&1 | tail -10
```

Expected: builds clean. If it doesn't on this Rust toolchain, switch to `rust-toolchain.toml`'s pinned version (the repo includes one).

- [ ] **Step 0.3: Run the Pinocchio voting example tests (LiteSVM/Mollusk)**

```bash
cd /tmp/ika-pre-alpha-scratch/ika-pre-alpha/chains/solana/examples/voting/pinocchio
cargo test --features test-default 2>&1 | tail -20
```

(Fall back to `cargo test` without features if the feature gate isn't there.) Expected: tests pass — proves the `approve_message` CPI works end-to-end in a local SVM. If they don't pass, capture the error and **escalate**.

- [ ] **Step 0.4: Hit Ika devnet directly via their gRPC client to confirm reachability**

```bash
cd /tmp/ika-pre-alpha-scratch/ika-pre-alpha
# Find the gRPC client or DKG example in chains/solana/clients/ or scripts/
ls chains/solana/clients/ chains/solana/sdk/ scripts/ 2>/dev/null
grep -rn "pre-alpha-dev-1.ika.ika-network.net" --include="*.rs" --include="*.toml" --include="*.md" . 2>/dev/null | head -10
```

Read the relevant entrypoint, then run whatever the repo's `justfile` lists for "create dWallet on devnet" (e.g., `just dkg-devnet` or `cargo run --bin ika-dkg`). Capture the dWallet ID and pubkey it returns — this becomes the demo dWallet.

If the devnet gRPC is unreachable, **escalate** — don't fake artifacts.

- [ ] **Step 0.5: Write the recon brief**

Create `docs/recon/2026-05-09-ika-sdk-brief.md`:

```markdown
# Ika Solana Pre-Alpha Recon Brief — 2026-05-09

## Confirmed
- Repo: `dwallet-labs/ika-pre-alpha` @ commit <SHA from Step 0.1>
- Devnet program ID: 87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY
- Devnet gRPC: pre-alpha-dev-1.ika.ika-network.net:443
- Pinocchio crate path: `chains/solana/program-sdk/pinocchio/` (`ika-dwallet-pinocchio`)
- Cargo dep:
  ```toml
  ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha", rev = "<SHA>" }
  ```

## CPI surface used (DWalletContext::approve_message)
- Discriminator: 8
- Accounts in order: coordinator (ro), message_approval (w), dwallet (ro), caller_program (ro+exec), cpi_authority (ro+signer PDA), payer (w+signer), system_program (ro)
- CPI authority PDA seed: `b"__ika_cpi_authority"` (from `CPI_AUTHORITY_SEED`)
- Instruction data: [u8 disc, u8 bump, [u8;32] msg_digest, [u8;32] msg_metadata_digest, [u8;32] user_pubkey, u16 sig_scheme] = 100 bytes
- Signature scheme value for ECDSA secp256k1: <observed from chains/solana/sdk/types or chains/solana/idl>

## DKG flow (one-shot, pre-deployment)
- Run via: <exact command from justfile, e.g. `just dkg-devnet`>
- Produces:
  - dWallet account address (Solana account, owned by Ika program)
  - Compressed secp256k1 pubkey (33 bytes)
  - Authority initially set to creator; we transfer to our CPI authority PDA via `transfer_dwallet` (discriminator 24)
- Latency observed: <seconds>

## Sign session readback
- After approve_message, Ika program creates a Sign PDA (or analogous account)
- Watcher reads: <exact PDA seed and account layout, from chains/solana/sdk/types>
- Pre-alpha mock signer fills the result within: <observed seconds>
- Output is a 64-byte ECDSA signature for secp256k1

## Voting example tests
- `chains/solana/examples/voting/pinocchio/tests/litesvm.rs` — passes locally: yes/no
- `chains/solana/examples/voting/pinocchio/tests/mollusk.rs` — passes locally: yes/no

## Gotchas (one-liners)
- <captured during recon>

## Reproducible artifacts
- Voting example tests: `cd /tmp/ika-pre-alpha-scratch/ika-pre-alpha/chains/solana/examples/voting/pinocchio && cargo test`
- Devnet DKG: <exact command>
```

- [ ] **Step 0.6: Commit the recon brief**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin
git add docs/recon/
git commit -m "Task 0: Ika Solana pre-alpha recon (CPI surface, DKG flow, Sign PDA layout)"
```

**Gate:** every later task references `docs/recon/2026-05-09-ika-sdk-brief.md`. If a value isn't in the brief, halt and recon it before proceeding.

---

## Task 1 — Add Ika dWallet ID to on-chain pool config

**Files:**
- Modify: `contracts/programs/privacy-coin/src/state/pool_config.rs`
- Modify: `contracts/programs/privacy-coin/src/instructions/set_pool_config.rs`
- Test: `contracts/programs/privacy-coin/tests/pool_config_ika.rs` (new)

- [ ] **Step 1.1: Read existing pool_config.rs to anchor the change**

```bash
sed -n '1,80p' contracts/programs/privacy-coin/src/state/pool_config.rs
```

Capture: current struct layout, byte offsets, existing `group_pub_key` location.

- [ ] **Step 1.2: Write a failing test for the new field**

Create `contracts/programs/privacy-coin/tests/pool_config_ika.rs`:

```rust
use privacy_coin::state::pool_config::PoolConfig;

#[test]
fn pool_config_round_trips_ika_dwallet_id() {
    let mut bytes = vec![0u8; PoolConfig::LEN];
    let pc = PoolConfig::try_from_bytes_mut(&mut bytes).unwrap();
    let dwallet_id = [7u8; 32];
    pc.ika_dwallet_id.copy_from_slice(&dwallet_id);
    let bytes_clone = bytes.clone();
    let pc_read = PoolConfig::try_from_bytes(&bytes_clone).unwrap();
    assert_eq!(pc_read.ika_dwallet_id, dwallet_id);
    assert_eq!(pc_read.group_pub_key, [0u8; 32]);
}
```

- [ ] **Step 1.3: Run the test, confirm it fails**

```bash
cd contracts && cargo test -p privacy-coin pool_config_round_trips_ika_dwallet_id 2>&1 | tail -10
```

Expected: failure (`ika_dwallet_id` field does not exist yet).

- [ ] **Step 1.4: Add the field**

In `pool_config.rs`, add `pub ika_dwallet_id: [u8; 32]` as the next field after `group_pub_key`. Update `PoolConfig::LEN` by `+32`. Update any existing `try_from_bytes`/`try_from_bytes_mut` byte-slice indexing accordingly.

Verify by re-reading the file:

```bash
grep -n "ika_dwallet_id\|LEN\|group_pub_key" contracts/programs/privacy-coin/src/state/pool_config.rs
```

Expected: field present, `LEN` increased by 32.

- [ ] **Step 1.5: Run the test, confirm it passes**

```bash
cd contracts && cargo test -p privacy-coin pool_config_round_trips_ika_dwallet_id 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 1.6: Run the full program test suite**

```bash
cd contracts && cargo test -p privacy-coin 2>&1 | tail -15
```

Expected: all green. If a serialization-size test fails, update it to the new `PoolConfig::LEN`.

- [ ] **Step 1.7: Allow setting ika_dwallet_id in `set_pool_config`**

Modify `contracts/programs/privacy-coin/src/instructions/set_pool_config.rs` to accept an optional 32-byte `ika_dwallet_id` argument (analogous to the existing optional `group_pub_key` handling). Reference the existing `group_pub_key` pattern — same length, same optionality, same authority check.

- [ ] **Step 1.8: Add a test for `set_pool_config` with ika_dwallet_id**

Add a unit test in the same `tests/` file that constructs a `set_pool_config` instruction with the new field and confirms it round-trips into the PDA. Use the existing `set_pool_config` tests as a template (search `grep -rn "set_pool_config" contracts/programs/privacy-coin/tests/`).

- [ ] **Step 1.9: cargo build-sbf passes**

```bash
cd contracts && cargo build-sbf --features localnet 2>&1 | tail -10
```

Expected: `Finished`.

- [ ] **Step 1.10: Commit**

```bash
git add contracts/
git commit -m "Task 1: add ika_dwallet_id to PoolConfig + set_pool_config"
```

---

## Task 2 — SDK helper: derive BTC P2TR address from Ika dWallet ID

**Files:**
- Create: `sdk/src/bitcoin/ika.ts`
- Create: `sdk/tests/bitcoin/ika.test.ts`
- Modify: `sdk/src/bitcoin/index.ts` (re-export)

The actual Ika SDK call signatures come from `docs/recon/2026-05-09-ika-sdk-brief.md`. Use whatever the brief documents — do not invent.

- [ ] **Step 2.1: Write a failing test**

Create `sdk/tests/bitcoin/ika.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { deriveCustodyAddressFromIkaDWallet } from "../../src/bitcoin/ika";

describe("deriveCustodyAddressFromIkaDWallet", () => {
  it("returns a P2TR bech32m address from a 33-byte compressed pubkey", () => {
    // Use a fixed test vector — pubkey is the secp256k1 generator point compressed.
    const pubkey = Buffer.from(
      "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      "hex"
    );
    const addr = deriveCustodyAddressFromIkaDWallet(
      { type: "literal-pubkey", pubkey },
      "testnet"
    );
    expect(addr).toMatch(/^tb1p[a-z0-9]{58}$/);
  });
});
```

- [ ] **Step 2.2: Run, confirm fail**

```bash
cd sdk && bun test bitcoin/ika.test.ts 2>&1 | tail -10
```

Expected: module not found.

- [ ] **Step 2.3: Implement the helper**

Create `sdk/src/bitcoin/ika.ts`:

```typescript
import { payments, networks } from "bitcoinjs-lib";

export type IkaDWalletRef =
  | { type: "literal-pubkey"; pubkey: Buffer }
  | { type: "id"; dwalletId: string };

export function deriveCustodyAddressFromIkaDWallet(
  ref: IkaDWalletRef,
  network: "mainnet" | "testnet" | "regtest"
): string {
  const net =
    network === "mainnet"
      ? networks.bitcoin
      : network === "testnet"
      ? networks.testnet
      : networks.regtest;

  if (ref.type === "literal-pubkey") {
    if (ref.pubkey.length !== 33) {
      throw new Error("Expected 33-byte compressed pubkey");
    }
    const internalPubkey = ref.pubkey.subarray(1); // x-only
    const { address } = payments.p2tr({ internalPubkey, network: net });
    if (!address) throw new Error("p2tr derivation returned no address");
    return address;
  }

  throw new Error(
    "deriveCustodyAddressFromIkaDWallet: 'id' resolution requires Ika SDK; " +
      "use IkaClient (Task 4) to resolve dwalletId → pubkey first"
  );
}
```

Note: this helper is intentionally synchronous and pubkey-only. The `id` branch throws because resolving a dwallet ID to a pubkey requires an async network call to Ika; that resolution lives in the `IkaClient` (Task 4) which then passes the resolved pubkey here.

- [ ] **Step 2.4: Run test, expect pass**

```bash
cd sdk && bun test bitcoin/ika.test.ts 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 2.5: Re-export**

Add to `sdk/src/bitcoin/index.ts`:

```typescript
export { deriveCustodyAddressFromIkaDWallet } from "./ika";
export type { IkaDWalletRef } from "./ika";
```

- [ ] **Step 2.6: Run full SDK test suite**

```bash
cd sdk && bun test 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 2.7: Commit**

```bash
git add sdk/
git commit -m "Task 2: SDK helper deriveCustodyAddressFromIkaDWallet"
```

---

## Task 3 — Wire deposit-address generation through Ika

**Files:**
- Modify: `sdk/src/stealth-deposit.ts`
- Modify: `sdk/src/client.ts` (the `PrivacyCoinClient` high-level wrapper)
- Test: `sdk/tests/stealth-deposit.test.ts` (extend existing)

- [ ] **Step 3.1: Locate the existing FROST/Taproot derivation in `stealth-deposit.ts`**

```bash
grep -n "group_pub_key\|frost\|p2tr\|deriveCustody\|taproot" sdk/src/stealth-deposit.ts | head -20
```

Capture the line range that derives the destination address from `pool_config.group_pub_key`.

- [ ] **Step 3.2: Add a failing test asserting Ika-first lookup**

Add to `sdk/tests/stealth-deposit.test.ts`:

```typescript
it("uses ika_dwallet_id when set; falls back to group_pub_key when zero", async () => {
  const ikaPk = Buffer.from(
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    "hex"
  );
  // poolConfig with ika_dwallet_id resolved to a literal pubkey
  const ikaCfg = {
    ika_dwallet_id: new Uint8Array(32).fill(7),
    ika_dwallet_pubkey: ikaPk, // resolved off-chain by the caller
    group_pub_key: new Uint8Array(32),
  };
  const addr1 = await createNonInteractiveDeposit(/* ...args... */, { poolConfig: ikaCfg });
  expect(addr1.btcAddress).toMatch(/^tb1p/); // P2TR

  // legacy fallback: ika_dwallet_id zero, group_pub_key set
  const legacyCfg = {
    ika_dwallet_id: new Uint8Array(32),
    ika_dwallet_pubkey: undefined,
    group_pub_key: new Uint8Array(32).fill(3),
  };
  const addr2 = await createNonInteractiveDeposit(/* ...args... */, { poolConfig: legacyCfg });
  expect(addr2.btcAddress).toMatch(/^tb1p/);
});
```

(Fill in `...args...` from the existing test. Don't invent — match the call shape already in the file.)

- [ ] **Step 3.3: Run the failing test**

```bash
cd sdk && bun test stealth-deposit 2>&1 | tail -10
```

Expected: fails because `ika_dwallet_pubkey` isn't read in the implementation yet.

- [ ] **Step 3.4: Implement the conditional**

In `stealth-deposit.ts`, where the address is derived from `group_pub_key`, add a leading branch:

```typescript
import { deriveCustodyAddressFromIkaDWallet } from "./bitcoin/ika";

// ...
const ikaIsSet = poolConfig.ika_dwallet_id.some((b) => b !== 0);
let btcAddress: string;
if (ikaIsSet) {
  if (!poolConfig.ika_dwallet_pubkey) {
    throw new Error(
      "ika_dwallet_id is set but pubkey is unresolved — call IkaClient.resolveDWalletPubkey first"
    );
  }
  btcAddress = deriveCustodyAddressFromIkaDWallet(
    { type: "literal-pubkey", pubkey: poolConfig.ika_dwallet_pubkey },
    network
  );
} else {
  // existing FROST-derived address (legacy fallback)
  btcAddress = deriveTaprootFromGroupPubKey(poolConfig.group_pub_key, network);
}
```

The legacy `deriveTaprootFromGroupPubKey` already exists — keep it; only the dispatch is new.

- [ ] **Step 3.5: Verify the test passes**

```bash
cd sdk && bun test stealth-deposit 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 3.6: Update `PrivacyCoinClient.init` to resolve the dWallet pubkey at startup**

In `sdk/src/client.ts`, find where `pool_config` is loaded. If `ika_dwallet_id` is non-zero, populate `ika_dwallet_pubkey` by calling the Ika resolver (placeholder for Task 4 wiring; for now, accept it as an optional config arg):

```typescript
constructor(opts: PrivacyCoinClientOptions) {
  // ...
  this.poolConfig = {
    ...loadedPoolConfig,
    ika_dwallet_pubkey: opts.ikaDWalletPubkey, // injected by the caller for now
  };
}
```

Task 4 replaces the injected value with an automatic resolver call.

- [ ] **Step 3.7: Run full SDK suite**

```bash
cd sdk && bun test 2>&1 | tail -10
```

Expected: green.

- [ ] **Step 3.8: Commit**

```bash
git add sdk/
git commit -m "Task 3: deposit address derives from ika_dwallet_id, falls back to group_pub_key"
```

---

## Task 4 — Privacy Coin → Ika CPI from `complete_redemption`

**Why this exists:** This is the heart of the pivot. The Privacy Coin Pinocchio program directly CPIs the Ika dWallet program via `ika-dwallet-pinocchio`. No Node bridge. No off-chain sign orchestration.

**Files:**
- Modify: `contracts/programs/privacy-coin/Cargo.toml` (add git dep)
- Create: `contracts/programs/privacy-coin/src/cpi/mod.rs` and `cpi/ika.rs` (CPI wrapper specific to our account layout)
- Modify: `contracts/programs/privacy-coin/src/instructions/complete_redemption.rs` (CPI on the success path)
- Create: `contracts/programs/privacy-coin/src/utils/policy.rs` (migrated from `frost_server/policy.rs`)
- Test: `contracts/programs/privacy-coin/tests/complete_redemption_ika_cpi.rs` (new — uses Mollusk to assert the CPI is dispatched with the right accounts and the right `message_digest`)
- Reference: `docs/recon/2026-05-09-ika-sdk-brief.md` for exact account ordering and instruction data layout

- [ ] **Step 4.1: Add the git dep, pinned to the recon SHA**

Edit `contracts/programs/privacy-coin/Cargo.toml`:

```toml
[dependencies]
ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha", rev = "<SHA from Step 0.1>" }
```

```bash
cd contracts && cargo build-sbf --features localnet 2>&1 | tail -10
```

Expected: builds. If git auth fails, capture the failure mode and document in the recon brief.

- [ ] **Step 4.2: Migrate signing policy on-chain**

Create `contracts/programs/privacy-coin/src/utils/policy.rs`. Port the *pure* validation functions from `frost_server/policy.rs` (no FROST-specific bits — just amount limits, destination whitelist, paused state, fee bounds). Each is a standalone `pub fn` that returns `Result<(), Error>`.

```bash
sed -n '1,80p' frost_server/src/policy.rs
```

Read it, identify the pure-validation functions, port them to `utils/policy.rs` with the same names. Add unit tests in the same module.

- [ ] **Step 4.3: Failing test for `complete_redemption` Ika CPI**

Create `contracts/programs/privacy-coin/tests/complete_redemption_ika_cpi.rs` using Mollusk. Assert: when `complete_redemption` runs the success path, it dispatches an outer instruction to the Ika program with `discriminator = 8` and the expected account list (coordinator, message_approval, dwallet, caller_program, cpi_authority, payer, system_program). Use a stub Ika program loaded via Mollusk that simply records the dispatched instruction so we can assert against it.

Reference: voting example at `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/chains/solana/examples/voting/pinocchio/tests/mollusk.rs` — copy its harness setup.

- [ ] **Step 4.4: Verify the test fails to compile**

```bash
cd contracts && cargo test -p privacy-coin complete_redemption_ika_cpi --no-run 2>&1 | tail -10
```

Expected: missing imports / functions.

- [ ] **Step 4.5: Implement the CPI inside `complete_redemption`**

Modify `contracts/programs/privacy-coin/src/instructions/complete_redemption.rs`. After existing redemption validation:

```rust
use ika_dwallet_pinocchio::DWalletContext;
use crate::utils::policy;

// (after existing checks)
policy::check_redemption(&pool_config, &request, &btc_dest, btc_amount)?;
let unsigned_tx = build_btc_redemption_tx(/* ... */)?;
let sighash = compute_taproot_sighash(&unsigned_tx, /* prevouts, idx */)?;

let ctx = DWalletContext {
    dwallet_program: ika_program,
    cpi_authority,
    caller_program,
    cpi_authority_bump: pool_config.cpi_authority_bump,
};
ctx.approve_message(
    coordinator,
    message_approval,
    dwallet,
    payer,
    system_program,
    sighash,                        // message_digest
    [0u8; 32],                       // message_metadata_digest (none for now)
    pool_config.ika_dwallet_pubkey_x_only(),  // 32-byte x-only pubkey
    /* signature_scheme = ECDSA secp256k1 */ 0u16,  // value from recon brief
    message_approval_bump,
)?;
```

`signature_scheme` constant comes from the recon brief (Step 0.5 documents the actual u16 value used by Ika for ECDSA secp256k1).

- [ ] **Step 4.6: Update the instruction's account list and `mark_processing`**

`complete_redemption` now requires 6 additional accounts (ika_program, coordinator, message_approval, dwallet, cpi_authority, payer). Update the account parsing block at the top of the instruction. Update any callers in the SDK (Task 5 picks this up).

- [ ] **Step 4.7: Test passes**

```bash
cd contracts && cargo test -p privacy-coin complete_redemption_ika_cpi 2>&1 | tail -10
```

Expected: PASS. The Mollusk recorder asserts the CPI dispatched with the right shape.

- [ ] **Step 4.8: Full cargo build + test green**

```bash
cd contracts && cargo build-sbf --features localnet 2>&1 | tail -5
cd contracts && cargo test 2>&1 | tail -10
```

Expected: green.

- [ ] **Step 4.9: Commit**

```bash
git add contracts/
git commit -m "Task 4: complete_redemption CPIs Ika approve_message; on-chain policy migrated from frost_server"
```

---

## Task 5 — IkaSigner in the redemption pipeline

**Files:**
- Modify: `backend/src/redemption/signer.rs`
- Modify: `backend/src/redemption/types.rs`
- Modify: `backend/src/redemption/service.rs`
- Modify: `backend/src/redemption/builder.rs`
- Modify: `backend/Cargo.toml` (add `ika` feature)

- [ ] **Step 5.1: Read existing `FrostSigner` to understand the interface**

```bash
sed -n '140,260p' backend/src/redemption/signer.rs
grep -n "trait\|impl.*Signer\|pub fn sign" backend/src/redemption/signer.rs
```

Capture: signer trait name, `sign` signature (input bytes, output bytes), error type. The IkaSigner will conform to the same trait — that's the whole point.

- [ ] **Step 5.2: Add `ika` and `frost-legacy` features to Cargo.toml**

In `backend/Cargo.toml`:

```toml
[features]
default = ["ika"]
ika = []
frost-legacy = []
```

Existing FROST imports get gated on `frost-legacy`:

```bash
grep -n "use crate::bitcoin::frost_client\|use frost_secp256k1_tr" backend/src/ -r | head
```

Add `#[cfg(feature = "frost-legacy")]` above each FROST-only `use` and impl block for the first week. We delete in Task 8.

- [ ] **Step 5.3: Write a failing test for IkaSigner**

In `backend/src/redemption/signer.rs` add:

```rust
#[cfg(test)]
mod ika_signer_tests {
    use super::*;
    #[test]
    fn ika_signer_signs_each_input() {
        // Build a 1-input, 1-output unsigned tx; assert the signer fills witness data.
        // Use a mock IkaClient that returns a fixed 64-byte signature.
        let mock = MockIkaClient::with_fixed_sig([0xcc; 64]);
        let signer = IkaSigner::new_with_client(mock, [0u8; 33], "test-dwallet".into());
        let unsigned_tx = build_test_tx_one_input();
        let prevouts = vec![test_prevout(100_000)];
        let signed = signer.sign(&unsigned_tx, &prevouts).unwrap();
        assert_eq!(signed.input.len(), 1);
        assert!(!signed.input[0].witness.is_empty());
    }
}
```

`MockIkaClient` lives only in this `#[cfg(test)]` block — not production.

- [ ] **Step 5.4: Confirm test fails to compile**

```bash
cd backend && cargo test redemption::signer::ika_signer_tests --no-run 2>&1 | tail -10
```

Expected: `IkaSigner` does not exist.

- [ ] **Step 5.5: Implement `IkaSigner`**

In `signer.rs`, add the new struct conforming to the existing signer trait. It mirrors `FrostSigner` but calls `ika_client.sign` instead. Compute BIP-341 sighash exactly as `FrostSigner` does (extract that into a free function if necessary so both signers share it).

```rust
pub struct IkaSigner {
    pub ika: Arc<IkaClient>,
    pub dwallet_id: String,
    pub xonly_pubkey: [u8; 32],
}

impl IkaSigner {
    pub fn new(ika: Arc<IkaClient>, dwallet_id: String, xonly_pubkey: [u8; 32]) -> Self {
        Self { ika, dwallet_id, xonly_pubkey }
    }

    #[cfg(test)]
    pub fn new_with_client<C: SigningBackend + Send + Sync + 'static>(
        c: C, xonly: [u8; 32], dwallet_id: String,
    ) -> Self { /* ... */ }
}

impl Signer for IkaSigner {
    fn sign(&self, unsigned: &Transaction, prevouts: &[TxOut]) -> Result<Transaction> {
        let mut tx = unsigned.clone();
        for (i, _input) in unsigned.input.iter().enumerate() {
            let sighash = compute_taproot_sighash(unsigned, prevouts, i)?;
            let sig = self.ika.sign(&self.dwallet_id, &sighash)?;
            tx.input[i].witness = Witness::from_slice(&[sig.as_slice()]);
        }
        Ok(tx)
    }
}
```

Reference `FrostSigner::sign` for the loop shape; the only delta is the `sign` call.

- [ ] **Step 5.6: Test passes**

```bash
cd backend && cargo test redemption::signer::ika_signer_tests 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 5.7: Update `RedemptionConfig` to support Ika mode**

In `backend/src/redemption/types.rs`:

```rust
pub enum SigningMode {
    SingleKey { wif: String },
    Ika { dwallet_id: String, xonly_pubkey: [u8; 32], orchestrator_path: String },
    #[cfg(feature = "frost-legacy")]
    Frost { /* existing fields */ },
}
```

- [ ] **Step 5.8: Wire selection in `service.rs`**

Find where the signer is instantiated (search for `FrostSigner::new`). Replace with a match on `SigningMode`:

```rust
let signer: Box<dyn Signer + Send + Sync> = match &cfg.signing_mode {
    SigningMode::SingleKey { wif } => Box::new(SingleKeySigner::from_wif(wif)?),
    SigningMode::Ika { dwallet_id, xonly_pubkey, orchestrator_path } => {
        let ika = Arc::new(IkaClient::spawn(orchestrator_path)?);
        Box::new(IkaSigner::new(ika, dwallet_id.clone(), *xonly_pubkey))
    }
    #[cfg(feature = "frost-legacy")]
    SigningMode::Frost { /* ... */ } => Box::new(FrostSigner::new(/* ... */)),
};
```

- [ ] **Step 5.9: Verify whole backend builds and tests pass**

```bash
cd backend && cargo build 2>&1 | tail -5 && cargo test 2>&1 | tail -10
```

Expected: build green, tests green.

- [ ] **Step 5.10: Verify legacy still builds (so we have a fallback for week 1)**

```bash
cd backend && cargo build --no-default-features --features frost-legacy 2>&1 | tail -5
```

Expected: green.

- [ ] **Step 5.11: Commit**

```bash
git add backend/
git commit -m "Task 5: IkaSigner integrated into redemption pipeline (FROST behind frost-legacy feature)"
```

---

## Task 6 — Configuration: env, state JSON, sync-env, networks.json

**Files:**
- Modify: `scripts/e2e/localnet-state.json`
- Modify: `scripts/sync-env.sh`
- Modify: `web/src/lib/networks.json` (regenerated, not edited directly)

- [ ] **Step 6.1: Add Ika section to localnet state**

Edit `scripts/e2e/localnet-state.json` and add (next to existing `frost` block):

```json
"ika": {
  "network": "devnet",
  "dwalletId": "<from-recon>",
  "xonlyPubkey": "<from-recon, 64 hex chars>",
  "orchestratorPath": "sdk/dist/ika/orchestrator.js"
}
```

Where `<from-recon>` values come from the dWallet created in Task 0.

- [ ] **Step 6.2: Update `sync-env.sh` to read the new fields**

In `scripts/sync-env.sh`, find where `FROST_GROUP_PUB_KEY` is exported. Add alongside:

```bash
IKA_DWALLET_ID=$(jq -r '.ika.dwalletId' "$STATE")
IKA_XONLY_PUBKEY=$(jq -r '.ika.xonlyPubkey' "$STATE")
IKA_ORCHESTRATOR_PATH=$(jq -r '.ika.orchestratorPath' "$STATE")
IKA_NETWORK=$(jq -r '.ika.network' "$STATE")
```

Write them into `backend/.env.{network}` and the generated `web/src/lib/networks.json`.

- [ ] **Step 6.3: Regenerate env files**

```bash
./scripts/sync-env.sh
grep -E "IKA_|FROST_" backend/.env
cat web/src/lib/networks.json | jq '.localnet.ika'
```

Expected: Ika fields populated, no errors.

- [ ] **Step 6.4: Commit**

```bash
git add scripts/ web/src/lib/networks.json
git commit -m "Task 6: ika config in state JSON, sync-env, networks.json"
```

---

## Task 7 — End-to-end test on localnet

**Files:**
- Modify: `scripts/e2e/run-all.ts`
- Create: `scripts/e2e/step3c-ika-sweep.ts` (replaces `step3b-frost-sweep.ts`)
- Modify: `docker-compose.regtest.yml`

- [ ] **Step 7.1: Replace FROST signer services in docker-compose**

Open `docker-compose.regtest.yml`. Remove the two `frost-signer-*` services. Add an `ika-orchestrator` service:

```yaml
ika-orchestrator:
  image: oven/bun:latest
  working_dir: /workspace
  command: bun run sdk/dist/ika/orchestrator.js
  environment:
    IKA_NETWORK: devnet
    IKA_KEYPAIR_PATH: /run/secrets/ika_keypair
  volumes:
    - .:/workspace
  secrets:
    - ika_keypair
```

(Use `network_mode: host` if Ika devnet is reached over the public internet; otherwise the default network.)

- [ ] **Step 7.2: Author the new sweep step**

Create `scripts/e2e/step3c-ika-sweep.ts` modeled on `step3b-frost-sweep.ts`. The shape is: build the unsigned BTC sweep tx → submit to the orchestrator → receive the signed tx → broadcast to regtest.

- [ ] **Step 7.3: Wire into `run-all.ts`**

Replace the `step3b-frost-sweep` import with `step3c-ika-sweep`. Behind `process.env.SIGNING_MODE === "frost-legacy"`, keep the old import path conditional.

- [ ] **Step 7.4: Run E2E**

```bash
docker compose -f docker-compose.regtest.yml up -d
bun run scripts/e2e/run-all.ts
```

Expected: all 15 steps pass with Ika sweep substituted for FROST sweep.

- [ ] **Step 7.5: Run E2E three times in a row (flake check)**

```bash
for i in 1 2 3; do bun run scripts/e2e/run-all.ts || break; done
```

Expected: 3/3 pass. If any flake: investigate before proceeding to Task 8.

- [ ] **Step 7.6: Commit**

```bash
git add scripts/e2e/ docker-compose.regtest.yml
git commit -m "Task 7: E2E sweep via Ika orchestrator (3/3 green)"
```

---

## Task 8 — Decommission FROST

**Cut criterion:** Task 7 passed three times. Don't run this task before that.

**Files:**
- Delete: `frost_server/`
- Delete: `backend/src/bitcoin/frost_client.rs`
- Delete: `scripts/e2e/step3b-frost-sweep.ts`
- Delete: `scripts/frost-localnet-setup.sh`
- Modify: `backend/Cargo.toml` — remove `frost-legacy` feature
- Modify: `backend/src/redemption/types.rs` — remove `Frost` variant
- Modify: `backend/src/redemption/signer.rs` — remove `FrostSigner` impl
- Modify: `backend/src/redemption/service.rs` — remove FROST match arm
- Modify: `Cargo.toml` workspace — remove `frost_server` from members

- [ ] **Step 8.1: Confirm no references remain outside the feature flag**

```bash
grep -rn "frost\|FROST" --include="*.rs" --include="*.ts" backend/ sdk/ contracts/ web/ scripts/ 2>/dev/null | grep -v "frost-legacy\|//.*frost\|/// .*frost" | head -20
```

Expected: only feature-gated code paths or doc comments remain.

- [ ] **Step 8.2: Delete the directories**

```bash
git rm -rf frost_server/
git rm backend/src/bitcoin/frost_client.rs
git rm scripts/e2e/step3b-frost-sweep.ts
git rm scripts/frost-localnet-setup.sh
```

- [ ] **Step 8.3: Remove the feature flag**

In `backend/Cargo.toml` delete the `frost-legacy` feature. In every source file, delete `#[cfg(feature = "frost-legacy")]` blocks plus their guarded code.

```bash
grep -rn "frost-legacy" backend/ 2>/dev/null
```

Expected: empty.

- [ ] **Step 8.4: Workspace member removal**

In root `Cargo.toml`, remove `"frost_server"` from the `[workspace] members` array.

- [ ] **Step 8.5: cargo build + test fully green**

```bash
cargo build --workspace 2>&1 | tail -10
cargo test --workspace 2>&1 | tail -15
```

Expected: build green, tests green, no FROST symbols anywhere.

- [ ] **Step 8.6: E2E one more time on the FROST-free tree**

```bash
docker compose -f docker-compose.regtest.yml down
docker compose -f docker-compose.regtest.yml up -d
bun run scripts/e2e/run-all.ts
```

Expected: green.

- [ ] **Step 8.7: Commit (single commit — this is the demolition)**

```bash
git add -A
git commit -m "Task 8: decommission FROST subsystem; Ika is the sole custody mechanism"
```

---

## Task 9 — Web UX: deposit/withdraw flow shows Ika custody

**Files:**
- Modify: `web/src/app/(deposit)/deposit/page.tsx` (or equivalent — confirm path with `find web/src -name "page.tsx" | xargs grep -l "deposit"`)
- Modify: `web/src/app/(redeem)/redeem/page.tsx`
- Modify: any "About custody" copy block

- [ ] **Step 9.1: Locate the deposit page and current custody copy**

```bash
grep -rn "FROST\|threshold\|multisig" web/src 2>/dev/null | head -10
```

- [ ] **Step 9.2: Replace copy and surface the Ika dWallet ID**

Each user-facing reference to FROST becomes "Ika dWallet". Below the BTC address, show a collapsed details panel:

```
Custody: Ika dWallet
dWallet ID: <truncated>...<last4>
Network: <ika network>
```

- [ ] **Step 9.3: Add a quick visual sanity test**

```bash
cd web && bun run dev &
DEV_PID=$!
sleep 5
curl -s http://localhost:3000 | grep -E "Ika|dWallet" | head -3
kill $DEV_PID
```

Expected: matches found.

- [ ] **Step 9.4: Lint**

```bash
cd web && bun run lint 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 9.5: Commit**

```bash
git add web/
git commit -m "Task 9: web UX shows Ika dWallet custody"
```

---

## Task 10 — Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/TECHNICAL.md`
- Create: `docs/MIGRATION_v1_to_v2.md`
- Modify: `CLAUDE.md` (the project one — update commands list to remove FROST)

- [ ] **Step 10.1: README — replace the architecture diagram block**

In `README.md`, replace any FROST mentions with Ika. The architecture ASCII diagram from the design spec (`docs/designs/2026-05-09-ika-encrypt-pivot-design.md`) drops in cleanly.

- [ ] **Step 10.2: TECHNICAL.md — replace the FROST section with an Ika section**

```bash
grep -n "FROST\|## " docs/TECHNICAL.md | head -30
```

Find the FROST section header, replace the body with: dWallet creation overview, signing flow, where the orchestrator runs, observed devnet latency (from recon brief).

- [ ] **Step 10.3: MIGRATION doc**

Create `docs/MIGRATION_v1_to_v2.md`:

```markdown
# Migration v1 → v2 — FROST to Ika

## What changed
- Custody: FROST 2-of-3 threshold sig → Ika dWallet (2PC-MPC, user + Ika network)
- Operator burden: run FROST signer cluster → run a single Node orchestrator process
- On-chain `pool_config`: now stores `ika_dwallet_id` (32 bytes) alongside `group_pub_key` (legacy, zero for new pools)

## What did NOT change
- JoinSplit ZK circuits — unchanged
- Stealth addresses, OP_RETURN format, commitment derivation — unchanged
- SDK public surface (`PrivacyCoinClient`, `createNonInteractiveDeposit`, etc.) — same names, same arguments

## For pool operators
1. Spin up the Ika orchestrator (`bun run sdk/dist/ika/orchestrator.js`)
2. Create a fresh dWallet via `scripts/ika/create-pool-dwallet.ts`
3. Call `set_pool_config` with the new `ika_dwallet_id`
4. Existing deposits at the old FROST P2TR address are still spendable through the legacy code path until you're confident; cut over by setting `group_pub_key = [0; 32]` after sweeping
```

- [ ] **Step 10.4: CLAUDE.md — refresh project-level commands**

Remove the `### FROST Server`, `### FROST Localnet (Docker)` sections. Add an `### Ika Orchestrator` section with the spawn command and devnet config notes.

- [ ] **Step 10.5: Commit**

```bash
git add README.md docs/ CLAUDE.md
git commit -m "Task 10: docs updated for Ika custody"
```

---

## Final acceptance gate

- [ ] **Step F.1: Full repo build + test**

```bash
cargo build --workspace 2>&1 | tail -3
cargo test --workspace 2>&1 | tail -10
cd sdk && bun run build && bun test 2>&1 | tail -5 && cd ..
cd web && bun run lint && bun run build 2>&1 | tail -5 && cd ..
```

Expected: every command exits 0.

- [ ] **Step F.2: Three E2E runs on a clean docker compose**

```bash
docker compose -f docker-compose.regtest.yml down -v
docker compose -f docker-compose.regtest.yml up -d
for i in 1 2 3; do bun run scripts/e2e/run-all.ts || { echo "E2E run $i failed"; exit 1; }; done
```

Expected: 3/3 green.

- [ ] **Step F.3: Devnet smoke**

Deploy the modified `privacy-coin` program to Solana devnet (existing deploy script). Run a single deposit→shielded note→redemption→BTC arrival cycle on Solana devnet + Bitcoin testnet using the live Ika devnet dWallet from Task 0.

- [ ] **Step F.4: Tag and push**

```bash
git tag v2.0.0-ika-phase1
git push origin ika --tags
```

- [ ] **Step F.5: Open PR for review (do not merge yet)**

```bash
gh pr create --base main --head ika --title "Phase 1: Ika dWallet custody replaces FROST" --body "$(cat <<'EOF'
## Summary
- Replaces FROST 2-of-3 threshold custody with Ika dWallet (2PC-MPC).
- Adds `IkaClient` (TS + Rust IPC bridge) and `IkaSigner` in the redemption pipeline.
- Removes ~5k LOC of FROST orchestration; adds ~2.5k LOC of Ika integration.
- All existing JoinSplit ZK and shielded-pool semantics unchanged.

## Test plan
- [x] cargo test --workspace
- [x] sdk: bun test
- [x] web: lint + build
- [x] E2E (regtest + Solana localnet) ×3 green
- [x] Devnet smoke: 1 full deposit→redeem cycle
EOF
)"
```

---

## Self-Review

**Spec coverage** (against `docs/designs/2026-05-09-ika-encrypt-pivot-design.md` Phase 1 acceptance):
- Phase 1 step "Stand up Ika devnet integration" → Task 0
- "Update `createNonInteractiveDeposit` in SDK" → Task 3
- "Update deposit verification path" → no Solana program change needed; `verify_stealth_deposit` still SPV-verifies, only the destination address derivation upstream changes (Tasks 1-3 cover this)
- "Replace withdrawal flow" → Task 5
- "Backend `redemption/` worker" → Task 5 (signer swap), Task 6 (config), Task 7 (E2E)
- "Delete `frost_server/`" → Task 8
- "Update web deposit/withdraw UX" → Task 9
- Phase 1 acceptance E2E → Task 7 + final gate F.2/F.3
- "Policy moves on-chain" → **Gap.** The design said FROST policy moves on-chain in Phase 1. With Ika, the *signing* policy is enforced by the dWallet's user-control share (held by our Solana program in the future, by the orchestrator's keypair today). The on-chain policy migration is therefore a non-goal for Phase 1 against today's Sui-side dWallet. **Action:** flag this in the PR body and the migration doc; revisit when Ika's Solana coordinator program is GA.

**Placeholder scan:**
- Step 0.5 brief template uses angle-brackets for values the engineer must fill in from observation. These are not placeholders for *the plan* — they are placeholders the engineer is told to fill in *during* recon. Acceptable because the recon's job is to observe and record those values.
- Task 4 references `loadConfigFromEnv()` and `loadDevKeypair()` without defining them. **Fix:** these are conventional one-liners; engineer fills them in based on the recon brief's documented config shape. Inlined here:

```typescript
// in sdk/src/ika/orchestrator.ts
function loadConfigFromEnv() {
  return {
    network: (process.env.IKA_NETWORK ?? "devnet") as "devnet" | "mainnet",
    keypair: loadDevKeypair(process.env.IKA_KEYPAIR_PATH ?? "./keys/ika.dev.json"),
  };
}
function loadDevKeypair(path: string) {
  const raw = JSON.parse(require("node:fs").readFileSync(path, "utf-8"));
  return raw; // shape determined by Sui SDK; recon brief documents it
}
```

(Adjust this once the recon brief documents the actual keypair shape — but it's a real implementation, not a placeholder.)

- Task 9 step 9.1 says "or equivalent — confirm path with `find ...`". This is a real instruction (the route file path may differ across Next.js app router conventions), not a TBD.

**Type consistency:**
- `IkaSigner::new(...)` signature: `(ika: Arc<IkaClient>, dwallet_id: String, xonly_pubkey: [u8; 32])` consistent across Tasks 4, 5, 6.
- `IkaClient.sign(dwalletId, sighash) → Buffer (64 bytes)` consistent across TS and Rust IPC.
- `SigningMode::Ika` fields consistent in types.rs and service.rs.

**Scope:** Phase 1 only. Phase 2 (Encrypt swap) is explicitly NOT in this plan and will get its own.

---

## Execution choice

This project's CLAUDE.md restricts subagents to plan-only writing — they cannot execute code. So the **subagent-driven** option from the writing-plans skill is unavailable. Execution path is **inline via `superpowers:executing-plans`** with checkpoints at:
- After Task 0 (recon brief) — review brief contents before continuing
- After Task 5 (signer integrated) — first point at which a real Ika sign happens in the redemption path
- After Task 7 (3× E2E green) — gate before deleting FROST in Task 8
- Final gate F.3 — gate before opening the PR
