# zVault SDK Reference

TypeScript SDK for privacy-preserving BTC to Solana bridge.

---

## Installation

```bash
bun add @zvault/sdk
```

---

## Quick Start

```typescript
import {
  deposit,
  claimNote,
  splitNote,
  createClaimLinkFromNote,
  sendPrivate,
  withdraw
} from '@zvault/sdk';

// 1. Generate deposit credentials
const result = await deposit(100_000n); // 0.001 BTC
console.log('Send BTC to:', result.taprootAddress);
console.log('Save this link:', result.claimLink);

// 2. After BTC confirmed, claim zkBTC
const claimed = await claimNote(config, result.claimLink);

// 3. Split into two notes
const { output1, output2 } = await splitNote(config, result.note, 60_000n);

// 4. Send via link or stealth
const link = createClaimLinkFromNote(output1);        // Shareable URL
await sendPrivate(config, output2, recipientMeta);    // Private transfer

// 5. Withdraw back to BTC
await withdraw(config, myNote, 'tb1q...');
```

---

## Function Categories

| Category | Functions | Purpose |
|----------|-----------|---------|
| **Deposit** | `deposit`, `claimNote`, `sendStealth` | BTC to zkBTC |
| **Transfer** | `splitNote`, `createClaimLinkFromNote`, `sendPrivate` | zkBTC transfers |
| **Withdraw** | `withdraw` | zkBTC to BTC |
| **Yield** | `depositToPool`, `withdrawFromPool`, `claimPoolYield` | Yield farming |
| **Identity** | `registerName`, `lookupZkeyName` | .zkey names |
| **Setup** | `deriveKeysFromWallet`, `createStealthMetaAddress` | Key management |

---

## Key Management

```typescript
import { deriveKeysFromWallet, createStealthMetaAddress } from '@zvault/sdk';

// Derive keys from wallet signature
const keys = await deriveKeysFromWallet(walletAdapter);
// Returns: {
//   spendingPrivKey: bigint (Baby Jubjub scalar),
//   spendingPubKey: BabyJubPoint,
//   viewingPrivKey: Uint8Array (Ed25519),
//   viewingPubKey: Uint8Array (Ed25519),
// }

// Create shareable stealth meta-address
const meta = createStealthMetaAddress(keys);
```

### Key Separation

- **Spending Key** (Baby Jubjub): Generate nullifiers, claim funds. Keep secret.
- **Viewing Key** (Ed25519): Detect incoming payments, decrypt amounts. Safe to share with auditors.

---

## Stealth Address Operations

```typescript
import { scanAnnouncements, lookupZkeyName } from '@zvault/sdk';

// Scan for incoming transfers using viewing key
const myNotes = await scanAnnouncements(keys, announcements);

// Send to .zkey name
const entry = await lookupZkeyName(connection, 'alice');
await sendPrivate(config, myNote, entry.stealthMetaAddress);
```

---

## Proof Generation

All proofs are generated client-side via snarkjs (Groth16, BN254 curve):

```typescript
import { generateClaimProof, generateSpendSplitProof } from '@zvault/sdk';

// Claim proof
const proof = await generateClaimProof({
  privKey, amount, leafIndex, merkleRoot, merkleProof, recipient
});

// Split proof
const proof = await generateSpendSplitProof({
  privKey, amount, leafIndex, merkleRoot, merkleProof,
  output1PrivKey, output1Amount, output2PrivKey, output2Amount
});
```

Field bounds validation is enforced automatically — all bigint inputs are checked against the BN254 field prime, and amounts are validated against the total BTC supply cap.

---

## Types

```typescript
// Baby Jubjub curve point
interface BabyJubPoint {
  x: bigint;
  y: bigint;
}

// ZVault keys (private)
interface ZVaultKeys {
  spendingPrivKey: bigint;         // Baby Jubjub scalar
  spendingPubKey: BabyJubPoint;
  viewingPrivKey: Uint8Array;      // Ed25519 (32 bytes)
  viewingPubKey: Uint8Array;       // Ed25519 (32 bytes)
}

// Merkle proof
interface MerkleProof {
  pathElements: Uint8Array[];  // 20 sibling hashes
  pathIndices: number[];       // 20 direction bits (0=left, 1=right)
  leafIndex: number;
  root: Uint8Array;
}

// Scanned stealth note
interface ScannedNote {
  amount: bigint;
  ephemeralPub: Uint8Array;
  stealthPub: BabyJubPoint;
  leafIndex: number;
  commitment: Uint8Array;
}
```

---

## Constants

```typescript
// Program IDs (devnet)
ZVAULT_PROGRAM_ID = '25eTdotdeY9EqfJy5tfXSAD5Dg8XTL29sQYVgz1tJkTM';
CHADBUFFER_PROGRAM_ID = '6VrJmWbhN9WbEkg87JizunVMpL6CHKGVmzWCf3o3LRgy';

// Merkle tree
TREE_DEPTH = 16;
MAX_LEAVES = 2 ** 20;  // ~1 million

// Cryptography
BN254_FIELD_PRIME = 21888...;  // BN254 scalar field
BABYJUB_ORDER = 27360...;     // Baby Jubjub subgroup order
```

---

## Error Handling

```typescript
try {
  await claimNote(config, claimLink);
} catch (error) {
  if (error.message.includes('Nullifier already')) {
    console.log('Note already claimed');
  } else if (error.message.includes('Invalid proof')) {
    console.log('Proof verification failed');
  } else if (error.message.includes('exceeds BN254 field prime')) {
    console.log('Input value out of range');
  }
}
```

---

## Bun Compatibility

snarkjs WASM hangs in Bun. The SDK automatically detects Bun and uses a Node.js subprocess for proof generation:

```typescript
// Automatic — no user action needed
const proof = await generateClaimProof(inputs);
// In Bun: spawns Node.js subprocess
// In Node.js/Browser: uses snarkjs directly
```

---

## Related Documentation

- [Technical Deep Dive](./TECHNICAL.md) - Architecture and cryptography
- [Main README](../README.md) - Project overview
