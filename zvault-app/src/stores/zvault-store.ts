"use client";

import { create } from "zustand";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  initPoseidon,
  deriveKeysFromWallet,
  createStealthMetaAddress,
  encodeStealthMetaAddress,
  scanUnifiedNotes,
  hexToBytes,
  computeNullifierHashForNote,
  deriveNullifierRecordPDA,
  DEVNET_CONFIG,
  type ZVaultKeys,
  type StealthMetaAddress,
  type ScannedNote,
} from "@zvault/sdk";

// ============================================================================
// localStorage Key Persistence (devnet only)
// ============================================================================

const KEYS_STORAGE_PREFIX = "zvault:keys_v2:";

function bytesToHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytesLocal(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

function persistKeys(walletPubkey: string, keys: ZVaultKeys): void {
  try {
    const data = {
      eddsaSeedHex: bytesToHexLocal(keys.eddsaSeed),
      spendingPrivKeyHex: keys.spendingPrivKey.toString(16),
      nullifyingKeyHex: keys.nullifyingKey.toString(16),
      viewingPrivKeyHex: bytesToHexLocal(keys.viewingPrivKey),
      viewingPubKeyHex: bytesToHexLocal(keys.viewingPubKey),
      spendingPubKeyX: keys.spendingPubKey.x.toString(),
      spendingPubKeyY: keys.spendingPubKey.y.toString(),
    };
    localStorage.setItem(KEYS_STORAGE_PREFIX + walletPubkey, JSON.stringify(data));
  } catch {
    // localStorage may be unavailable
  }
}

function loadKeys(walletPubkey: string, solanaPublicKey: Uint8Array): ZVaultKeys | null {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE_PREFIX + walletPubkey);
    if (!raw) return null;
    const data = JSON.parse(raw);

    // Restore spendingPubKey from stored coordinates (avoids calling circomlibjs WASM)
    const spendingPubKey = {
      x: BigInt(data.spendingPubKeyX),
      y: BigInt(data.spendingPubKeyY),
    };

    return {
      solanaPublicKey,
      spendingPrivKey: BigInt("0x" + data.spendingPrivKeyHex),
      spendingPubKey,
      nullifyingKey: BigInt("0x" + data.nullifyingKeyHex),
      viewingPrivKey: hexToBytesLocal(data.viewingPrivKeyHex),
      viewingPubKey: hexToBytesLocal(data.viewingPubKeyHex),
      eddsaSeed: hexToBytesLocal(data.eddsaSeedHex),
    };
  } catch {
    return null;
  }
}

function removeKeys(walletPubkey: string): void {
  try {
    localStorage.removeItem(KEYS_STORAGE_PREFIX + walletPubkey);
  } catch {
    // ignore
  }
}

// Module-level deduplication for inbox fetch
let inboxFetchPromise: Promise<void> | null = null;

// Cache last announcement count to skip re-scan when nothing changed
let lastAnnouncementCount = -1;
let lastAnnouncementCachedAt = 0;

// ============================================================================
// Types
// ============================================================================

export interface InboxNote extends ScannedNote {
  id: string;
  createdAt: number;
  commitmentHex: string;
  /** True if nullifier exists on-chain (note has been spent) */
  isSpent?: boolean;
}

export type WithdrawalStatus = "pending" | "processing" | "broadcasting" | "confirmed" | "failed";

export interface ActiveWithdrawal {
  id: string;
  amountSats: bigint;
  btcAddress: string;
  status: WithdrawalStatus;
  solanaSignature?: string;
  btcTxid?: string;
  createdAt: number;
  updatedAt: number;
}

interface ZVaultState {
  // Poseidon
  isPoseidonReady: boolean;

  // Keys
  keys: ZVaultKeys | null;
  stealthAddress: StealthMetaAddress | null;
  stealthAddressEncoded: string | null;
  isLoading: boolean;
  error: string | null;
  hasKeys: boolean;

  // Inbox
  inboxNotes: InboxNote[];
  inboxTotalSats: bigint;
  inboxDepositCount: number;
  inboxLoading: boolean;
  inboxError: string | null;

  // Withdrawals
  activeWithdrawals: ActiveWithdrawal[];

  // Actions
  initPoseidon: () => Promise<void>;
  deriveKeys: (wallet: {
    publicKey: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  }) => Promise<void>;
  hydrateKeys: (walletPubkey: PublicKey) => boolean;
  clearKeys: (walletPubkey?: string) => void;
  refreshInbox: (connection?: Connection) => Promise<void>;
  submitWithdrawal: (withdrawal: Omit<ActiveWithdrawal, "id" | "createdAt" | "updatedAt">) => string;
  updateWithdrawal: (id: string, update: Partial<ActiveWithdrawal>) => void;
}

