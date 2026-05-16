# @utxopia/sdk v3.0 (JoinSplit Architecture)

Privacy-preserving BTC to Solana bridge SDK using Groth16 JoinSplit proofs.

## Installation

```bash
bun add @utxopia/sdk
```

## Quick Start

```typescript
import {
  createNonInteractiveDeposit,
  generateJoinSplitProof,
  buildTransactInstruction,
  scanUnifiedNotes,
  formatBtc,
} from '@utxopia/sdk';

// 1. DEPOSIT: Generate npk-based deposit (user sends any amount)
const deposit = await createNonInteractiveDeposit(recipientMeta, groupPubKey);
console.log('Send BTC to:', deposit.btcAddress);

// 2. SCAN: Detect incoming deposits/transfers via viewing key
const notes = await scanUnifiedNotes(myKeys, announcements);
for (const note of notes) {
  console.log(`Received ${formatBtc(note.amount)} at index ${note.leafIndex}`);
}

// 3. TRANSACT: JoinSplit proof for private transfer
const proof = await generateJoinSplitProof({
  nInputs: 1, nOutputs: 2,
  merkleRoot, boundParamsHash, token,
  publicKey, signature, nullifyingKey,
  inputs: [{ random, value, leafIndex, merkleProof }],
  outputs: [{ npk: npk1, value: value1 }, { npk: npk2, value: value2 }],
});

// 4. BUILD: Create Solana instruction
const ix = buildTransactInstruction({
  nInputs: 1, nOutputs: 2,
  proofBytes: proof.proof,
  merkleRoot, boundParamsHash,
  nullifiers, commitmentsOut, stealthData,
  accounts: { poolState, commitmentTree, vkRegistry, user, nullifierRecords },
});
```

---

## Architecture

### Deposit Flow

```
┌──────────────┐      ┌──────────────────┐      ┌──────────────────┐
│   Sender     │      │   Bitcoin        │      │   Solana         │
│              │      │   Network        │      │                  │
│  SDK creates │─BTC─▶│  Taproot addr    │      │  verify_stealth  │
│  npk + OP_   │      │  + OP_RETURN     │─SPV─▶│  _deposit        │
│  RETURN      │      │  (64 bytes)      │      │                  │
└──────────────┘      └──────────────────┘      │  Computes:       │
                                                 │  Poseidon(npk,   │
┌──────────────┐                                │  token, amount)  │
│  Recipient   │                                │       │          │
│              │◀──── scanUnifiedNotes ────────│  StealthAnnounce │
│  Viewing key │      (match npk via ECDH)      │  ment (90 bytes) │
│  detects     │                                └──────────────────┘
│  deposit     │
└──────────────┘
```

### JoinSplit Model

All zkBTC exists as commitments in a Merkle tree (depth 16). No public tokens.

| Operation | Amount Visible? |
|-----------|-----------------|
| Deposit | No (in commitment) |
| Transact | No (JoinSplit proof) |
| Withdraw | Yes (unavoidable) |

### 3-Key Model

```
Spending Key (Baby Jubjub) ─► Signs JoinSplit transactions (EdDSA-Poseidon)
       │
       ├─► Nullifying Key (BN254) ─► Generates nullifiers, prevents double-spend
       │
       └─► Viewing Key (Ed25519) ─► Scans deposit records, detects incoming payments
```

### Commitment Model

```
MPK = Poseidon(spendingPub.x, spendingPub.y, nullifyingKey)
NPK = Poseidon(MPK, random)
Commitment = Poseidon(NPK, token, amount)
Nullifier = Poseidon(nullifyingKey, leafIndex)
```

---

## Import Routes

### Main Entry (`@utxopia/sdk`)

