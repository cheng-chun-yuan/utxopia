# @zvault/sdk v2.0

Privacy-preserving BTC to Solana bridge SDK using ZK proofs.

## Installation

```bash
bun add @zvault/sdk
```

## Quick Start

```typescript
import { depositToNote, claimNote, splitNote, formatBtc } from '@zvault/sdk';

// 1. DEPOSIT: Generate credentials
const result = await depositToNote(100_000n); // 0.001 BTC
console.log('Send BTC to:', result.taprootAddress);
console.log('Save this link:', result.claimLink);

// 2. CLAIM: After BTC is confirmed (requires merkle proof from backend)
const claimed = await claimNote(config, result.claimLink, merkleProof);

// 3. SPLIT: Divide into two outputs
const { output1, output2 } = await splitNote(config, result.note, 50_000n);
```

---

## Import Routes

### Main Entry (`@zvault/sdk`)

```typescript
import {
  // === Note Operations ===
  generateNote,              // Create note with random secrets
  computeNoteCommitment,     // Compute Poseidon(pubKeyX, amount)
  computeNoteNullifier,      // Compute nullifier for leaf index
  getNotePublicKeyX,         // Get pubKey.x from note.nullifier
  serializeNote,             // Note → JSON-serializable object
  deserializeNote,           // JSON → Note
  formatBtc,                 // 100000n → "0.001 BTC"
  parseBtc,                  // "0.001 BTC" → 100000n

  // === Key Derivation ===
  deriveKeysFromWallet,      // Wallet signature → ZVaultKeys
  deriveKeysFromSignature,   // Raw signature → ZVaultKeys
  deriveKeysFromSeed,        // Seed bytes → ZVaultKeys
  createStealthMetaAddress,  // Keys → StealthMetaAddress
  encodeStealthMetaAddress,  // StealthMetaAddress → string
  decodeStealthMetaAddress,  // string → StealthMetaAddress

  // === Poseidon Hashing ===
  initPoseidon,              // Initialize WASM (call once at startup)
  poseidonHash,              // Async hash
  poseidonHashSync,          // Sync hash (after init)
  computeUnifiedCommitment,  // Poseidon(pubKeyX, amount) async
  computeNullifier,          // Poseidon(privKey, leafIndex) async
  hashNullifier,             // Poseidon(nullifier) async

  // === Cryptography ===
  generateGrumpkinKeyPair,   // Random keypair on Grumpkin curve
  grumpkinEcdh,              // ECDH shared secret
  pointMul,                  // Scalar multiplication
  sha256Hash,                // SHA-256
  doubleSha256,              // Bitcoin double-SHA256
  bigintToBytes,             // bigint → Uint8Array(32)
  bytesToBigint,             // Uint8Array → bigint
  hexToBytes,                // "0x..." → Uint8Array
  bytesToHex,                // Uint8Array → "0x..."

  // === Constants ===
  GRUMPKIN_GENERATOR,        // Curve generator point
  BN254_FIELD_PRIME,         // Field modulus
  TREE_DEPTH,                // Merkle tree depth (20)
} from '@zvault/sdk';
```

### Prover (`@zvault/sdk/prover`)

```typescript
import {
  initProver,                    // Initialize WASM prover
  isProverAvailable,             // Check if circuits loaded
  setCircuitPath,                // Set circuit artifacts path

  // === Proof Generation ===
  generateClaimProof,            // Claim deposited BTC
  generateSpendSplitProof,       // Split 1 note → 2 notes
  generateSpendPartialPublicProof, // Partial public withdraw
  generatePoolDepositProof,      // Deposit to yield pool
  generatePoolWithdrawProof,     // Withdraw from pool
  generatePoolClaimYieldProof,   // Claim yield rewards

  // === Verification ===
  verifyProof,                   // Local proof verification
  proofToBytes,                  // ProofData → Uint8Array
  cleanup,                       // Release WASM resources

  // === Types ===
  type ProofData,
  type ClaimInputs,
  type SpendSplitInputs,
  type SpendPartialPublicInputs,
  type MerkleProofInput,
} from '@zvault/sdk/prover';
```