// ============================================================================
// Store
// ============================================================================

export const useZVaultStore = create<ZVaultState>((set, get) => ({
  // Initial state
  isPoseidonReady: false,
  keys: null,
  stealthAddress: null,
  stealthAddressEncoded: null,
  isLoading: false,
  error: null,
  hasKeys: false,
  inboxNotes: [],
  inboxTotalSats: 0n,
  inboxDepositCount: 0,
  inboxLoading: false,
  inboxError: null,
  activeWithdrawals: [],

  initPoseidon: async () => {
    try {
      await initPoseidon();
      set({ isPoseidonReady: true });
    } catch (err) {
      console.error("[ZVault] Failed to init Poseidon:", err);
    }
  },

  deriveKeys: async (wallet) => {
    set({ isLoading: true, error: null });

    try {
      const derivedKeys = await deriveKeysFromWallet({
        publicKey: wallet.publicKey,
        signMessage: wallet.signMessage,
      });

      const meta = createStealthMetaAddress(derivedKeys);
      const encoded = encodeStealthMetaAddress(meta);

      // Persist to localStorage for session hydration
      persistKeys(wallet.publicKey.toBase58(), derivedKeys);

      set({
        keys: derivedKeys,
        stealthAddress: meta,
        stealthAddressEncoded: encoded,
        hasKeys: true,
        isLoading: false,
      });
    } catch (err) {
      if (err instanceof Error) {
        const isUserRejection =
          err.name === "WalletSignMessageError" ||
          err.message.includes("User rejected") ||
          err.message.includes("user rejected");

        if (isUserRejection) {
          set({ isLoading: false });
          return;
        }

        if (err.message.includes("Internal JSON-RPC")) {
          set({ error: "Wallet error - please try reconnecting", isLoading: false });
        } else {
          set({ error: err.message, isLoading: false });
        }
      } else {
        set({ error: "Failed to derive keys", isLoading: false });
      }
    }
  },

  hydrateKeys: (walletPubkey: PublicKey) => {
    const pubkeyStr = walletPubkey.toBase58();
    const restored = loadKeys(pubkeyStr, walletPubkey.toBytes());
    if (!restored) return false;

    const meta = createStealthMetaAddress(restored);
    const encoded = encodeStealthMetaAddress(meta);

    set({
      keys: restored,
      stealthAddress: meta,
      stealthAddressEncoded: encoded,
      hasKeys: true,
    });
    return true;
  },

  clearKeys: (walletPubkey?: string) => {
    if (walletPubkey) {
      removeKeys(walletPubkey);
    }
    set({
      keys: null,
      stealthAddress: null,
      stealthAddressEncoded: null,
      error: null,
      hasKeys: false,
      inboxNotes: [],
      inboxTotalSats: 0n,
      inboxDepositCount: 0,
      inboxError: null,
    });
  },

  refreshInbox: async (_connection) => {
    const { keys } = get();
    if (!keys) {
      set({ inboxNotes: [], inboxTotalSats: 0n, inboxDepositCount: 0 });
      return;
    }

    // Deduplicate: if already fetching, wait for that to complete
    if (inboxFetchPromise) {
      return inboxFetchPromise;
    }

    set({ inboxLoading: true, inboxError: null });

    const doFetch = async () => {
      try {
        // Fetch from cached API instead of direct RPC
        const response = await fetch("/api/stealth/announcements");
        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || "Failed to fetch announcements");
        }

        // Skip re-scan if announcements haven't changed (same count + same cache timestamp)
        const currentNotes = get().inboxNotes;
        if (
          data.count === lastAnnouncementCount &&
          data.cachedAt === lastAnnouncementCachedAt &&
          currentNotes.length > 0
        ) {
          set({ inboxLoading: false });
          return;
        }
        lastAnnouncementCount = data.count;
        lastAnnouncementCachedAt = data.cachedAt;

        // Convert API response to scan format (includes announcementType for unified scanning)
        const announcements = data.announcements.map((ann: {
          announcementType: number;
          ephemeralPub: string;
          encryptedAmount: string;
          commitment: string;
          leafIndex: number;
          createdAt: string;
        }) => ({
          announcementType: ann.announcementType,
          ephemeralPub: hexToBytes(ann.ephemeralPub),
          encryptedAmount: hexToBytes(ann.encryptedAmount),
          commitment: hexToBytes(ann.commitment),
          leafIndex: ann.leafIndex,
          createdAt: Number(ann.createdAt),
        }));

        // Scan locally for privacy (server doesn't know which are ours)
        const scanned = await scanUnifiedNotes(keys, announcements);

        // Check which notes are spent — batch all nullifier PDAs into a single getMultipleAccounts RPC call
        const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.devnet.solana.com";

        // Pre-compute all nullifier PDAs
        const nullifierData = await Promise.all(
          scanned.map(async (note) => {
            const nullifierHashBytes = computeNullifierHashForNote(keys, note);
            const [nullifierPda] = await deriveNullifierRecordPDA(
              nullifierHashBytes,
              DEVNET_CONFIG.zvaultProgramId
            );
            return { note, nullifierPda: nullifierPda.toString() };
          })
        );

        // Single batched RPC call for all nullifier checks
        let notesWithSpentStatus: (ScannedNote & { isSpent: boolean })[];
        if (nullifierData.length === 0) {
          notesWithSpentStatus = [];
        } else {
          try {
            const response = await fetch(rpcUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getMultipleAccounts",
                params: [
                  nullifierData.map(d => d.nullifierPda),
                  { encoding: "base64" },
                ],
              }),
            });
            const result = await response.json();
            const accountValues: (null | object)[] = result?.result?.value || [];

            notesWithSpentStatus = nullifierData.map((d, i) => ({
              ...d.note,
              isSpent: accountValues[i] !== null,
            }));
          } catch (err) {
            console.error("[ZVault] Batch nullifier check failed, falling back:", err);
            notesWithSpentStatus = scanned.map(note => ({ ...note, isSpent: false }));
          }
        }

        const notes: InboxNote[] = notesWithSpentStatus.map((note, index) => {
          const originalAnn = announcements.find((a: { commitment: Uint8Array }) =>
            Buffer.from(a.commitment).equals(Buffer.from(note.commitment))
          );

          // Convert commitment bytes to hex (big-endian bytes to hex string)
          // This should match bigint.toString(16).padStart(64, "0")
          const rawHex = Buffer.from(note.commitment).toString("hex");
          // Ensure proper padding and lowercase
          const commitmentHex = rawHex.toLowerCase().padStart(64, "0");

          return {
            ...note,
            id: `${commitmentHex.slice(0, 16)}-${index}`,
            createdAt: originalAnn?.createdAt
              ? originalAnn.createdAt * 1000
              : Date.now(),
            commitmentHex,
          };
        });

        notes.sort((a, b) => b.createdAt - a.createdAt);

        // Calculate balance only from unspent notes
        const unspentNotes = notes.filter(n => !n.isSpent);
        const totalSats = unspentNotes.reduce(
          (sum, note) => sum + BigInt(note.amount ?? 0),
          0n
        );

        set({
          inboxNotes: notes, // Keep all notes for display (show spent as disabled)
          inboxTotalSats: totalSats,
          inboxDepositCount: unspentNotes.length, // Only count unspent
          inboxLoading: false,
        });
      } catch (err) {
        console.error("[ZVault] Inbox error:", err);
        set({
          inboxError: err instanceof Error ? err.message : "Failed to fetch inbox",
          inboxLoading: false,
        });
      } finally {
        inboxFetchPromise = null;
      }
    };

    inboxFetchPromise = doFetch();
    return inboxFetchPromise;
  },

  submitWithdrawal: (withdrawal) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const newWithdrawal: ActiveWithdrawal = {
      ...withdrawal,
      id,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({
      activeWithdrawals: [...state.activeWithdrawals, newWithdrawal],
    }));
    return id;
  },

  updateWithdrawal: (id, update) => {
    set((state) => ({
      activeWithdrawals: state.activeWithdrawals.map((w) =>
        w.id === id ? { ...w, ...update, updatedAt: Date.now() } : w
      ),
    }));
  },
}));

// ============================================================================
// Convenience Hooks (backwards compatible)
// ============================================================================

export function useZVault() {
  return useZVaultStore();
}

export function useZVaultKeys() {
  const store = useZVaultStore();
  return {
    keys: store.keys,
    stealthAddress: store.stealthAddress,
    stealthAddressEncoded: store.stealthAddressEncoded,
    isLoading: store.isLoading,
    error: store.error,
    deriveKeys: store.deriveKeys,
    clearKeys: store.clearKeys,
    hasKeys: store.hasKeys,
  };
}

export function useStealthInbox() {
  const store = useZVaultStore();
  return {
    notes: store.inboxNotes,
    totalAmountSats: store.inboxTotalSats,
    depositCount: store.inboxDepositCount,
    isLoading: store.inboxLoading,
    error: store.inboxError,
    refresh: store.refreshInbox,
    hasKeys: store.hasKeys,
  };
}