```typescript
import {
  // === Deposit ===
  depositToNote,                    // Generate BTC deposit credentials (legacy)
  createNonInteractiveDeposit,      // npk-based deposit (any amount, no backend)

  // === JoinSplit Prover ===
  initProver,                       // Initialize WASM prover
  generateJoinSplitProof,           // Generate JoinSplit Groth16 proof
  circuitExists,                    // Check if circuit variant exists
  proofToBytes,                     // ProofData → Uint8Array

  // === Instruction Builders ===
  buildTransactInstruction,         // JoinSplit transact instruction
  buildRedemptionRequestInstruction, // BTC withdrawal request

  // === Key Derivation ===
  deriveKeysFromWallet,             // Wallet → UTXOpiaKeys
  deriveKeysFromSeed,               // Seed → UTXOpiaKeys
  createStealthMetaAddress,         // Keys → StealthMetaAddress

  // === Poseidon (JoinSplit) ===
  computeMPKSync,                   // Master Public Key
  computeNPKSync,                   // Note Public Key
  computeJoinSplitCommitmentSync,   // Commitment
  computeJoinSplitNullifierSync,    // Nullifier

  // === Bound Parameters ===
  computeBoundParamsHash,           // Hash transaction binding params

  // === Stealth & Scanning ===
  createStealthDeposit,             // Create stealth deposit (interactive)
  scanUnifiedNotes,                 // Scan stealth announcement events (unified: deposits + transfers)
  scanAnnouncements,                // Scan stealth announcements (legacy)

  // === PDA ===
  deriveVkRegistryPDA,              // VK registry for JoinSplit(N,M)
  derivePoolStatePDA,               // Pool state
  deriveCommitmentTreePDA,          // Commitment tree

  // === Types ===
  type JoinSplitProofInputs,
  type TransactInstructionOptions,
  type JoinSplitNote,
  type UTXOpiaKeys,
  type StealthMetaAddress,
  type BoundParams,
  type NonInteractiveDepositResult,
  type ScannedNote,
} from '@utxopia/sdk';
```

---

## Core Types

### NonInteractiveDepositResult

```typescript
interface NonInteractiveDepositResult {
  btcAddress: string;              // Taproot address to send BTC to
  depositOutputKey: Uint8Array;    // Tweaked output key (32 bytes)
  opReturnPayload: Uint8Array;     // 64 bytes: ephemeralPub || npk
  npk: Uint8Array;                 // Note public key (32 bytes)
  ephemeralPub: Uint8Array;        // Ed25519 ephemeral key (32 bytes)
}
```

### JoinSplitNote

```typescript
interface JoinSplitNote {
  npk: bigint;         // Poseidon(MPK, random)
  token: bigint;       // ZKBTC_TOKEN_ID (0x7a627463)
  amount: bigint;      // satoshis
  random: bigint;      // blinding factor
  leafIndex: number;   // Merkle tree position
  commitment: bigint;  // Poseidon(npk, token, amount)
}
```

### JoinSplitProofInputs

```typescript
interface JoinSplitProofInputs {
  nInputs: number;
  nOutputs: number;
  merkleRoot: bigint;
  boundParamsHash: bigint;
  token: bigint;
  publicKey: [bigint, bigint];  // BJJ (x, y)
  signature: [bigint, bigint, bigint]; // EdDSA-Poseidon (R8x, R8y, S)
  nullifyingKey: bigint;
  inputs: Array<{
    random: bigint;
    value: bigint;
    leafIndex: bigint;
    merkleProof: { siblings: bigint[]; indices: number[] };
  }>;
  outputs: Array<{ npk: bigint; value: bigint }>;
}
```

### UTXOpiaKeys

```typescript
interface UTXOpiaKeys {
  solanaPublicKey: Uint8Array;          // User identity (32 bytes)
  spendingPrivKey: bigint;              // Baby Jubjub private key
  spendingPubKey: BabyJubPoint;         // BJJ public key
  nullifyingKey: bigint;                // BN254 scalar
  viewingPrivKey: Uint8Array;           // Ed25519 private key
  viewingPubKey: Uint8Array;            // Ed25519 public key
  mpk: bigint;                          // Poseidon(pubX, pubY, nullifyingKey)
}
```

### StealthMetaAddress

```typescript
interface StealthMetaAddress {
  spendingPubKey: Uint8Array;  // 32 bytes BJJ compressed
  viewingPubKey: Uint8Array;   // 32 bytes Ed25519
  mpk: Uint8Array;             // 32 bytes (Poseidon hash as BE bytes)
}
// Total: 96 bytes when serialized
```

### ScannedNote

```typescript
interface ScannedNote {
  amount: bigint;                  // Plaintext amount in satoshis
  ephemeralPub: Uint8Array;        // Ed25519 ephemeral key
  stealthPub: BabyJubPoint;       // Derived Baby Jubjub pub key
  leafIndex: number;               // Merkle tree position
  commitment: Uint8Array;          // 32-byte Poseidon hash
}
```