### Stealth Addresses (`@zvault/sdk/stealth`)

```typescript
import {
  // === Deposit ===
  createStealthDeposit,          // Create stealth deposit for recipient
  prepareStealthDeposit,         // Prepare BTC stealth deposit
  buildStealthOpReturn,          // Build OP_RETURN for BTC tx

  // === Scanning ===
  scanAnnouncements,             // Scan for notes owned by keys
  scanAnnouncementsViewOnly,     // Scan with view-only keys
  parseStealthAnnouncement,      // Parse on-chain announcement

  // === Claiming ===
  prepareClaimInputs,            // Prepare inputs for claim proof

  // === Types ===
  type StealthDeposit,
  type ScannedNote,
  type OnChainStealthAnnouncement,
} from '@zvault/sdk/stealth';
```

### Bitcoin (`@zvault/sdk/bitcoin`)

```typescript
import {
  // === Taproot Addresses ===
  deriveTaprootAddress,          // commitment → P2TR address
  verifyTaprootAddress,          // Verify address matches commitment
  createP2TRScriptPubkey,        // Create scriptPubKey
  isValidBitcoinAddress,         // Validate address format

  // === Claim Links ===
  createClaimLink,               // Note → shareable URL
  parseClaimLink,                // URL → Note
  encodeClaimLink,               // Note → base64 string
  decodeClaimLink,               // base64 → Note

  // === Esplora API ===
  EsploraClient,                 // Bitcoin block explorer client
  esploraTestnet,                // Pre-configured testnet client
  esploraMainnet,                // Pre-configured mainnet client

  // === Types ===
  type EsploraTransaction,
  type EsploraUtxo,
} from '@zvault/sdk/bitcoin';
```

### Solana (`@zvault/sdk/solana`)

```typescript
import {
  // === Configuration ===
  DEVNET_CONFIG,                 // Devnet addresses
  MAINNET_CONFIG,                // Mainnet addresses
  LOCALNET_CONFIG,               // Localnet addresses
  getConfig,                     // Get current config
  setConfig,                     // Set network config

  // === Program IDs ===
  ZVAULT_PROGRAM_ID,             // Main zVault program
  BTC_LIGHT_CLIENT_PROGRAM_ID,   // Bitcoin header verification

  // === PDA Derivation ===
  derivePoolStatePDA,            // Pool state account
  deriveCommitmentTreePDA,       // Merkle tree account
  deriveNullifierRecordPDA,      // Nullifier record
  deriveStealthAnnouncementPDA,  // Stealth announcement
  deriveDepositRecordPDA,        // BTC deposit record

  // === Instructions ===
  buildClaimInstructionData,     // Build claim instruction
  buildSplitInstructionData,     // Build split instruction
  buildSpendPartialPublicInstructionData,

  // === ChadBuffer (large proof upload) ===
  uploadProofToBuffer,           // Upload proof in chunks
  closeBuffer,                   // Close and reclaim rent
  needsBuffer,                   // Check if proof needs buffer

  // === Commitment Tree ===
  fetchCommitmentTree,           // Fetch tree state from chain
  parseCommitmentTreeData,       // Parse tree account data
  isValidRoot,                   // Check if root is in history
} from '@zvault/sdk/solana';
```

### Yield Pool (`@zvault/sdk/pool`)

```typescript
import {
  // === Pool Operations ===
  createStealthPoolDeposit,      // Deposit to yield pool
  scanPoolAnnouncements,         // Scan for pool positions
  preparePoolDepositInputs,      // Prepare deposit proof inputs
  preparePoolWithdrawInputs,     // Prepare withdraw proof inputs
  preparePoolClaimYieldInputs,   // Prepare yield claim inputs

  // === Calculations ===
  calculateYield,                // Calculate accrued yield
  calculateTotalValue,           // Principal + yield
  formatYieldRate,               // Format APY display

  // === Types ===
  type StealthPoolPosition,
  type ScannedPoolPosition,
} from '@zvault/sdk/pool';
```

