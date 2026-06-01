# @utxopia/sdk

TypeScript SDK for interacting with the UTXOpia protocol - a privacy-preserving Bitcoin-to-Solana bridge using Zero-Knowledge Proofs.

## Installation

```bash
bun add @utxopia/sdk
# or
npm install @utxopia/sdk
```

## Quick Start

```typescript
import {
  deriveKeysFromWallet,
  createStealthDeposit,
  scanAnnouncements,
  resolveSnsName,
} from '@utxopia/sdk';

// 1. Derive keys from wallet
const keys = await deriveKeysFromWallet(walletAdapter);

// 2. Look up recipient by .utxopia.sol name
const recipient = await resolveSnsName(connection, 'alice');

// 3. Create stealth deposit
const deposit = await createStealthDeposit(recipient, 100000n);

// 4. Scan for incoming deposits
const notes = await scanAnnouncements(keys, announcements);
```

## Core Features

### Key Derivation

Derive spending and viewing keys from a Solana wallet signature (RAILGUN-style):

```typescript
import { deriveKeysFromWallet, type UTXOpiaKeys } from '@utxopia/sdk';

const keys: UTXOpiaKeys = await deriveKeysFromWallet(walletAdapter);
// keys.spendingPubKey - for receiving funds
// keys.viewingPubKey  - for scanning deposits
// keys.spendingPrivKey - for claiming (keep secret!)
// keys.viewingPrivKey  - for scanning (can delegate)
```

### Stealth Addresses (EIP-5564/DKSAP Pattern)

Create private deposits that only the recipient can detect and claim:

```typescript
import {
  createStealthDeposit,
  scanAnnouncements,
  prepareClaimInputs,
} from '@utxopia/sdk';

// Sender: Create stealth deposit
const deposit = await createStealthDeposit(recipientMeta, amountSats);
// deposit.ephemeralPub - publish on-chain
// deposit.commitment   - add to Merkle tree
// deposit.amountSats   - verified BTC amount

// Recipient: Scan for deposits
const notes = await scanAnnouncements(keys, onChainAnnouncements);

// Recipient: Prepare claim inputs for ZK proof
const claimInputs = await prepareClaimInputs(keys, note, merkleProof);
```

### Demo Instructions (Testing/Development)

Add mock deposits without real BTC for testing:

```typescript
import {
  buildAddDemoNoteData,
  buildAddDemoStealthData,
  getPoolStatePDASeeds,
  getCommitmentTreePDASeeds,
  DEMO_INSTRUCTION,
} from '@utxopia/sdk';

// Build demo note instruction data
const noteData = buildAddDemoNoteData(secret); // 32-byte secret

// Build demo stealth instruction data
const stealthData = buildAddDemoStealthData(
  ephemeralPub,  // 32 bytes (Ed25519)
  commitment,    // 32 bytes
  amountSats     // bigint
);

// Get PDA seeds for instruction construction
const { seeds: poolSeeds } = getPoolStatePDASeeds();
const { seeds: treeSeeds } = getCommitmentTreePDASeeds();
```

### Note Generation

Create and manage shielded notes:

```typescript
import {
  generateNote,
  deriveNote,
  createClaimLink,
  parseClaimLink,
} from '@utxopia/sdk';

// Generate random note
const note = generateNote(100000n);

// Derive deterministic note from seed
const note = deriveNote('my-secret-phrase', 0, 100000n);

// Create shareable claim link
const link = createClaimLink(note);

// Parse claim link
const parsed = parseClaimLink(link);
```

### Taproot Address Derivation

Generate BTC deposit addresses:

```typescript
import { deriveTaprootAddress, verifyTaprootAddress } from '@utxopia/sdk';

// Derive taproot address from commitment
const address = deriveTaprootAddress(commitment, 'testnet');

// Verify address matches commitment
const isValid = verifyTaprootAddress(address, commitment, 'testnet');
```

