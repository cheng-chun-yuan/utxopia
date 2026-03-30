"use client";

import { create } from "zustand";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  initPoseidon,
  deriveKeysFromWallet,
  deriveKeysFromSeedCircuit,
  createStealthMetaAddress,
  encodeStealthMetaAddress,
  scanUnifiedNotes,
  hexToBytes,
  bytesToHex,
  computeNullifierHashForNote,
  decodeViewOnlyKeys,
  scanAnnouncementsViewOnly,
  computeJoinSplitNullifierSync,
  bigintToBytes,
  computeTokenId,
  EventClient,
  getConfig,
  type AegisKeys,
  type StealthMetaAddress,
  type ViewOnlyKeys,
  type ScannedNote,
  type ViewOnlyScannedNote,
} from "@aegis/sdk";
import { fetchSpentNullifierPDAs, nullifierHashToPDA } from "@/lib/nullifier-utils";
import { getActiveTokenId } from "@/lib/token-context";
import { VAULT_TOKENS } from "@/lib/supported-tokens";
import { getBackendUrl, getSolanaRpcUrl } from "@/lib/api/constants";

// ============================================================================
// localStorage Key Persistence (AES-256-GCM encrypted)
// ============================================================================

const KEYS_STORAGE_PREFIX = "aegis:keys:";

async function deriveStorageKey(walletPubkey: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(walletPubkey + ":aegis-storage-key"),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("aegis-v4:" + walletPubkey), iterations: 600_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptData(key: CryptoKey, plaintext: string): Promise<string> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext),
  );
  // Store as iv(24 hex) + ciphertext(hex)
  return bytesToHex(iv) + bytesToHex(new Uint8Array(ciphertext));
}

