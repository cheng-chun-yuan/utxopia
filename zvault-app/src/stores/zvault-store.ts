"use client";

import { create } from "zustand";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  initPoseidon,
  deriveKeysFromWallet,
  createStealthMetaAddress,
  encodeStealthMetaAddress,
  scanAnnouncements,
  hexToBytes,
  computeNullifierHashForNote,
  deriveNullifierRecordPDA,
  DEVNET_CONFIG,
  type ZVaultKeys,
  type StealthMetaAddress,
  type ScannedNote,
} from "@zvault/sdk";

// Module-level deduplication for inbox fetch
let inboxFetchPromise: Promise<void> | null = null;

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

  // Actions
  initPoseidon: () => Promise<void>;
  deriveKeys: (wallet: {
    publicKey: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  }) => Promise<void>;
  clearKeys: () => void;
  refreshInbox: (connection?: Connection) => Promise<void>;
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

  clearKeys: () => {
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

        // Convert API response to scan format
        const announcements = data.announcements.map((ann: {
          ephemeralPub: string;
          encryptedAmount: string;
          commitment: string;
          leafIndex: number;
          createdAt: string;
        }) => ({
          ephemeralPub: hexToBytes(ann.ephemeralPub),
          encryptedAmount: hexToBytes(ann.encryptedAmount),
          commitment: hexToBytes(ann.commitment),
          leafIndex: ann.leafIndex,
          createdAt: BigInt(ann.createdAt),
        }));

        // Scan locally for privacy (server doesn't know which are ours)
        const scanned = await scanAnnouncements(keys, announcements);

        // Check which notes are spent by looking up nullifier records on-chain
        const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.devnet.solana.com";
        const notesWithSpentStatus = await Promise.all(
          scanned.map(async (note) => {
            try {
              // Compute nullifier hash (requires spending key)
              const nullifierHashBytes = computeNullifierHashForNote(keys, note);
              const nullifierHex = Buffer.from(nullifierHashBytes).toString("hex");

              // Derive nullifier PDA
              const [nullifierPda] = await deriveNullifierRecordPDA(
                nullifierHashBytes,
                DEVNET_CONFIG.zvaultProgramId
              );

              // Check if PDA exists (note was spent)
              const response = await fetch(rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "getAccountInfo",
                  params: [nullifierPda, { encoding: "base64" }],
                }),
              });
              const result = await response.json();
              const isSpent = result?.result?.value !== null;

              console.log(`[ZVault] Nullifier check for leafIndex=${note.leafIndex}: PDA=${nullifierPda}, isSpent=${isSpent}, nullifierHash=${nullifierHex.slice(0, 16)}...`);

              return { ...note, isSpent };
            } catch (err) {
              console.error("[ZVault] Failed to check nullifier for note:", err, "leafIndex:", note.leafIndex);
              return { ...note, isSpent: false };
            }
          })
        );

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
              ? Number(originalAnn.createdAt) * 1000
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