### Name Registry (`@zvault/sdk/registry`)

```typescript
import {
  // === Lookup ===
  lookupZkeyName,                // "alice.zkey" → StealthMetaAddress
  reverseLookupZkeyName,         // StealthMetaAddress → "alice.zkey"

  // === Validation ===
  isValidName,                   // Check name format
  normalizeName,                 // Lowercase + trim
  formatZkeyName,                // Add .zkey suffix
  hashName,                      // Name → PDA seed

  // === Instruction Building ===
  buildRegisterNameData,         // Register name instruction
  buildUpdateNameData,           // Update name instruction
  buildTransferNameData,         // Transfer name instruction

  // === Types ===
  type NameRegistryEntry,
} from '@zvault/sdk/registry';
```

### Deposit Watcher (`@zvault/sdk/watcher`)

```typescript
// Web (localStorage)
import {
  WebDepositWatcher,
  createWebWatcher,
} from '@zvault/sdk/watcher/web';

// React Native (AsyncStorage)
import {
  NativeDepositWatcher,
  createNativeWatcher,
  setAsyncStorage,
} from '@zvault/sdk/watcher/native';
```

### React Hooks (`@zvault/sdk/react`)

```typescript
import {
  useDepositWatcher,             // Track deposit confirmations
  useSingleDeposit,              // Track single deposit
  type UseDepositWatcherReturn,
} from '@zvault/sdk/react';
```

---

## Core Types

### Note

```typescript
interface Note {
  amount: bigint;           // Satoshis
  nullifier: bigint;        // Random secret (used as privKey)
  secret: bigint;           // Additional entropy
  commitment: bigint;       // Poseidon(pubKeyX, amount)
  nullifierHash: bigint;    // Poseidon(nullifier)
  // Byte representations
  nullifierBytes: Uint8Array;
  secretBytes: Uint8Array;
  commitmentBytes: Uint8Array;
  nullifierHashBytes: Uint8Array;
}
```

### ZVaultKeys (DKSAP)

```typescript
interface ZVaultKeys {
  spendingPrivKey: bigint;      // Can spend funds
  spendingPubKey: GrumpkinPoint;
  viewingPrivKey: bigint;       // Can view balances (safe to share)
  viewingPubKey: GrumpkinPoint;
}
```

### StealthMetaAddress

```typescript
interface StealthMetaAddress {
  spendingPubKey: GrumpkinPoint;  // K = k*G
  viewingPubKey: GrumpkinPoint;   // V = v*G
}
```

### ProofData

```typescript
interface ProofData {
  proof: Uint8Array;        // Groth16 proof bytes
  publicInputs: string[];   // Public inputs as field strings
}
```

### ClaimInputs

```typescript
interface ClaimInputs {
  privKey: bigint;          // Spending private key
  pubKeyX: bigint;          // Public key x-coordinate
  amount: bigint;           // Amount in satoshis
  leafIndex: bigint;        // Position in merkle tree
  merkleRoot: bigint;       // Current tree root
  merkleProof: MerkleProofInput;
  recipient: bigint;        // Recipient address as field
}
```

---

## Usage Examples

### 1. Generate Deposit

```typescript
import { depositToNote, initPoseidon } from '@zvault/sdk';

// Initialize Poseidon (once at app startup)
await initPoseidon();

// Generate deposit credentials
const deposit = await depositToNote(100_000n, 'testnet');

console.log('Taproot address:', deposit.taprootAddress);
console.log('Claim link:', deposit.claimLink);
console.log('Display:', deposit.displayAmount); // "0.001 BTC"

// Save the note securely - needed for claiming later
localStorage.setItem('note', JSON.stringify(serializeNote(deposit.note)));
```

### 2. Claim with ZK Proof