### Merkle Proofs

Work with the on-chain commitment tree:

```typescript
import {
  createMerkleProof,
  proofToNoirFormat,
  TREE_DEPTH,
} from '@utxopia/sdk';

const proof = createMerkleProof(leaves, leafIndex);
const noirProof = proofToNoirFormat(proof);
```

## API Reference

### Stealth Module

| Function | Description |
|----------|-------------|
| `createStealthDeposit(recipient, amount)` | Create stealth deposit for recipient |
| `scanAnnouncements(keys, announcements)` | Scan for deposits using viewing key |
| `prepareClaimInputs(keys, note, proof)` | Prepare inputs for ZK claim proof |
| `scanUnifiedNotes(keys, announcements)` | Scan announcement events for owned notes |
| `resolveSnsName(conn, name)` | Look up .utxopia.sol name to stealth address |

### Demo Module

| Function | Description |
|----------|-------------|
| `buildAddDemoNoteData(secret)` | Build demo note instruction data |
| `buildAddDemoStealthData(ephemeral, commit, amount)` | Build demo stealth data |
| `getPoolStatePDASeeds()` | Get pool state PDA seeds |
| `getCommitmentTreePDASeeds()` | Get commitment tree PDA seeds |
| `parseProgramEvents(logs)` | Parse sol_log_data events from tx logs |
| `getDemoNoteAccountMetas()` | Get account metas for demo note |
| `getDemoStealthAccountMetas()` | Get account metas for demo stealth |

### Key Derivation Module

| Function | Description |
|----------|-------------|
| `deriveKeysFromWallet(wallet)` | Derive keys from wallet signature |
| `deriveKeysFromSignature(sig)` | Derive keys from raw signature |
| `deriveKeysFromSeed(seed)` | Derive keys from seed bytes |
| `createStealthMetaAddress(keys)` | Create stealth meta-address |
| `createDelegatedViewKey(keys, perms, expiry)` | Create delegated view key |

### Constants

```typescript
// Program IDs
UTXOPIA_PROGRAM_ID        // Main UTXOpia program (devnet)
CHADBUFFER_PROGRAM_ID    // ChadBuffer for SPV proofs

// Merkle Tree
TREE_DEPTH              // 20
MAX_LEAVES              // 2^20
ZERO_VALUE              // Empty leaf value

// Demo Instructions
DEMO_INSTRUCTION.ADD_DEMO_NOTE    // 21
DEMO_INSTRUCTION.ADD_DEMO_STEALTH // 22
```

## Types

### UTXOpiaKeys

```typescript
interface UTXOpiaKeys {
  spendingPubKey: BabyJubPoint;
  spendingPrivKey: bigint;
  viewingPubKey: Uint8Array;
  viewingPrivKey: Uint8Array;
  nullifyingKey: bigint;
}
```

### StealthDeposit

```typescript
interface StealthDeposit {
  ephemeralPub: Uint8Array;  // 32 bytes (Ed25519)
  amountSats: bigint;
  commitment: Uint8Array;    // 32 bytes
  createdAt: number;
}
```

### ScannedNote

```typescript
interface ScannedNote {
  amount: bigint;
  ephemeralPub: Uint8Array;
  stealthPub: BabyJubPoint;
  leafIndex: number;
  commitment: Uint8Array;
}
```

### ConnectionAdapter

```typescript
interface ConnectionAdapter {
  getAccountInfo: (
    pubkey: { toBytes(): Uint8Array }
  ) => Promise<{ data: Uint8Array } | null>;
}
```

## Security Considerations

1. **Never expose spending private key** - Only needed for claiming
2. **Viewing key can be delegated** - For balance monitoring without spend capability
3. **Nullifiers prevent double-spending** - Derived from spending key + leaf index
4. **Commitments hide amounts** - Poseidon hash of NPK, token, and amount

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run tests
bun test
```

## License

MIT
