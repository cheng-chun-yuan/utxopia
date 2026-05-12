# UTXOpiaClient Design

## Goal

Create a high-level `UTXOpiaClient` class in the SDK that encapsulates config, keys, and connection state. Frontend calls simple methods instead of chaining low-level SDK functions.

## Before / After

### Before (current frontend)
```typescript
import { getConfig, computeTokenId, createStealthOutputWithKeys,
         hexToBytes, bytesToHex, initPoseidon, scanUnifiedNotes,
         prepareClaimInputs, parseMerkleProofResponse } from "@utxopia/sdk";
import { getUTXOpiaProgramId, derivePoolStatePDA } from "@/lib/solana/pdas";

// 15 imports, manual wiring everywhere
const config = getConfig();
const programId = new PublicKey(config.privacyCoinProgramId);
const tokenId = computeTokenId(mintPubkey.toBuffer());
const output = await createStealthOutputWithKeys(keys, amount, tokenId);
// ... 50 more lines
```

### After (with UTXOpiaClient)
```typescript
import { UTXOpiaClient } from "@utxopia/sdk";

const client = UTXOpiaClient.instance(); // singleton, already initialized
const preview = await client.prepareDeposit("BTC", 50000);
const result = await client.executeDeposit(preview);
const balance = await client.getBalance();
```

## API Design

```typescript
class UTXOpiaClient {
  // ─── Lifecycle ────────────────────────────────────
  static async init(opts: { network: "devnet" | "localnet" | "mainnet" }): Promise<UTXOpiaClient>;
  static instance(): UTXOpiaClient; // get initialized singleton

  // ─── Auth ─────────────────────────────────────────
  async loginWithWallet(wallet: WalletSignerAdapter): Promise<KeySetupResult>;
  async loginWithSeed(seed: Uint8Array): Promise<KeySetupResult>;
  get keys(): UTXOpiaKeys | null;
  get stealthAddress(): StealthMetaAddress | null;
  get stealthAddressEncoded(): string | null;
  get isAuthenticated(): boolean;
  logout(): void;

  // ─── Balance ──────────────────────────────────────
  async getBalance(): Promise<Map<string, bigint>>; // token → unspent sats
  async getNotes(): Promise<InboxNote[]>;            // all unspent notes
  async refreshNotes(): Promise<void>;

  // ─── Deposit (BTC → zkBTC) ────────────────────────
  async prepareDeposit(opts: {
    amount: number;          // sats
    recipient?: string;      // stealth address (default: self)
  }): Promise<DepositPreview>;

  // ─── Shield (SPL → shielded) ──────────────────────
  async prepareShield(opts: {
    token: string;           // "SOL" | "USDC" | "USDT" | "BTC"
    amount: number;          // raw units
    recipient?: string;      // stealth address (default: self)
  }): Promise<{ npkBytes: Uint8Array; ephemeralPub: Uint8Array; tokenId: bigint; ... }>;

  // ─── Transfer (shielded → shielded) ───────────────
  async prepareTransfer(opts: {
    outputs: Array<{ to: string; amount: number; mode: "stealth" | "public" | "btc" }>;
    token?: string;
  }): Promise<TransferPayload>;
  async executeTransfer(payload: TransferPayload): Promise<{ txSignature: string }>;

  // ─── Token Registry ───────────────────────────────
  getTokenId(mint: string): bigint;
  getTokenId(symbol: string): bigint;

  // ─── Internals (accessible but not primary API) ───
  get config(): NetworkConfig;
  get programId(): PublicKey;
  get zkbtcMint(): PublicKey;
}
```

## Implementation Approach

### Phase 1 (this PR): Core client + auth + balance
- `UTXOpiaClient.init()` — calls `initConfig()`, `initPoseidon()`, caches config
- `loginWithWallet()` / `loginWithSeed()` — wraps `setupKeysFromWallet/Seed`
- `getBalance()` / `getNotes()` — wraps the scanning logic from utxopia-store
- `getTokenId()` — wraps `computeTokenId` with caching
- Singleton pattern with `instance()`

### Phase 2 (next PR): Deposit + Shield
- `prepareDeposit()` — wraps `createDepositFromConfig` + UTXO selection
- `prepareShield()` — wraps stealth output + token config + instruction building

### Phase 3 (later): Transfer + Relay
- `prepareTransfer()` — wraps the entire pay-flow proof pipeline
- `executeTransfer()` — wraps relay API submission

## File Location

```
sdk/src/client.ts    ← UTXOpiaClient class
sdk/src/index.ts     ← export { UTXOpiaClient }
```

## Frontend Migration

After `UTXOpiaClient` exists, the frontend migration is:
1. `utxopia-store.ts` replaces `initPoseidon + setupKeysFromWallet + scanUnifiedNotes` with `client.loginWithWallet() + client.getNotes()`
2. `shield-flow.tsx` replaces `computeTokenId + createStealthOutputWithKeys + PDA derivation` with `client.prepareShield()`
3. `use-btc-deposit.ts` replaces `createDepositFromConfig` with `client.prepareDeposit()`
4. Eventually `pay-flow.tsx` replaces 200 lines of proof building with `client.prepareTransfer()`

## What stays outside the client

- React hooks (`useUTXOpia`, `useExplorer`, etc.) — these manage React state, not SDK state
- Zustand store — manages UI state (auth modal, loading flags)
- API routes — server-side, use low-level SDK directly
- PDA derivation — sync helpers needed by instruction builders