---

## Usage Examples

### 1. Non-Interactive Deposit (npk-based)

The recommended deposit method. User can send **any amount** of BTC — the commitment is computed on-chain.

```typescript
import { createNonInteractiveDeposit, createStealthMetaAddress, initPoseidon } from '@utxopia/sdk';

await initPoseidon();

// Recipient shares their stealth meta-address (96 bytes)
const meta = createStealthMetaAddress(recipientKeys);

// Sender creates deposit (no backend API call needed)
const deposit = await createNonInteractiveDeposit(meta, groupPubKey, 'testnet');

console.log('Send BTC to:', deposit.btcAddress);
console.log('OP_RETURN payload (64 bytes):', deposit.opReturnPayload);
// User can send ANY amount to this address
```

### 2. Scan for Incoming Deposits & Transfers

```typescript
import { scanUnifiedNotes } from '@utxopia/sdk';
import { AnnouncementClient } from '@utxopia/sdk';

// Fetch stealth announcements from backend indexer (or fallback to RPC log scanning)
const client = new AnnouncementClient({ backendUrl: 'http://localhost:8080' });
const announcements = await client.fetchAll();

// Unified scan: handles both deposits (type=0, plaintext amount) and transfers (type=1, encrypted)
const myNotes = await scanUnifiedNotes(myKeys, announcements);
for (const note of myNotes) {
  console.log(`Received ${note.amount} sats at leaf ${note.leafIndex}`);
}
```

### 3. Legacy Deposit (with fixed amount)

```typescript
import { depositToNote, initPoseidon } from '@utxopia/sdk';

await initPoseidon();
const deposit = await depositToNote(100_000n, 'testnet');

console.log('Taproot address:', deposit.taprootAddress);
console.log('Claim link:', deposit.claimLink);
console.log('Display:', deposit.displayAmount); // "0.00100000 BTC"
```

### 4. JoinSplit Transfer

```typescript
import { generateJoinSplitProof, buildTransactInstruction } from '@utxopia/sdk';

// Generate proof (1 input → 2 outputs split)
const proof = await generateJoinSplitProof({
  nInputs: 1,
  nOutputs: 2,
  merkleRoot: currentRoot,
  boundParamsHash: boundHash,
  token: ZKBTC_TOKEN_ID,
  publicKey: [myPubX, myPubY],
  signature: [r8x, r8y, s],
  nullifyingKey: myNullifyingKey,
  inputs: [{
    random: inputNote.random,
    value: inputNote.amount,
    leafIndex: BigInt(inputNote.leafIndex),
    merkleProof: { siblings: proof.pathElements, indices: proof.pathIndices },
  }],
  outputs: [
    { npk: recipientNPK, value: 50_000n },
    { npk: changeNPK, value: 50_000n },
  ],
});

// Build Solana instruction
const ix = buildTransactInstruction({ ... });
```

### 5. Stealth Transfer (in-protocol)

```typescript
import { createStealthDeposit, scanAnnouncements } from '@utxopia/sdk';

// Sender: Create stealth deposit
const deposit = await createStealthDeposit(recipientMeta, 50_000n);
// deposit.ephemeralPub, deposit.commitment, deposit.encryptedAmount

// Recipient: Scan for incoming (legacy announcement-based)
const notes = await scanAnnouncements(myKeys, announcements);
for (const note of notes) {
  console.log(`Received ${note.amount} sats at index ${note.leafIndex}`);
}
```

---

## On-Chain Data Parsing

### Stealth Announcement Events (sol_log_data, disc=0x03)

Stealth announcements are emitted as `sol_log_data` events (no on-chain PDAs). Both deposits and transfers emit the same event structure:

```typescript
import { parseStealthAnnouncementEvent, parseProgramEvents } from '@utxopia/sdk';

// Parse events from transaction logs
const events = parseProgramEvents(txLogMessages);
const stealthEvents = events.filter(e => e.type === 'stealth_announcement');
```

**Event layout (sol_log_data segments):**