async function decryptData(key: CryptoKey, encrypted: string): Promise<string> {
  const ivHex = encrypted.slice(0, 24);
  const ctHex = encrypted.slice(24);
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(ctHex);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

async function persistKeys(walletPubkey: string, keys: AegisKeys): Promise<void> {
  try {
    const data = {
      eddsaSeedHex: bytesToHex(keys.eddsaSeed),
      spendingPrivKeyHex: keys.spendingPrivKey.toString(16),
      nullifyingKeyHex: keys.nullifyingKey.toString(16),
      viewingPrivKeyHex: bytesToHex(keys.viewingPrivKey),
      viewingPubKeyHex: bytesToHex(keys.viewingPubKey),
      spendingPubKeyX: keys.spendingPubKey.x.toString(),
      spendingPubKeyY: keys.spendingPubKey.y.toString(),
    };
    const storageKey = await deriveStorageKey(walletPubkey);
    const encrypted = await encryptData(storageKey, JSON.stringify(data));
    localStorage.setItem(KEYS_STORAGE_PREFIX + walletPubkey, encrypted);
  } catch {
    // localStorage or Web Crypto may be unavailable
  }
}

async function loadKeys(walletPubkey: string, solanaPublicKey: Uint8Array): Promise<AegisKeys | null> {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE_PREFIX + walletPubkey);
    if (!raw) return null;

    const storageKey = await deriveStorageKey(walletPubkey);
    const decrypted = await decryptData(storageKey, raw);
    const data = JSON.parse(decrypted);

    const spendingPubKey = {
      x: BigInt(data.spendingPubKeyX),
      y: BigInt(data.spendingPubKeyY),
    };

    return {
      solanaPublicKey,
      spendingPrivKey: BigInt("0x" + data.spendingPrivKeyHex),
      spendingPubKey,
      nullifyingKey: BigInt("0x" + data.nullifyingKeyHex),
      viewingPrivKey: hexToBytes(data.viewingPrivKeyHex),
      viewingPubKey: hexToBytes(data.viewingPubKeyHex),
      eddsaSeed: hexToBytes(data.eddsaSeedHex),
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

// Singleton EventClient (extends AnnouncementClient with tree + nullifier events)
let eventClient: EventClient | null = null;

export function getEventClient(): EventClient {
  if (!eventClient) {
    const backendUrl = "";
    const wsBackendUrl = getBackendUrl();
    const wsUrl = wsBackendUrl.replace("http://", "ws://").replace("https://", "wss://");
    eventClient = new EventClient({
      backendUrl,
      backendWsUrl: wsUrl,
      solanaRpcUrl: getSolanaRpcUrl(),
      programId: getConfig().aegisProgramId,
      commitmentTreeAddress: getConfig().commitmentTreePda,
    });
  }
  return eventClient;
}

// ============================================================================
// Types
// ============================================================================

export interface InboxNote {
  amount: bigint;
  ephemeralPub: Uint8Array;
  leafIndex: number;
  commitment: Uint8Array;
  stealthPub?: { x: bigint; y: bigint };
  id: string;
  createdAt: number;
  commitmentHex: string;
  /** True if nullifier exists on-chain (note has been spent) */
  isSpent?: boolean;
  /** Token symbol this note belongs to (e.g. "zkBTC", "SOL") */
  tokenSymbol: string;
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

interface AegisState {
  // Poseidon
  isPoseidonReady: boolean;

  // Keys
  keys: AegisKeys | null;
  viewOnlyKeys: ViewOnlyKeys | null;
  isViewOnly: boolean;
  stealthAddress: StealthMetaAddress | null;
  stealthAddressEncoded: string | null;
  isLoading: boolean;
  error: string | null;
  hasKeys: boolean;

  // Inbox
  inboxNotes: InboxNote[];
  inboxTotalSats: bigint;
  /** Per-token unspent balances (keyed by token symbol, e.g. "zkBTC", "SOL") */
  inboxBalancesByToken: Record<string, bigint>;
  inboxDepositCount: number;
  inboxLoading: boolean;
  inboxError: string | null;

  // Public zkBTC balance (SPL Token-2022)
  publicZkbtcBalance: bigint;

  // Withdrawals
  activeWithdrawals: ActiveWithdrawal[];

  // Actions
  initPoseidon: () => Promise<void>;
  deriveKeys: (wallet: {
    publicKey: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  }) => Promise<void>;
  hydrateKeys: (walletPubkey: PublicKey) => Promise<boolean>;
  deriveKeysFromPasskeySeed: (seed: Uint8Array) => Promise<void>;
  hydratePasskeyKeys: () => Promise<boolean>;
  loadViewOnlyKeys: (encoded: string) => void;
  clearKeys: (walletPubkey?: string) => void;
  refreshInbox: (connection?: Connection, force?: boolean) => Promise<void>;
  startRealtimeInbox: () => () => void;
  refreshPublicBalance: (walletPubkey?: PublicKey) => Promise<void>;
  submitWithdrawal: (withdrawal: Omit<ActiveWithdrawal, "id" | "createdAt" | "updatedAt">) => string;
  updateWithdrawal: (id: string, update: Partial<ActiveWithdrawal>) => void;
}

// ============================================================================
// Store
// ============================================================================

export const useAegisStore = create<AegisState>((set, get) => ({
  // Initial state
  isPoseidonReady: false,
  keys: null,
  viewOnlyKeys: null,
  isViewOnly: false,
  stealthAddress: null,
  stealthAddressEncoded: null,
  isLoading: false,
  error: null,
  hasKeys: false,
  inboxNotes: [],
  inboxTotalSats: 0n,
  inboxBalancesByToken: {},
  inboxDepositCount: 0,
  inboxLoading: false,
  inboxError: null,
  publicZkbtcBalance: 0n,
  activeWithdrawals: [],

  initPoseidon: async () => {
    try {
      await initPoseidon();
      set({ isPoseidonReady: true });
    } catch (err) {
      console.error("[Aegis] Failed to init Poseidon:", err);
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

  hydrateKeys: async (walletPubkey: PublicKey) => {
    const pubkeyStr = walletPubkey.toBase58();
    const restored = await loadKeys(pubkeyStr, walletPubkey.toBytes());
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

  deriveKeysFromPasskeySeed: async (seed: Uint8Array) => {
    set({ isLoading: true, error: null });
    try {
      const derivedKeys = await deriveKeysFromSeedCircuit(seed);
      const meta = createStealthMetaAddress(derivedKeys);
      const encoded = encodeStealthMetaAddress(meta);

      // Persist with "passkey:" prefix
      const credentialId = typeof window !== "undefined"
        ? localStorage.getItem("aegis:passkey_credential_id") || "default"
        : "default";
      persistKeys("passkey:" + credentialId, derivedKeys);

      set({
        keys: derivedKeys,
        stealthAddress: meta,
        stealthAddressEncoded: encoded,
        hasKeys: true,
        isLoading: false,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to derive keys from passkey",
        isLoading: false,
      });
    }
  },

  hydratePasskeyKeys: async () => {
    try {
      const credentialId = typeof window !== "undefined"
        ? localStorage.getItem("aegis:passkey_credential_id")
        : null;
      if (!credentialId) return false;

      const restored = await loadKeys("passkey:" + credentialId, new Uint8Array(32));
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
    } catch {
      return false;
    }
  },

  loadViewOnlyKeys: (encoded: string) => {
    try {
      const voKeys = decodeViewOnlyKeys(encoded);
      set({
        keys: null,
        viewOnlyKeys: voKeys,
        isViewOnly: true,
        stealthAddress: null,
        stealthAddressEncoded: null,
        hasKeys: true,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Invalid viewing key" });
    }
  },

  clearKeys: (walletPubkey?: string) => {
    if (walletPubkey) {
      removeKeys(walletPubkey);
    }
    set({
      keys: null,
      viewOnlyKeys: null,
      isViewOnly: false,
      stealthAddress: null,
      stealthAddressEncoded: null,
      error: null,
      hasKeys: false,
      inboxNotes: [],
      inboxTotalSats: 0n,
      inboxBalancesByToken: {},
      inboxDepositCount: 0,
      inboxError: null,
      publicZkbtcBalance: 0n,
    });
  },

  refreshInbox: async (_connection, force) => {
    const { keys, viewOnlyKeys, isViewOnly } = get();
    if (!keys && !viewOnlyKeys) {
      set({ inboxNotes: [], inboxTotalSats: 0n, inboxBalancesByToken: {}, inboxDepositCount: 0 });
      return;
    }

    // Force flag resets the announcement count cache so we re-scan everything
    if (force) {
      lastAnnouncementCount = -1;
    }

    // Deduplicate: if already fetching, wait for that to complete
    if (inboxFetchPromise) {
      return inboxFetchPromise;
    }

    set({ inboxLoading: true, inboxError: null });

    const doFetch = async () => {
      try {
        // Fetch via EventClient (backend WS/REST → RPC fallback)
        const client = getEventClient();
        const announcements = await client.fetchAll();

        // Skip only the expensive scan step if announcement count is unchanged,
        // but ALWAYS re-check nullifiers (spent status may have changed)
        const currentNotes = get().inboxNotes;
        const announcementsUnchanged =
          announcements.length === lastAnnouncementCount && currentNotes.length > 0;
        lastAnnouncementCount = announcements.length;

        // Build token list with computed tokenIds for multi-token scanning
        const config = getConfig();
        const tokensToScan: { symbol: string; tokenId: bigint }[] = [];
        for (const token of VAULT_TOKENS) {
          try {
            let mintAddr = token.mint;
            if (!mintAddr && token.symbol === "zkBTC") mintAddr = config.zkbtcMint;
            if (!mintAddr) continue; // skip tokens without mint addresses
            const mintBytes = new PublicKey(mintAddr).toBytes();
            tokensToScan.push({ symbol: token.shieldedSymbol, tokenId: computeTokenId(mintBytes) });
          } catch { /* skip invalid mints */ }
        }

        // Scan locally for privacy (server doesn't know which are ours)
        // Re-use previous scan results if announcements unchanged (skip expensive decrypt),
        // but always re-check nullifier spent status below
        type ScannedWithToken = (ScannedNote | ViewOnlyScannedNote) & { tokenSymbol: string; isSpent?: boolean };
        let scanned: ScannedWithToken[];

        if (announcementsUnchanged) {
          scanned = currentNotes.map(n => ({
              commitment: hexToBytes(n.commitmentHex),
              amount: n.amount,
              leafIndex: n.leafIndex,
              ephemeralPub: n.ephemeralPub ?? new Uint8Array(32),
              blockTime: n.createdAt > 1_000_000_000_000
                ? Math.floor(n.createdAt / 1000)
                : (n.createdAt > 0 ? n.createdAt : 0),
              tokenSymbol: n.tokenSymbol,
            }));
        } else {
          // Scan for each token in parallel — each announcement is tried against all token IDs
          scanned = [];
          const seenLeaves = new Set<number>(); // Deduplicate across tokens
          for (const { symbol, tokenId } of tokensToScan) {
            const results = isViewOnly && viewOnlyKeys
              ? await scanAnnouncementsViewOnly(viewOnlyKeys, announcements, tokenId)
              : await scanUnifiedNotes(keys!, announcements, tokenId);
            for (const note of results) {
              if (!seenLeaves.has(note.leafIndex)) {
                seenLeaves.add(note.leafIndex);
                scanned.push({ ...note, tokenSymbol: symbol } as ScannedWithToken);
              }
            }
          }
        }

        // Check which notes are spent via backend batch nullifier API (use proxy)
        const backendUrl = "";

        const nullifyingKey = isViewOnly && viewOnlyKeys
          ? viewOnlyKeys.nullifyingKey
          : keys!.nullifyingKey;

        // Compute nullifier hashes (hex) for each note
        const nullifierData = scanned.map((note) => {
          const hashBytes = isViewOnly
            ? bigintToBytes(computeJoinSplitNullifierSync(nullifyingKey, BigInt(note.leafIndex)))
            : computeNullifierHashForNote(keys!, note as ScannedNote);
          const hashHex = Buffer.from(hashBytes).toString("hex");
          return { note, hashHex };
        });

        // Fetch spent nullifier PDAs (incremental sync) and match client-side for privacy
        let notesWithSpentStatus: (typeof scanned[number] & { isSpent: boolean })[];
        if (nullifierData.length === 0) {
          notesWithSpentStatus = [];
        } else {
          const spentPdas = await fetchSpentNullifierPDAs(backendUrl);
          notesWithSpentStatus = nullifierData.map((d) => ({
            ...d.note,
            isSpent: spentPdas.has(nullifierHashToPDA(d.hashHex)),
          }));
        }

        const notes: InboxNote[] = notesWithSpentStatus.map((note, index) => {
          // Convert commitment bytes to hex (big-endian bytes to hex string)
          const rawHex = Buffer.from(note.commitment).toString("hex");
          const commitmentHex = rawHex.toLowerCase().padStart(64, "0");

          return {
            ...note,
            id: `${commitmentHex.slice(0, 16)}-${index}`,
            createdAt: note.blockTime
              ? note.blockTime * 1000  // Convert seconds → ms
              : Date.now(),
            commitmentHex,
            tokenSymbol: note.tokenSymbol ?? "zkBTC",
          };
        });

        notes.sort((a, b) => b.createdAt - a.createdAt);

        // Calculate balance only from unspent notes
        const unspentNotes = notes.filter(n => !n.isSpent);
        const totalSats = unspentNotes.reduce(
          (sum, note) => sum + BigInt(note.amount ?? 0),
          0n
        );

        // Per-token balances
        const balancesByToken: Record<string, bigint> = {};
        for (const note of unspentNotes) {
          const sym = note.tokenSymbol;
          balancesByToken[sym] = (balancesByToken[sym] ?? 0n) + BigInt(note.amount ?? 0);
        }

        set({
          inboxNotes: notes,
          inboxTotalSats: totalSats,
          inboxBalancesByToken: balancesByToken,
          inboxDepositCount: unspentNotes.length,
          inboxLoading: false,
        });
      } catch (err) {
        console.error("[Aegis] Inbox error:", err);
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

  startRealtimeInbox: () => {
    const client = getEventClient();
    client.start().catch((err) => {
      console.warn("[Aegis] EventClient start failed:", err);
    });
    const unsub = client.onAnnouncement(() => {
      // New announcements arrived via WS — trigger inbox refresh
      const store = get();
      if (store.keys || store.viewOnlyKeys) {
        store.refreshInbox();
      }
    });
    return () => {
      unsub();
      client.close();
      eventClient = null;
    };
  },

  refreshPublicBalance: async (walletPubkey?: PublicKey) => {
    if (!walletPubkey) {
      set({ publicZkbtcBalance: 0n });
      return;
    }
    try {
      const rpcUrl = getSolanaRpcUrl();
      // Fetch token accounts for the zkBTC mint under Token-2022
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [
            walletPubkey.toBase58(),
            { mint: getConfig().zkbtcMint },
            { encoding: "jsonParsed", commitment: "confirmed" },
          ],
        }),
      });
      const result = await response.json();
      const accounts = result?.result?.value || [];
      let total = 0n;
      for (const acc of accounts) {
        const amount = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (amount) total += BigInt(amount);
      }
      set({ publicZkbtcBalance: total });
    } catch (err) {
      console.error("[Aegis] Failed to fetch public zkBTC balance:", err);
    }
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
// Convenience Hooks
// ============================================================================

export function useAegis() {
  return useAegisStore();
}

export function useAegisKeys() {
  const store = useAegisStore();
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
  const store = useAegisStore();
  return {
    notes: store.inboxNotes,
    totalAmountSats: store.inboxTotalSats,
    balancesByToken: store.inboxBalancesByToken,
    depositCount: store.inboxDepositCount,
    isLoading: store.inboxLoading,
    error: store.inboxError,
    refresh: store.refreshInbox,
    startRealtime: store.startRealtimeInbox,
    hasKeys: store.hasKeys,
  };
}
