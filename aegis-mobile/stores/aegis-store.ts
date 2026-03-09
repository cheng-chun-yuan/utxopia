import { create } from "zustand";
import {
  initPoseidon,
  deriveKeysFromSeedCircuit,
  createStealthMetaAddress,
  encodeStealthMetaAddress,
  type AegisKeys,
  type StealthMetaAddress,
} from "@aegis/sdk";
import {
  storeSerializedKeys,
  loadSerializedKeys,
  clearAll as clearSecureStore,
} from "@/lib/storage";

// ============================================================================
// Key Serialization (for SecureStore persistence)
// ============================================================================

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

function serializeKeys(keys: AegisKeys): string {
  return JSON.stringify({
    eddsaSeedHex: bytesToHex(keys.eddsaSeed),
    spendingPrivKeyHex: keys.spendingPrivKey.toString(16),
    nullifyingKeyHex: keys.nullifyingKey.toString(16),
    viewingPrivKeyHex: bytesToHex(keys.viewingPrivKey),
    viewingPubKeyHex: bytesToHex(keys.viewingPubKey),
    spendingPubKeyX: keys.spendingPubKey.x.toString(),
    spendingPubKeyY: keys.spendingPubKey.y.toString(),
  });
}

function deserializeKeys(json: string): AegisKeys {
  const data = JSON.parse(json);
  return {
    solanaPublicKey: new Uint8Array(32),
    spendingPrivKey: BigInt("0x" + data.spendingPrivKeyHex),
    spendingPubKey: {
      x: BigInt(data.spendingPubKeyX),
      y: BigInt(data.spendingPubKeyY),
    },
    nullifyingKey: BigInt("0x" + data.nullifyingKeyHex),
    viewingPrivKey: hexToBytes(data.viewingPrivKeyHex),
    viewingPubKey: hexToBytes(data.viewingPubKeyHex),
    eddsaSeed: hexToBytes(data.eddsaSeedHex),
  };
}

// ============================================================================
// Types
// ============================================================================

export interface InboxNote {
  commitment: string;
  amount: number;
  leafIndex: number;
  timestamp: number;
  spent: boolean;
}

interface AegisState {
  // Auth
  isInitialized: boolean;
  keys: AegisKeys | null;
  stealthMeta: StealthMetaAddress | null;
  stealthAddress: string | null;
  isLoading: boolean;
  error: string | null;

  // Inbox
  inboxNotes: InboxNote[];

  // Actions
  deriveKeysFromSeed: (seed: Uint8Array) => Promise<void>;
  hydrateFromStorage: () => Promise<boolean>;
  refreshInbox: () => Promise<void>;
  logout: () => void;
}

// ============================================================================
// Store
// ============================================================================

let poseidonInitialized = false;

async function ensurePoseidon(): Promise<void> {
  if (!poseidonInitialized) {
    await initPoseidon();
    poseidonInitialized = true;
  }
}

export const useAegisStore = create<AegisState>((set, get) => ({
  // Initial state
  isInitialized: false,
  keys: null,
  stealthMeta: null,
  stealthAddress: null,
  isLoading: false,
  error: null,
  inboxNotes: [],

  deriveKeysFromSeed: async (seed: Uint8Array) => {
    set({ isLoading: true, error: null });
    try {
      await ensurePoseidon();

      const keys = await deriveKeysFromSeedCircuit(seed);
      const meta = createStealthMetaAddress(keys);
      const encoded = encodeStealthMetaAddress(meta);

      // Persist keys to SecureStore (already encrypted at OS level)
      await storeSerializedKeys(serializeKeys(keys));

      set({
        keys,
        stealthMeta: meta,
        stealthAddress: encoded,
        isInitialized: true,
        isLoading: false,
      });
    } catch (err) {
      set({
        error:
          err instanceof Error
            ? err.message
            : "Failed to derive keys from seed",
        isLoading: false,
      });
    }
  },

  hydrateFromStorage: async () => {
    try {
      const json = await loadSerializedKeys();
      if (!json) return false;

      await ensurePoseidon();

      const keys = deserializeKeys(json);
      const meta = createStealthMetaAddress(keys);
      const encoded = encodeStealthMetaAddress(meta);

      set({
        keys,
        stealthMeta: meta,
        stealthAddress: encoded,
        isInitialized: true,
      });
      return true;
    } catch {
      return false;
    }
  },

  refreshInbox: async () => {
    // Stub — will be implemented with AnnouncementClient later
    const { keys } = get();
    if (!keys) {
      set({ inboxNotes: [] });
      return;
    }
    // TODO: Fetch announcements and scan for owned notes
  },

  logout: () => {
    clearSecureStore();
    poseidonInitialized = false;
    set({
      keys: null,
      stealthMeta: null,
      stealthAddress: null,
      isInitialized: false,
      error: null,
      inboxNotes: [],
    });
  },
}));