```
Segment  Field              Size
0        discriminator       1     (0x03)
1        announcement_type   1     0=deposit (plaintext), 1=transfer (encrypted)
2        ephemeral_pub      32     Ed25519 ephemeral key (for ECDH scanning)
3        amount_bytes        8     Plaintext u64 LE (type=0) or XOR-encrypted (type=1)
4        commitment         32     Poseidon(npk, token, amount)
5        leaf_index          4     u32 LE
```

Events are indexed by the backend event indexer and served via REST/WebSocket.

---

## Network Configuration

```typescript
import { setConfig } from '@utxopia/sdk';

setConfig('devnet');  // or 'localnet', 'mainnet'
```

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `ZKBTC_TOKEN_ID` | `0x7a627463n` | "zkbtc" as u32, used in commitment computation |
| `DEPOSIT_OP_RETURN_SIZE` | `64` | OP_RETURN payload: ephemeralPub (32) + npk (32) |
| `TREE_DEPTH` | `16` | Merkle tree depth (65,536 leaves max) |

---

## All Modules Reference

The SDK exports **217 functions/constants** and **63 types** across these modules:

### Cryptography (`./crypto`)

Low-level primitives for BN254, Baby Jubjub, Ed25519/X25519:

| Export | Description |
|--------|-------------|
| `randomFieldElement` | Generate random BN254 field element |
| `babyJubAdd/Double/Mul/Negate` | Baby Jubjub curve arithmetic |
| `babyJubCompress/Decompress` | BJJ point compression (32 bytes) |
| `generateBabyJubKeyPair` | Random BJJ keypair |
| `ed25519GenerateKeyPair` | Random Ed25519 keypair |
| `ed25519PubToX25519` | Convert Ed25519 pub to X25519 for ECDH |
| `x25519Ecdh` | X25519 Diffie-Hellman |
| `encryptAmountEd25519/decryptAmountEd25519` | XOR-based amount encryption |
| `sha256Hash/doubleSha256/taggedHash` | Hash utilities |
| Constants | `BN254_FIELD_PRIME`, `BABYJUB_ORDER`, `BABYJUB_BASE8`, etc. |

### Key Derivation (`./keys`)

Derive 3-key set from Solana wallet signature:

| Export | Description |
|--------|-------------|
| `deriveKeysFromWallet(wallet)` | Full key derivation from wallet adapter |
| `deriveKeysFromSignature(sig, pubkey)` | Keys from raw Ed25519 signature |
| `deriveKeysFromSeed(seed)` | Keys from arbitrary seed bytes |
| `createStealthMetaAddress(keys)` | 96-byte shareable stealth address |
| `serialize/deserializeStealthMetaAddress` | Stealth address encoding |
| `createDelegatedViewKey(keys, permissions)` | Time-limited view-only key |
| `clearUTXOpiaKeys(keys)` | Secure memory clearing |
| `extractViewOnlyBundle(keys)` | Export view-only key bundle |

### Stealth Deposit (`./stealth-deposit`)

Direct BTC deposit with stealth data:

| Export | Description |
|--------|-------------|
| `prepareStealthDeposit(meta, groupPubKey, network)` | Build complete deposit transaction data |
| `buildStealthOpReturn(ephemeralPub, npk)` | Build 64-byte OP_RETURN script |
| `parseStealthOpReturn(script)` | Parse OP_RETURN to extract stealth data |
| `completeDeposit(data)` | Verify deposit data integrity |
| `STEALTH_OP_RETURN_SIZE` | 64 bytes |

### PSBT Builder (`./psbt`)

Construct Bitcoin PSBTs for deposits:

| Export | Description |
|--------|-------------|
| `buildDepositPsbt(params)` | Build PSBT with OP_RETURN for wallet signing |
| `estimateDepositFee(params)` | Estimate transaction fee |
| `fetchUtxos(address, network)` | Fetch spendable UTXOs from Esplora |
| `selectUtxos(utxos, target)` | Coin selection algorithm |

### Bitcoin Clients (`./core/esplora`, `./core/mempool`)

| Export | Description |
|--------|-------------|
| `EsploraClient` | Full Esplora API client (tx, utxo, broadcast) |
| `esploraTestnet/esploraMainnet` | Pre-configured instances |
| `MempoolClient` | mempool.space API client (headers, SPV) |
| `mempoolTestnet/mempoolMainnet` | Pre-configured instances |
| `reverseBytes` | Byte reversal for Bitcoin endianness |

