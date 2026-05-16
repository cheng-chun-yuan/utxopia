# UTXOpia — Bridgeless, Private Bitcoin on Solana

**Native BTC custody held by an [Ika](https://ika.xyz) dWallet whose authority is a Solana PDA — withdrawal signing is policy-gated by an on-chain program, not by an off-chain signer cluster.**

UTXOpia is a privacy-preserving Bitcoin-to-Solana bridge using Groth16 ZK proofs. Users deposit BTC and receive **shielded commitments** in a Merkle tree on Solana. All transfers use JoinSplit(N,M) proofs — there is no public zkBTC token on-chain, and amount is revealed only at BTC withdrawal time. Custody of the pool's BTC has been moved off a 2-of-3 FROST committee and onto an Ika dWallet whose owner is a PDA of the UTXOpia program itself.

> **Hackathon track:** Encrypt + Ika (Bridgeless Capital Markets). This README documents the live devnet deployment of the FROST → Ika pivot.

---

## The Ika integration

The headline change: **the Solana program is the policy gate.** There is no human approval step, no committee quorum, no relayer with a key. A redemption is approved when, and only when, an instruction emitted by `G1bj9Vw9ipZ2Z7zKa9HrcHHPNqeWjg7uu51TsDr3ixUy` says it is.

### Trust boundary

```
        ┌──────────┐
  User  │  Wallet  │ ───── BTC deposit ─────┐
        └──────────┘                        │
              │                             ▼
              │                   ┌─────────────────────┐
              │  request_redeem ▶ │  UTXOpia       │   on-chain policy gate
              └─────────────────▶ │  G1bj9Vw9...3ixUy   │   (amount cap, fee cap,
                                  │  (Solana program)   │    paused-state, sighash)
                                  └─────────────────────┘
                                            │
                                            │ CPI: approve_message (disc 8)
                                            │ signed by `[__ika_cpi_authority]`
                                            ▼
                                  ┌─────────────────────┐
                                  │  CPI Authority PDA  │   CvHHu36G9srBErXVLFzXR5yRuCS3JcZy2dtZ3a91cviv
                                  │  (program-owned)    │   (bump 255)
                                  └─────────────────────┘
                                            │
                                            ▼
                                  ┌─────────────────────┐
                                  │  Ika dWallet PDA    │   DmZfRVeZHnFZ1ARVHRPJn88VCcJB2QhXLmSe8RuzFMfq
                                  │  (Ika program)      │   owner = CPI authority PDA
                                  └─────────────────────┘
                                            │
                                            │ 2PC-MPC sign (Taproot Schnorr)
                                            ▼
                                  ┌─────────────────────┐
                                  │  Bitcoin testnet4   │   tb1p99y96qcldtg6krzv5uvrhmmvh88zmy2dp0kgmjzz56tz7r7vxd3qqn2q95
                                  │  (P2TR key-spend)   │   x-only pubkey: 87a1014e...49b904c76
                                  └─────────────────────┘
```

### Why Ika specifically

Traditional threshold-signing custody puts the policy in an off-chain signer's config file. Whoever operates the signer cluster decides what gets co-signed. Ika inverts this: the dWallet's `approve_message` only fires when called by an authority — and we set that authority to a PDA that no human owns. The signing predicate is therefore **whatever the Solana program enforces in its `process_complete_redemption` handler**. Today that's amount/fee caps, paused-state, and BIP-341 Taproot key-spend sighash binding (`programs/utxopia/src/utils/policy.rs`, ported on-chain from the old `frost_server/policy.rs`). Tomorrow it can be a JoinSplit proof verifier, a per-recipient KYT check, a TWAP guard — anything expressible as a Solana instruction.

This also collapses the operational surface. v1 required running a 2-of-3 FROST signer cluster (`frost_server/`, three signing nodes, an off-chain DKG ceremony, network coordination). v2 requires a single backend that polls Solana RPC for a `Sign` PDA.

---

## What's deployed today (Solana devnet + Ika devnet + Bitcoin testnet4)

| Component | Address |
|---|---|
| UTXOpia program | [`G1bj9Vw9ipZ2Z7zKa9HrcHHPNqeWjg7uu51TsDr3ixUy`](https://explorer.solana.com/address/G1bj9Vw9ipZ2Z7zKa9HrcHHPNqeWjg7uu51TsDr3ixUy?cluster=devnet) |
| BTC Light Client program | [`C8JoSKzondM7X1ESwrBSodGMrXWtEWNmawXyjh9zEWJZ`](https://explorer.solana.com/address/C8JoSKzondM7X1ESwrBSodGMrXWtEWNmawXyjh9zEWJZ?cluster=devnet) |
| Ika dWallet program | [`87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY`](https://explorer.solana.com/address/87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY?cluster=devnet) |
| Pool's Ika dWallet PDA | [`DmZfRVeZHnFZ1ARVHRPJn88VCcJB2QhXLmSe8RuzFMfq`](https://explorer.solana.com/address/DmZfRVeZHnFZ1ARVHRPJn88VCcJB2QhXLmSe8RuzFMfq?cluster=devnet) |
| Pool's CPI authority PDA (bump 255) | [`CvHHu36G9srBErXVLFzXR5yRuCS3JcZy2dtZ3a91cviv`](https://explorer.solana.com/address/CvHHu36G9srBErXVLFzXR5yRuCS3JcZy2dtZ3a91cviv?cluster=devnet) |
| Pool's dWallet x-only pubkey | `87a1014ea16e42c825026889874902875aec7650b39c2b334a4d04d49b904c76` |
| Pool BTC address (testnet4) | `tb1p99y96qcldtg6krzv5uvrhmmvh88zmy2dp0kgmjzz56tz7r7vxd3qqn2q95` |
| Ika gRPC (devnet) | `pre-alpha-dev-1.ika.ika-network.net:443` |

### Today's transactions

- **Program redeploy (Ika CPI wired in):** [`5jWR2UEf...iMQ1T`](https://explorer.solana.com/tx/5jWR2UEf6LtAfWHD9wibtA7yPptAWYmZCLW3pKxGhNetmn7UB287ExnN6CpNpTGcCfNuQT4nQ2vUGWMvzajiMQ1T?cluster=devnet)
- **`set_pool_config` cutover (PoolConfig now points at the Ika dWallet):** [`3nEvSGKa...XGkkm`](https://explorer.solana.com/tx/3nEvSGKaa1guMWXeFQ28SaXVzkeLAtxQ5x7z12FZVuEv2gU7NpBurn6KS272CT9paYRsaHbbEEXkVBZD5SSXGkkm?cluster=devnet)

---

## Try it

```bash
# 1. Clone + install
git clone https://github.com/<org>/private_coin && cd private_coin
bun install

# 2. Build the contracts (Pinocchio) and the SDK
(cd contracts && cargo build-sbf --features devnet)
(cd sdk && bun run build)

# 3. Run the web app against the live devnet pool
(cd web && bun run dev)   # http://localhost:3000 → /send
```

To re-run the Ika dWallet setup (one-shot, idempotent):

```bash
UTXOPIA_PROGRAM_ID=G1bj9Vw9ipZ2Z7zKa9HrcHHPNqeWjg7uu51TsDr3ixUy \
  PAYER_KEYPAIR_PATH=~/.config/solana/id.json \
  bun run scripts/ika-setup/dkg.ts --network devnet

UTXOPIA_PROGRAM_ID=G1bj9Vw9ipZ2Z7zKa9HrcHHPNqeWjg7uu51TsDr3ixUy \
  PAYER_KEYPAIR_PATH=~/.config/solana/id.json \
  node --experimental-strip-types scripts/ika-setup/set-pool-config.ts --network devnet
```

Full operational guide: [docs/RUNNING.md](docs/RUNNING.md).

---

## What's still pre-alpha (honest disclosures)

We are shipping against `dwallet-labs/ika-pre-alpha`. A few things judges should know up-front rather than discover mid-demo:

- **Ika devnet uses a mock signer, not real distributed MPC.** The CPI surface (`approve_message`, disc 8), the dWallet account format, the authority transfer, the on-chain CPI from our program — all real. The cryptographic backend that fills the `Sign` PDA is a single mock node until Ika mainnet. We surface this in the demo.
- **Backend dispatch is Ika by default.** `UTXOPIA_SIGNING_MODE=ika` is the default in `sync-env.sh`, and `backend/src/main.rs::create_ika_service` constructs an `IkaSigner` that polls the `MessageApproval` PDA on Solana and assembles the Taproot witness. One known limitation: the exact byte offset of the Schnorr signature inside `MessageApproval` is "trailing 64 bytes" — correct for many layouts but to be pinned during the first live exercise. Deposit sweeps (`backend/src/deposit_tracker/sweeper.rs`) auto-select single-key signing when `SIGNING_MODE != frost`; Ika-based sweep signing is a follow-up.
- **FROST `group_pub_key` is still populated in `PoolConfig`** for now — it's vestigial since the backend never enters the FROST signing path with `SIGNING_MODE=ika`, but the on-chain field is preserved so any pre-Ika deposits would still validate against the legacy verifier if we re-enabled it. Zeroing it is a one-line follow-up.
- **`frost_server/` has been decommissioned.** The cluster, the Docker stack, the DKG scripts, and the standalone test binaries are gone. Backend still contains dead FROST code paths (`MpcSigner`, `create_frost_service`, `SigningMode::Frost` config variant, `deposit_tracker/sweeper.rs::SigningMode::Frost`) because `backend/src/bitcoin/frost_client.rs` exports shared types (`SolanaVerification`, `PrevoutInfo`, `SigningContext`) used by the Ika path too. Extracting those into a neutral module is a clean follow-up.
- **Pinocchio version mismatch.** Upstream `ika-dwallet-pinocchio` pins Pinocchio 0.10; we're on 0.9. Our `contracts/programs/utxopia/src/cpi/ika.rs` hand-builds the CPI to avoid the dep. The CPI bytes are byte-equivalent — when we upgrade Pinocchio, the helper can be swapped for the upstream crate without callsite changes.
- **Devnet wipes.** Per the upstream README, Ika's Solana coordinator is wiped periodically and fully reset at the Ika Alpha 1 transition. Our `scripts/ika-setup/` is idempotent and re-runnable on demo day.

---

## Architecture

```
BTC Deposit → Taproot ──► SPV verify (disc 11) ──┐
SOL/USDC/USDT → shield (disc 12) ────────────────┤──► Poseidon(npk, token_id, amount) → shared Merkle tree (depth 16)
                                                  │                                          │
                                                  │           JoinSplit transact (disc 13): N inputs → M outputs, Groth16
                                                  │                                          │
                                                  ├──► unshield (disc 14) → SPL token back to wallet
                                                  └──► redeem (disc 15) → request_redemption (16) → complete_redemption (17)
                                                                                                          │
                                                                                                          │ CPI: Ika approve_message (disc 8)
                                                                                                          ▼
                                                                                               BTC via Ika dWallet (Taproot key-spend)
```

The full architectural picture — JoinSplit circuit design, BTC SPV light client, stealth address protocol, three-key model, on-chain account layouts, error codes — lives in [docs/TECHNICAL.md](docs/TECHNICAL.md). The pivot narrative (what changed, what didn't) is in [docs/MIGRATION_v1_to_v2.md](docs/MIGRATION_v1_to_v2.md). The Ika CPI surface (instruction layout, account ordering, signature scheme values) is in [docs/recon/2026-05-09-ika-sdk-brief.md](docs/recon/2026-05-09-ika-sdk-brief.md).

---

## The Problem

Bitcoin's transparent blockchain makes privacy challenging:
- Every transaction is publicly visible and linkable
- Cross-chain bridges expose user activity on both chains
- DeFi participation requires revealing transaction history

**UTXOpia solves this** by creating a privacy layer between Bitcoin and Solana using zero-knowledge proofs — with no public token, no transaction graph, and (now) no off-chain custodian.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **ZK Circuits** | circom + Groth16 (BN254) | Parameterized JoinSplit(N,M) circuits, client-side proving |
| **On-Chain Verifier** | BN254 alt_bn128 pairing syscalls | Inline Groth16 proof verification (~95k CU) |
| **Smart Contracts** | Pinocchio (Solana) | Zero-copy state, CU-optimized with LTO |
| **Bitcoin Integration** | Taproot + SPV light client | Permissionless deposit verification |
| **Stealth Addresses** | Baby Jubjub + Ed25519 ECDH | Unlinkable one-time addresses (EIP-5564/DKSAP) |
| **Name Service** | `.btcpro.sol` (SNS subdomains) | Human-readable stealth addresses |
| **Custody** | Ika dWallet (2PC-MPC, Solana-native pre-alpha) | BTC signing gated by the program via `approve_message` CPI |
| **Client SDK** | TypeScript | Full privacy toolkit |
| **Frontend** | Next.js | Unified `/send` flow (deposit / transfer / unshield / redeem) |
| **Backend** | Rust (Axum) + Ika watcher | API server + off-chain `MessageApproval` PDA poller that assembles the Taproot witness |

---

## Key Innovations

### 1. JoinSplit(N,M) ZK Circuits

Single parameterized circuit for all private operations — no trusted backend:

| Variant | Purpose |
|---------|---------|
| `joinsplit_1x2` | Deposit claim (1 input → 2 outputs) |
| `joinsplit_2x2` | Standard private transfer |
| `joinsplit_NxM` | General case (N+M ≤ 14, 91 total variants) |

**Commitment model:**
```
MPK        = Poseidon(spendingPub.x, spendingPub.y, nullifyingKey)
NPK        = Poseidon(MPK, random)
Commitment = Poseidon(NPK, token, amount)
Nullifier  = Poseidon(nullifyingKey, leafIndex)
```

### 2. Stealth Address Protocol (EIP-5564/DKSAP)

Unlinkable one-time addresses using Baby Jubjub spending keys + Ed25519 viewing keys:

```
Sender:                              Recipient:
┌────────────────────┐               ┌────────────────────┐
│ 1. ephemeral_priv  │               │ 1. viewing_priv    │
│ 2. ECDH(eph, view) │───shared───►  │ 2. ECDH(view, eph) │
│ 3. derive stealth  │   secret      │ 3. derive stealth  │
│ 4. encrypt amount  │               │ 4. decrypt amount  │
│ 5. publish announce│               │ 5. spend with priv │
└────────────────────┘               └────────────────────┘
```

- **Viewing Key** (Ed25519): detect and decrypt incoming transfers (cannot spend)
- **Spending Key** (Baby Jubjub): sign JoinSplit transactions (EdDSA-Poseidon)

### 3. Three-Key Model

```
Spending Key (Baby Jubjub) ─► Signs JoinSplit transactions (EdDSA-Poseidon)
       │
       ├─► Nullifying Key (BN254 scalar) ─► Generates nullifiers, prevents double-spend
       │
       └─► Viewing Key (Ed25519) ─► Scans stealth announcements, decrypts amounts
```

Share the viewing key with accountants or compliance without risk of fund loss.

### 4. Ika dWallet Custody (Bridgeless BTC)

See [The Ika integration](#the-ika-integration) above. The headline: BTC custody authority is a PDA of the UTXOpia program. The signing predicate is whatever the program enforces in `process_complete_redemption`.

When a user redeems shielded zkBTC for native BTC:

1. The pipeline submits `complete_redemption` (instruction discriminator 17). The instruction data carries the BIP-341 Taproot key-spend sighash for the unsigned withdrawal tx.
2. The on-chain program runs the policy gate (amount cap, fee cap, paused-state — ported on-chain from `frost_server/policy.rs` to `programs/utxopia/src/utils/policy.rs`).
3. The program **CPIs into the Ika dWallet program** calling `approve_message` (disc 8). Our CPI helper at `contracts/programs/utxopia/src/cpi/ika.rs` constructs the call by hand. The CPI seeds the signing authority via `["__ika_cpi_authority"]`.
4. The Ika network's mock signer (pre-alpha) asynchronously fills a `Sign` PDA. The backend watcher (`backend/src/redemption/signer.rs::IkaSigner`) polls for it, decodes the 64-byte Schnorr signature, assembles the Taproot witness, and broadcasts to Bitcoin testnet.

Architecturally the design extends to any chain Ika supports (Ethereum, Sui, Cardano via EdDSA, …). This hackathon ships BTC only; multi-chain is a config change, not a redesign.

### 5. `.btcpro.sol` Name Registry

Human-readable stealth addresses via SNS subdomains:

```typescript
// Send privately to alice.btcpro.sol
const meta = await resolveStealthName(connection, 'alice');
await sendPrivate(config, myNote, meta.stealthMetaAddress);
```

---

## Project Structure

```
utxopia/
├── contracts/                  # Solana programs (Pinocchio)
│   ├── programs/utxopia/  # Main program (15 instructions; src/cpi/ika.rs hosts the Ika CPI helper)
│   └── programs/btc-light-client/ # Bitcoin header tracking (standalone)
├── circuits/                   # Zero-knowledge circuits (circom)
│   ├── circom/joinsplit.circom # Parameterized JoinSplit(N,M,16) template
│   └── circom/lib/             # Shared (commitment, nullifier, merkle, mpk)
├── sdk/                        # TypeScript client SDK
│   └── src/bitcoin/ika.ts      # P2TR address derivation from Ika dWallet pubkey
├── web/                        # Next.js web interface (/send unified flow)
├── backend/                    # Rust API + deposit tracker + redemption
│   └── src/redemption/signer.rs # IkaSigner (primary) + SingleKeySigner (sweep fallback)
├── scripts/ika-setup/          # DKG + transfer_dwallet + set_pool_config one-shots
└── docs/                       # Technical docs, design specs, recon brief
    ├── designs/2026-05-09-ika-encrypt-pivot-design.md   # Ika+Encrypt pivot architecture
    ├── plans/2026-05-09-ika-phase1-implementation-plan.md  # step-by-step plan
    └── recon/2026-05-09-ika-sdk-brief.md   # Ika CPI surface + integration notes
```

---

## On-Chain Instructions

| Disc | Name | Purpose |
|------|------|---------|
| 0 | `INITIALIZE` | Setup pool state + commitment tree |
| 1 | `SET_PAUSED` | Admin pause/unpause |
| 2 | `SET_POOL_CONFIG` | Write pool params (incl. Ika dWallet fields) |
| 3–5 | Pool-update timelock | `PROPOSE` / `EXECUTE` / `CANCEL` (48h delay) |
| 6–7 | VK registry | Init/update Groth16 verification-key hashes |
| 8–10 | Multi-token admin | `REGISTER_TOKEN`, `UPDATE_TOKEN_CONFIG`, `CLAIM_FEES` |
| 11 | `COMPLETE_DEPOSIT` | Verify BTC deposit via SPV, compute commitment on-chain |
| 12 | `SHIELD` | Shield SPL tokens (zkSOL / zkUSDC / zkUSDT) into the pool |
| 13 | `TRANSACT` | JoinSplit N-to-M private transfer (Groth16) |
| 14 | `UNSHIELD` | JoinSplit transfer with SPL token output (privacy → public) |
| 15 | `REDEEM` | JoinSplit transfer with BTC withdrawal request |
| 16 | `REQUEST_REDEMPTION` | Burn zkBTC, queue BTC withdrawal |
| 17 | `COMPLETE_REDEMPTION` | Policy-gated CPI into Ika `approve_message` |
| 18–19 | Redemption lifecycle | `MARK_PROCESSING`, `CANCEL_REDEMPTION` |
| 20 | `ROTATE_TREE` | Roll the commitment tree when full |

---

## SDK Usage (`@utxopia/sdk`)

```typescript
import { UTXOpiaClient } from '@utxopia/sdk';

// High-level client (recommended)
const client = await UTXOpiaClient.init({ network: "devnet" });
await client.loginWithSeed(seed);
const notes = await client.getNotes(tokens);
```

Lower-level imports are also available:

```typescript
import {
  createNonInteractiveDeposit,
  generateJoinSplitProof,
  buildTransactInstruction,
  scanUnifiedNotes,
} from '@utxopia/sdk';

// 1. DEPOSIT: Generate npk-based deposit (user sends any amount)
const deposit = await createNonInteractiveDeposit(recipientMeta, ikaDwalletXOnlyPubkey);
console.log('Send BTC to:', deposit.btcAddress);

// 2. TRANSACT: JoinSplit proof for private transfer
const proof = await generateJoinSplitProof(inputs);

// 3. BUILD: Create Solana instruction
const ix = buildTransactInstruction(options);
```

---

## Adding a New Supported Token

To add a new SPL token (e.g. USDC, USDT) to the shielded pool:

1. **Register on-chain**

   ```bash
   bun run scripts/register-token.ts <MINT_ADDRESS> \
     --service-fee 2000 --min-deposit 1000 --max-deposit 10000000000
   ```

2. **Add to frontend token list:** edit `web/src/lib/supported-tokens.ts` and add an entry to `SUPPORTED_TOKENS`.

3. **Set env var:** `NEXT_PUBLIC_<SYMBOL>_MINT=<address>` in Vercel + `web/.env.local`.

4. **Add token logo:** drop a PNG at `web/public/tokens/<symbol>.png`.

The frontend resolves `tokenId → symbol` automatically using `supported-tokens.ts` + Poseidon hash. No backend changes needed.

---

## Privacy Guarantees

| Operation | Amount Visible | Linkable |
|-----------|---------------|----------|
| Deposit BTC | On Bitcoin chain | No (to claim) |
| Claim (JoinSplit 1→2) | No | No |
| Transfer (JoinSplit N→M) | No | No |
| Stealth Send | No | Recipient only |
| Withdraw BTC | On Bitcoin chain | No (to deposit) |

---

## Cryptography

| Component | Technology |
|-----------|------------|
| Proof System | Groth16 (BN254 curve) |
| Hash Function | Poseidon (ZK-friendly) |
| Commitment | `Poseidon(NPK, token, amount)` |
| Nullifier | `Poseidon(nullifyingKey, leafIndex)` |
| Stealth | Baby Jubjub + Ed25519 ECDH (EIP-5564) |
| BTC Deposits | Taproot (BIP-341) |
| BTC Redemption | Ika dWallet — 2PC-MPC, Schnorr/Taproot (`SIG_SCHEME_TAPROOT_SHA256 = 3`); pre-alpha mock signer today, real distributed MPC at Ika mainnet |
| Merkle Tree | Depth 16 (65,536 leaves) |
| Token | zkBTC (Token-2022) |

---

## Demo

A 60-second walkthrough script (timing + voiceover + screen actions) lives at [docs/DEMO.md](docs/DEMO.md).

---

## Security Notice

> **This is hackathon software.** Not audited for production use.

- Solana devnet + Bitcoin testnet4 + Ika devnet (pre-alpha) only
- Full security audit required before any mainnet deployment
- Ika cryptographic backend is a mock signer until Ika mainnet — see "What's still pre-alpha" above

---

## License

MIT
