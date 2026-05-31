"use client";

import { create } from "zustand";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  UTXOpiaClient,
  hexToBytes,
  bytesToHex,
  deserializeKeysFromStorage,
  scanUnifiedNotes,
  scanAnnouncementsViewOnly,
  decodeViewOnlyKeys,
  EventClient,
  type UTXOpiaKeys,
  type StealthMetaAddress,
  type ViewOnlyKeys,
  type ScannedNote,
  type ViewOnlyScannedNote,
  type OnChainStealthAnnouncement,
} from "@utxopia/sdk";
import { fetchSpentNullifierPDAs, nullifierHashToPDA } from "@/lib/nullifier-utils";
import { VAULT_TOKENS } from "@/lib/supported-tokens";
import { API_ENDPOINTS, getBackendUrl, getSolanaRpcUrl } from "@/lib/api/constants";
import { ensureChainEnvironment, getChainEnvironment } from "@/lib/chain-environment";
import type { NetworkConfig } from "@/lib/network-config";

// ============================================================================
// localStorage Key Persistence (AES-256-GCM encrypted)
// ============================================================================

const KEYS_STORAGE_PREFIX = "utxo:keys:";

async function deriveStorageKey(walletPubkey: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  // ":aegis-storage-key" and "aegis-v4:" are LOAD-BEARING KDF inputs — frozen
  // from the project's pre-rename era. Changing either breaks the AES-GCM
  // key that decrypts every existing user's persisted spending/viewing keys.
  // The project name is "UTXOpia", but these strings stay as-is.
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

async function persistKeys(walletPubkey: string, _keys: UTXOpiaKeys): Promise<void> {
  try {
    const client = UTXOpiaClient.instance();
    const data = client.serializeKeys();
    if (!data) return;
    const storageKey = await deriveStorageKey(walletPubkey);
    const encrypted = await encryptData(storageKey, JSON.stringify(data));
    localStorage.setItem(KEYS_STORAGE_PREFIX + walletPubkey, encrypted);
  } catch {
    // localStorage or Web Crypto may be unavailable
  }
}

async function loadKeys(walletPubkey: string, solanaPublicKey: Uint8Array): Promise<UTXOpiaKeys | null> {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE_PREFIX + walletPubkey);
    if (!raw) return null;

    const storageKey = await deriveStorageKey(walletPubkey);
    const decrypted = await decryptData(storageKey, raw);
    const data = JSON.parse(decrypted);

    return deserializeKeysFromStorage(data, solanaPublicKey);
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
let eventClientNetwork: string | null = null;
const SUI_ZKBTC_TOKEN_ID = 0x7a627463n;

export function getEventClient(): EventClient {
  const env = getChainEnvironment();
  if (eventClient && eventClientNetwork !== env.networkId) {
    eventClient.close();
    eventClient = null;
  }
  if (!eventClient) {
    const backendUrl = "";
    const wsBackendUrl = getBackendUrl(env.networkId);
    const wsUrl = wsBackendUrl.replace("http://", "ws://").replace("https://", "wss://");
    eventClient = new EventClient({
      backendUrl,
      backendWsUrl: wsUrl,
      solanaRpcUrl: getSolanaRpcUrl(),
      programId: UTXOpiaClient.instance().config.utxopiaProgramId,
      commitmentTreeAddress: UTXOpiaClient.instance().config.commitmentTreePda,
    });
    eventClientNetwork = env.networkId;
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

interface UTXOpiaState {
  // Poseidon
  isPoseidonReady: boolean;

  // Keys
  keys: UTXOpiaKeys | null;
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
  loadViewOnlyKeys: (encoded: string) => Promise<void>;
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

export const useUTXOpiaStore = create<UTXOpiaState>((set, get) => ({
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
      await ensureChainEnvironment();
      set({ isPoseidonReady: true });
    } catch (err) {
      console.error("[UTXOpia] Failed to init:", err);
    }
  },

  deriveKeys: async (wallet) => {
    set({ isLoading: true, error: null });

    try {
      await ensureChainEnvironment();
      const client = UTXOpiaClient.instance();
      const { keys: derivedKeys, stealthAddress: meta, stealthAddressEncoded: encoded } =
        await client.loginWithWallet({
          publicKey: wallet.publicKey,
          signMessage: wallet.signMessage,
        });

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
    await ensureChainEnvironment();
    const pubkeyStr = walletPubkey.toBase58();
    const restored = await loadKeys(pubkeyStr, walletPubkey.toBytes());
    if (!restored) return false;

    // Sync the UTXOpiaClient singleton with the restored keys
    const client = UTXOpiaClient.instance();
    const serialized = client.serializeKeys();
    // restoreKeys needs serialized form — re-serialize via loadKeys result
    // Since loadKeys already deserialized, we re-read raw from localStorage
    try {
      const raw = localStorage.getItem(KEYS_STORAGE_PREFIX + pubkeyStr);
      if (raw) {
        const storageKey = await deriveStorageKey(pubkeyStr);
        const decrypted = await decryptData(storageKey, raw);
        const data = JSON.parse(decrypted);
        client.restoreKeys(data, walletPubkey.toBytes());
      }
    } catch {
      // Client sync failed — store still has the keys, just client won't be synced
    }

    set({
      keys: restored,
      stealthAddress: client.stealthAddress ?? null,
      stealthAddressEncoded: client.stealthAddressEncoded ?? null,
      hasKeys: true,
    });
    return true;
  },

  deriveKeysFromPasskeySeed: async (seed: Uint8Array) => {
    set({ isLoading: true, error: null });
    try {
      await ensureChainEnvironment();
      const client = UTXOpiaClient.instance();
      const { keys: derivedKeys, stealthAddress: meta, stealthAddressEncoded: encoded } =
        await client.loginWithSeed(seed);

      // Persist with "passkey:" prefix
      const credentialId = typeof window !== "undefined"
        ? localStorage.getItem("utxo:passkey_credential_id") || "default"
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
      await ensureChainEnvironment();
      const credentialId = typeof window !== "undefined"
        ? localStorage.getItem("utxo:passkey_credential_id")
        : null;
      if (!credentialId) return false;

      const storageId = "passkey:" + credentialId;
      const restored = await loadKeys(storageId, new Uint8Array(32));
      if (!restored) return false;

      // Sync the UTXOpiaClient singleton with the restored keys
      const client = UTXOpiaClient.instance();
      try {
        const raw = localStorage.getItem(KEYS_STORAGE_PREFIX + storageId);
        if (raw) {
          const storageKey = await deriveStorageKey(storageId);
          const decrypted = await decryptData(storageKey, raw);
          const data = JSON.parse(decrypted);
          client.restoreKeys(data, new Uint8Array(32));
        }
      } catch {
        // Client sync failed — store still has the keys
      }

      set({
        keys: restored,
        stealthAddress: client.stealthAddress ?? null,
        stealthAddressEncoded: client.stealthAddressEncoded ?? null,
        hasKeys: true,
      });
      return true;
    } catch {
      return false;
    }
  },

  loadViewOnlyKeys: async (encoded: string) => {
    try {
      await ensureChainEnvironment();
      const voKeys = decodeViewOnlyKeys(encoded);
      // Sync with UTXOpiaClient so computeNullifier works in view-only mode
      const client = UTXOpiaClient.instance();
      client.loginViewOnly(voKeys);
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
    // Clear UTXOpiaClient state
    if (UTXOpiaClient.isInitialized) {
      UTXOpiaClient.instance().logout();
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
        await ensureChainEnvironment();
        const env = getChainEnvironment();
        if (viewOnlyKeys) {
          UTXOpiaClient.instance().loginViewOnly(viewOnlyKeys);
        }
        const suiInbox = env.config.chain === "sui"
          ? await fetchSuiInboxEvents(env.config)
          : null;
        // Fetch via EventClient (backend WS/REST → RPC fallback) on Solana.
        const announcements = suiInbox?.announcements ?? await getEventClient().fetchAll();

        // Skip only the expensive scan step if announcement count is unchanged,
        // but ALWAYS re-check nullifiers (spent status may have changed)
        const currentNotes = get().inboxNotes;
        const announcementsUnchanged =
          announcements.length === lastAnnouncementCount && currentNotes.length > 0;
        lastAnnouncementCount = announcements.length;

        // Build token list with computed tokenIds for multi-token scanning
        const utxopiaClient = UTXOpiaClient.instance();
        const config = utxopiaClient.config;
        const tokensToScan: { symbol: string; tokenId: bigint }[] = [];
        const seenTokenIds = new Set<string>();
        const pushTokenToScan = (symbol: string, tokenId: bigint) => {
          const key = tokenId.toString(16).padStart(64, "0");
          if (seenTokenIds.has(key)) return;
          seenTokenIds.add(key);
          tokensToScan.push({ symbol, tokenId });
        };
        if (env.config.chain === "sui") {
          pushTokenToScan("zkBTC", SUI_ZKBTC_TOKEN_ID);
        } else {
          for (const token of VAULT_TOKENS) {
            try {
              let mintAddr = token.mint;
              if (!mintAddr && token.symbol === "zkBTC") mintAddr = config.zkbtcMint;
              if (!mintAddr) continue; // skip tokens without mint addresses
              pushTokenToScan(token.shieldedSymbol, utxopiaClient.getTokenId(mintAddr));
            } catch (err) { console.error("[UTXOpiaStore] invalid mint for token:", token.symbol, err); }
          }
          for (const ann of announcements) {
            if (!ann.tokenIdHex) continue;
            try {
              const tokenId = BigInt(`0x${ann.tokenIdHex}`);
              pushTokenToScan("zkBTC", tokenId);
            } catch {
              // Ignore malformed backend token ids.
            }
          }
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

        // Compute nullifier hashes (hex) for each note via UTXOpiaClient
        const nullifierData = scanned.map((note) => {
          const hashBytes = utxopiaClient.computeNullifier(note);
          const hashHex = Buffer.from(hashBytes).toString("hex");
          return { note, hashHex };
        });

        // Fetch spent nullifier PDAs (incremental sync) and match client-side for privacy
        let notesWithSpentStatus: (typeof scanned[number] & { isSpent: boolean })[];
        if (nullifierData.length === 0) {
          notesWithSpentStatus = [];
        } else {
          if (suiInbox) {
            notesWithSpentStatus = nullifierData.map((d) => ({
              ...d.note,
              isSpent: suiInbox.spentNullifiers.has(d.hashHex),
            }));
          } else {
            const spentPdas = await fetchSpentNullifierPDAs(backendUrl);
            notesWithSpentStatus = nullifierData.map((d) => ({
              ...d.note,
              isSpent: spentPdas.has(nullifierHashToPDA(d.hashHex)),
            }));
          }
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
        console.error("[UTXOpia] Inbox error:", err);
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
      console.warn("[UTXOpia] EventClient start failed:", err);
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
      eventClientNetwork = null;
    };
  },

  refreshPublicBalance: async (walletPubkey?: PublicKey) => {
    if (!walletPubkey) {
      set({ publicZkbtcBalance: 0n });
      return;
    }
    try {
      await ensureChainEnvironment();
      const response = await fetch(
        API_ENDPOINTS.PUBLIC_ZKBTC_BALANCE(walletPubkey.toBase58()),
        { cache: "no-store" }
      );
      if (!response.ok) {
        throw new Error(`Balance request failed with ${response.status}`);
      }
      const result = await response.json();
      set({ publicZkbtcBalance: BigInt(result?.amount ?? "0") });
    } catch (err) {
      console.error("[UTXOpia] Failed to fetch public zkBTC balance:", err);
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

async function fetchSuiInboxEvents(config: NetworkConfig): Promise<{
  announcements: OnChainStealthAnnouncement[];
  spentNullifiers: Set<string>;
}> {
  if (!config.sui) return { announcements: [], spentNullifiers: new Set() };

  const { SuiClient } = await import("@mysten/sui/client");
  type SuiEvent = Awaited<ReturnType<InstanceType<typeof SuiClient>["queryEvents"]>>["data"][number];
  const client = new SuiClient({ url: config.sui.rpcUrl });
  const events: SuiEvent[] = [];
  let cursor: { txDigest: string; eventSeq: string } | null = null;

  for (let page = 0; page < 20; page += 1) {
    const result = await client.queryEvents({
      query: {
        MoveEventModule: {
          package: config.sui.packageId,
          module: "events",
        },
      },
      cursor,
      limit: 50,
      order: "descending",
    });
    events.push(...result.data);
    if (!result.hasNextPage || !result.nextCursor) break;
    cursor = result.nextCursor;
  }

  const announcements: OnChainStealthAnnouncement[] = [];
  const spentNullifiers = new Set<string>();

  for (const event of events) {
    const type = event.type.split("::").at(-1) ?? "";
    const payload = objectPayload(event.parsedJson);

    if (type === "BtcDepositVerified") {
      const amount = bigintField(payload.amount_sats);
      const ephemeralPub = bytesField(payload.ephemeral_pubkey);
      const commitment = bytesField(payload.commitment);
      const leafIndex = numberField(payload.leaf_index);
      if (amount == null || !ephemeralPub || !commitment || leafIndex == null) continue;
      announcements.push({
        announcementType: 0,
        ephemeralPub,
        encryptedAmount: u64Le(amount),
        commitment,
        leafIndex,
        blockTime: Math.floor(Number(event.timestampMs ?? 0) / 1000),
        tokenIdHex: SUI_ZKBTC_TOKEN_ID.toString(16).padStart(64, "0"),
      });
    } else if (type === "NullifierSpent") {
      const nullifier = bytesField(payload.nullifier);
      if (nullifier) spentNullifiers.add(Buffer.from(nullifier).toString("hex"));
    }
  }

  announcements.sort((a, b) => a.leafIndex - b.leafIndex);
  return { announcements, spentNullifiers };
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function bytesField(value: unknown): Uint8Array | null {
  if (Array.isArray(value)) {
    const bytes = value.map((entry) => Number(entry));
    if (bytes.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
      return Uint8Array.from(bytes);
    }
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/^0x/, "");
    if (/^[0-9a-fA-F]*$/.test(normalized) && normalized.length % 2 === 0) {
      return Uint8Array.from(Buffer.from(normalized, "hex"));
    }
  }
  return null;
}

function bigintField(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function numberField(value: unknown): number | null {
  const big = bigintField(value);
  if (big == null || big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(big);
}

function u64Le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

// ============================================================================
// Convenience Hooks
// ============================================================================

export function useUTXOpia() {
  return useUTXOpiaStore();
}

export function useUTXOpiaKeys() {
  const store = useUTXOpiaStore();
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
  const store = useUTXOpiaStore();
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