### Commitment Tree (`./commitment-tree`)

On-chain Merkle tree interaction:

| Export | Description |
|--------|-------------|
| `fetchCommitmentTree(connection, address)` | Read tree state from Solana |
| `buildCommitmentTreeFromChain(connection, address)` | Reconstruct full tree |
| `getLeafIndexForCommitment(connection, commitment)` | Find commitment's leaf index |
| `fetchMerkleProofForCommitment(connection, commitment)` | Get Merkle proof for a commitment |
| `getMerkleProofFromTree(tree, leafIndex)` | Compute proof from local tree |
| `isValidRoot(tree, root)` | Check if root is in history |
| `parseCommitmentTreeData(data)` | Parse raw account data |

### Deposit Watcher (`./watcher`)

Real-time deposit monitoring (web + mobile):

| Export | Description |
|--------|-------------|
| `BaseDepositWatcher` | Abstract watcher with polling |
| `WebDepositWatcher` / `createWebWatcher` | Browser-based watcher |
| `NativeDepositWatcher` / `createNativeWatcher` | React Native watcher |
| `serializeDeposit/deserializeDeposit` | Persistence helpers |
| `DEFAULT_WATCHER_CONFIG` | Default polling config |

### React Hooks (`./react`)

| Export | Description |
|--------|-------------|
| `useDepositWatcher(config)` | Watch multiple deposits with auto-polling |
| `useSingleDeposit(depositId)` | Watch a single deposit status |

### Priority Fees (`./solana/priority-fee`)

| Export | Description |
|--------|-------------|
| `estimatePriorityFee(rpc, accounts)` | Get fee estimate from Helius/RPC |
| `buildPriorityFeeInstructionData(config)` | Build compute budget instructions |
| `encodeSetComputeUnitLimit/Price` | Raw instruction encoding |
| Constants | `DEFAULT_COMPUTE_UNITS`, `DEFAULT_PRIORITY_FEE` |

### Connection Adapters (`./solana/connection`)

| Export | Description |
|--------|-------------|
| `createConnectionAdapterFromKit(rpc)` | Adapter from @solana/kit |
| `createConnectionAdapterFromWeb3(connection)` | Adapter from @solana/web3.js |
| `createFetchConnectionAdapter(url)` | Adapter from raw fetch |
| `getConnectionAdapter(config)` | Auto-detect and create adapter |

### ChadBuffer (`./chadbuffer`)

Large data upload to Solana (for SPV proofs exceeding tx size):

| Export | Description |
|--------|-------------|
| `uploadTransactionToBuffer(rpc, payer, data)` | Upload raw BTC tx |
| `uploadProofToBuffer(rpc, payer, buffer, proof)` | Upload Merkle proof |
| `closeBuffer(rpc, payer, buffer)` | Reclaim rent |
| `prepareVerifyDeposit(rpc, txid)` | Prepare SPV verification data |
| Constants | `CHADBUFFER_PROGRAM_ID`, `MAX_DATA_PER_WRITE` (1020 bytes) |

### Configuration (`./config`)

| Export | Description |
|--------|-------------|
| `getConfig/setConfig/createConfig` | Network config management |
| `DEVNET_CONFIG/MAINNET_CONFIG/LOCALNET_CONFIG` | Pre-built configs |
| `SDK_VERSION/DEPLOYMENT_INFO` | Build metadata |
| `JOINSPLIT_TREE_DEPTH` | 16 |

### Demo (`./demo`)

Development/testing helpers (devnet only):

| Export | Description |
|--------|-------------|
| `DEMO_INSTRUCTION` | Demo instruction discriminator (13) |
| `buildAddDemoStealthData(params)` | Build demo deposit instruction |
| `parseAddDemoStealthData(data)` | Parse demo deposit data |

---

## Testing

```bash
bun test              # Run all tests
bun run build         # Compile TypeScript
```

---

## Related Documentation

- [Technical Overview](../../docs/TECHNICAL.md) - Full technical documentation
- [Circuits](../../docs/CIRCUITS.md) - JoinSplit ZK circuit design
- [Documentation Index](../../docs/INDEX.md) - All docs hub