```typescript
import { generateClaimProof, initProver, setCircuitPath } from '@zvault/sdk/prover';
import { computeNoteCommitment, computeNoteNullifier, getNotePublicKeyX } from '@zvault/sdk';

// Initialize prover
setCircuitPath('/circuits');
await initProver();

// Prepare claim inputs
const note = deserializeNote(JSON.parse(localStorage.getItem('note')));
const pubKeyX = getNotePublicKeyX(note);
const leafIndex = 42n; // Get from backend

const proof = await generateClaimProof({
  privKey: note.nullifier,
  pubKeyX,
  amount: note.amount,
  leafIndex,
  merkleRoot: merkleProof.root,
  merkleProof: {
    siblings: merkleProof.pathElements,
    indices: merkleProof.pathIndices,
  },
  recipient: recipientAsBigint,
});

// Submit to Solana
const ix = buildClaimInstructionData(proof, merkleRoot, nullifierHash, amount, recipient);
```

### 3. Stealth Transfer

```typescript
import { createStealthDeposit, scanAnnouncements } from '@zvault/sdk/stealth';
import { decodeStealthMetaAddress } from '@zvault/sdk';

// Sender: Create stealth deposit
const recipientMeta = decodeStealthMetaAddress('st1q...');
const deposit = await createStealthDeposit(recipientMeta, 50_000n);

// deposit.ephemeralPub - include in announcement
// deposit.stealthPub - recipient's one-time address
// deposit.encryptedAmount - encrypted amount

// Recipient: Scan for incoming
const notes = await scanAnnouncements(myKeys, announcements);
for (const note of notes) {
  console.log(`Received ${note.amount} sats at index ${note.leafIndex}`);
}
```

### 4. Yield Pool

```typescript
import { createStealthPoolDeposit, calculateYield } from '@zvault/sdk/pool';

// Deposit to pool
const poolDeposit = await createStealthPoolDeposit(
  myKeys,
  100_000n,
  poolId
);

// Check yield later
const positions = await scanPoolAnnouncements(myKeys, poolAnnouncements);
for (const pos of positions) {
  const yield = calculateYield(pos.principal, pos.depositEpoch, currentEpoch, yieldRate);
  console.log(`Position: ${pos.principal} sats, Yield: ${yield} sats`);
}
```

### 5. Name Registry

```typescript
import { lookupZkeyName, isValidName } from '@zvault/sdk/registry';

// Lookup stealth address by name
const meta = await lookupZkeyName(connection, 'alice.zkey');
if (meta) {
  const deposit = await createStealthDeposit(meta, amount);
}

// Validate name
if (isValidName('alice')) {
  // Valid: 1-32 chars, alphanumeric + underscore
}
```

---

## Network Configuration

```typescript
import { setConfig, DEVNET_CONFIG } from '@zvault/sdk/solana';

// Use devnet (default)
setConfig('devnet');

// Or use custom config
setConfig({
  programId: 'your-program-id',
  zbtcMint: 'your-mint',
  // ...
});
```

---

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test src/prover.test.ts

# Run with circuits (required for prover tests)
bun run copy-circuits && bun test
```

---

## Migration from v1.x

### Breaking Changes

1. **Import paths changed** - Use subpath imports for tree-shaking:
   ```typescript
   // Before
   import { generateClaimProof } from '@zvault/sdk';

   // After
   import { generateClaimProof } from '@zvault/sdk/prover';
   ```

2. **Grumpkin functions moved** - Now in main crypto exports:
   ```typescript
   // Before
   import { generateKeyPair } from '@zvault/sdk/grumpkin';

   // After
   import { generateGrumpkinKeyPair } from '@zvault/sdk';
   ```

3. **ClaimInputs requires recipient** - Proof is now bound to recipient:
   ```typescript
   generateClaimProof({
     // ... other fields
     recipient: recipientAsBigint, // NEW: Required
   });
   ```

4. **depositToNote computes commitment** - No longer returns placeholder:
   ```typescript
   const deposit = await depositToNote(amount);
   // deposit.note.commitment is now real Poseidon hash
   ```
