/**
 * Stealth Announcements API
 *
 * Fetches stealth announcements from transaction log events (disc=0x03).
 * Primary source is the backend event indexer (SQLite); fallback is direct RPC log scanning.
 *
 * Clients scan locally for privacy (server doesn't know which belong to whom).
 */

import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  getConfig,
  parseCommitmentTreeData,
  parseProgramEvents,
  type StealthAnnouncementEvent,
} from "@aegis/sdk";
import { getHeliusConnection } from "@/lib/helius-server";
import { getBackendUrl } from "@/lib/api/constants";
export const dynamic = "force-dynamic";

// =============================================================================
// Types
// =============================================================================

interface CachedAnnouncement {
  announcementType: number; // 0=deposit, 1=transfer
  ephemeralPub: string; // hex
  encryptedAmount: string; // hex
  commitment: string; // hex
  leafIndex: number;
  source: "pda" | "event"; // where this announcement was found
}

interface CacheData {
  announcements: CachedAnnouncement[];
  fetchedAt: number;
  count: number;
}

// =============================================================================
// Cache Configuration
// =============================================================================

const CACHE_TTL_MS = 30_000; // 30 seconds
let AEGIS_PROGRAM_ID: PublicKey;
try { AEGIS_PROGRAM_ID = new PublicKey(getConfig().aegisProgramId); } catch { AEGIS_PROGRAM_ID = PublicKey.default; }

// In-memory cache
let announcementCache: CacheData | null = null;
let fetchPromise: Promise<CacheData> | null = null;

// Track the last signature we've seen for incremental event fetching
let lastEventSignature: string | undefined;

// =============================================================================
// Fetch Logic
// =============================================================================

/**
 * Fetch stealth announcements from transaction log events (disc=0x03).
 */
async function fetchEventAnnouncements(
  connection: ReturnType<typeof getHeliusConnection>,
  treeNextIndex: number,
): Promise<CachedAnnouncement[]> {
  const announcements: CachedAnnouncement[] = [];

  // Fetch recent transaction signatures for the program
  const signatures = await connection.getSignaturesForAddress(
    AEGIS_PROGRAM_ID,
    { limit: 200, until: lastEventSignature },
    "confirmed",
  );

  if (signatures.length === 0) return announcements;

  // Update cursor for next incremental fetch
  lastEventSignature = signatures[signatures.length - 1].signature;

  console.log(`[StealthAPI] Scanning ${signatures.length} transactions for stealth events...`);

  // Process in batches to avoid rate limits
  const BATCH_SIZE = 20;
  for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
    const batch = signatures.slice(i, i + BATCH_SIZE);
    const txResults = await Promise.all(
      batch.map((sig) =>
        connection.getTransaction(sig.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
      )
    );

    for (const tx of txResults) {
      if (!tx?.meta?.logMessages) continue;

      const events = parseProgramEvents(tx.meta.logMessages);
      for (const event of events) {
        if (event.type !== "stealth_announcement") continue;
        const sa = event as StealthAnnouncementEvent;

        if (sa.leafIndex >= treeNextIndex) continue;

        announcements.push({
          announcementType: sa.announcementType,
          ephemeralPub: Buffer.from(sa.ephemeralPub).toString("hex"),
          encryptedAmount: Buffer.from(sa.encryptedAmount).toString("hex"),
          commitment: Buffer.from(sa.commitment).toString("hex"),
          leafIndex: sa.leafIndex,
          source: "event",
        });
      }
    }
  }

  console.log(`[StealthAPI] Found ${announcements.length} stealth events from tx logs`);
  return announcements;
}

async function fetchAnnouncements(): Promise<CacheData> {
  const connection = getHeliusConnection("devnet");

  console.log("[StealthAPI] Fetching stealth announcements...");

  // Fetch tree state to get current nextIndex
  let treeNextIndex = Number.MAX_SAFE_INTEGER;
  try {
    const commitmentTreePda = new PublicKey(getConfig().commitmentTreePda);
    const treeAccount = await connection.getAccountInfo(commitmentTreePda);
    if (treeAccount) {
      const treeState = parseCommitmentTreeData(new Uint8Array(treeAccount.data));
      treeNextIndex = Number(treeState.nextIndex);
      console.log(`[StealthAPI] Tree nextIndex: ${treeNextIndex}`);
    }
  } catch (e) {
    console.warn("[StealthAPI] Failed to fetch tree state, skipping filter:", e);
  }

  // Fetch from transaction log events
  const announcements = await fetchEventAnnouncements(connection, treeNextIndex);
  announcements.sort((a, b) => a.leafIndex - b.leafIndex);

  const cacheData: CacheData = {
    announcements,
    fetchedAt: Date.now(),
    count: announcements.length,
  };

  console.log(`[StealthAPI] Cached ${announcements.length} announcements from events`);
  return cacheData;
}

async function getAnnouncementsWithCache(forceRefresh = false): Promise<CacheData> {
  const now = Date.now();

  if (forceRefresh) {
    announcementCache = null;
    lastEventSignature = undefined;
  }

  if (announcementCache && now - announcementCache.fetchedAt < CACHE_TTL_MS) {
    return announcementCache;
  }

  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = fetchAnnouncements()
    .then((data) => {
      announcementCache = data;
      fetchPromise = null;
      return data;
    })
    .catch((error) => {
      fetchPromise = null;
      throw error;
    });

  return fetchPromise;
}

// =============================================================================
// API Handler
// =============================================================================

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get('refresh') === 'true';

    // Try backend indexer first (faster, has full history from SQLite)
    if (!forceRefresh) {
      try {
        const backendUrl = getBackendUrl();
        const backendResp = await fetch(`${backendUrl}/api/announcements`, {
          signal: AbortSignal.timeout(3000),
        });
        if (backendResp.ok) {
          const data = await backendResp.json();
          return NextResponse.json({
            success: true,
            announcements: data.announcements.map((a: { leaf_index: number; announcement_type: number; ephemeral_pub: string; encrypted_amount: string; commitment: string }) => ({
              announcementType: a.announcement_type,
              ephemeralPub: a.ephemeral_pub,
              encryptedAmount: a.encrypted_amount,
              commitment: a.commitment,
              leafIndex: a.leaf_index,
              source: "backend",
            })),
            count: data.count,
            cachedAt: Date.now(),
            cacheAge: 0,
            source: "backend",
          });
        }
      } catch {
        console.warn("[StealthAPI] Backend unavailable, falling back to direct RPC");
      }
    }

    // Fallback: direct RPC (legacy PDA + event scanning)
    const data = await getAnnouncementsWithCache(forceRefresh);

    return NextResponse.json({
      success: true,
      announcements: data.announcements,
      count: data.count,
      cachedAt: data.fetchedAt,
      cacheAge: Date.now() - data.fetchedAt,
      source: "rpc",
    });
  } catch (error) {
    console.error("[StealthAPI] Error fetching announcements:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

// Force refresh endpoint
export async function POST() {
  try {
    announcementCache = null;
    fetchPromise = null;
    lastEventSignature = undefined;

    const data = await getAnnouncementsWithCache();

    return NextResponse.json({
      success: true,
      announcements: data.announcements,
      count: data.count,
      cachedAt: data.fetchedAt,
      refreshed: true,
    });
  } catch (error) {
    console.error("[StealthAPI] Error refreshing announcements:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
