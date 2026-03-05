/**
 * Stealth Announcements API
 *
 * Fetches and caches all stealth announcements from chain.
 * Clients scan locally for privacy (server doesn't know which belong to whom).
 */

import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  DEVNET_CONFIG,
  STEALTH_ANNOUNCEMENT_SIZE,
  parseStealthAnnouncement,
  parseCommitmentTreeData,
} from "@aegis/sdk";
import { getHeliusConnection } from "@/lib/helius-server";

// =============================================================================
// Types
// =============================================================================

interface CachedAnnouncement {
  pubkey: string;
  announcementType: number; // 0=deposit, 1=transfer
  ephemeralPub: string; // hex
  encryptedAmount: string; // hex
  commitment: string; // hex
  leafIndex: number;
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
const AEGIS_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.aegisProgramId);

// In-memory cache
let announcementCache: CacheData | null = null;
let fetchPromise: Promise<CacheData> | null = null;

// =============================================================================
// Fetch Logic
// =============================================================================

async function fetchAnnouncements(): Promise<CacheData> {
  const connection = getHeliusConnection("devnet");

  console.log("[StealthAPI] Fetching stealth announcements from chain...");

  // Fetch tree state to get current nextIndex (filters out stale pre-reset announcements)
  let treeNextIndex = Number.MAX_SAFE_INTEGER;
  try {
    const commitmentTreePda = new PublicKey(DEVNET_CONFIG.commitmentTreePda);
    const treeAccount = await connection.getAccountInfo(commitmentTreePda);
    if (treeAccount) {
      const treeState = parseCommitmentTreeData(new Uint8Array(treeAccount.data));
      treeNextIndex = Number(treeState.nextIndex);
      console.log(`[StealthAPI] Tree nextIndex: ${treeNextIndex}`);
    }
  } catch (e) {
    console.warn("[StealthAPI] Failed to fetch tree state, skipping filter:", e);
  }

  const accounts = await connection.getProgramAccounts(AEGIS_PROGRAM_ID, {
    filters: [{ dataSize: STEALTH_ANNOUNCEMENT_SIZE }],
  });

  console.log(`[StealthAPI] Found ${accounts.length} stealth announcement accounts`);

  const announcements: CachedAnnouncement[] = [];

  for (const account of accounts) {
    try {
      const parsed = parseStealthAnnouncement(new Uint8Array(account.account.data));
      if (parsed) {
        // Skip stale announcements from before a tree reset
        if (parsed.leafIndex >= treeNextIndex) {
          console.log(`[StealthAPI] Skipping stale announcement: leafIndex=${parsed.leafIndex} >= treeNextIndex=${treeNextIndex}`);
          continue;
        }
        announcements.push({
          pubkey: account.pubkey.toBase58(),
          announcementType: parsed.announcementType,
          ephemeralPub: Buffer.from(parsed.ephemeralPub).toString("hex"),
          encryptedAmount: Buffer.from(parsed.encryptedAmount).toString("hex"),
          commitment: Buffer.from(parsed.commitment).toString("hex"),
          leafIndex: parsed.leafIndex,
        });
      }
    } catch (e) {
      console.warn("[StealthAPI] Failed to parse announcement:", e);
    }
  }

  // Sort by leafIndex for consistent ordering
  announcements.sort((a, b) => a.leafIndex - b.leafIndex);

  // Check for duplicate leafIndex values (indicates stale announcements from pre-reset)
  const seen = new Set<number>();
  const deduped: CachedAnnouncement[] = [];
  for (const ann of announcements) {
    if (seen.has(ann.leafIndex)) {
      console.warn(`[StealthAPI] Duplicate leafIndex ${ann.leafIndex}, keeping latest`);
      // Replace with the latest one (later in sorted order)
      const idx = deduped.findIndex(a => a.leafIndex === ann.leafIndex);
      if (idx >= 0) deduped[idx] = ann;
    } else {
      seen.add(ann.leafIndex);
      deduped.push(ann);
    }
  }

  const cacheData: CacheData = {
    announcements: deduped,
    fetchedAt: Date.now(),
    count: deduped.length,
  };

  console.log(`[StealthAPI] Cached ${deduped.length} announcements (filtered ${announcements.length - deduped.length} duplicates)`);

  return cacheData;
}

async function getAnnouncementsWithCache(forceRefresh = false): Promise<CacheData> {
  const now = Date.now();

  // Force refresh clears the cache
  if (forceRefresh) {
    announcementCache = null;
  }

  // Return cache if still valid
  if (announcementCache && now - announcementCache.fetchedAt < CACHE_TTL_MS) {
    return announcementCache;
  }

  // If already fetching, wait for that promise
  if (fetchPromise) {
    return fetchPromise;
  }

  // Start new fetch
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
    // Check for refresh query param
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get('refresh') === 'true';

    const data = await getAnnouncementsWithCache(forceRefresh);

    return NextResponse.json({
      success: true,
      announcements: data.announcements,
      count: data.count,
      cachedAt: data.fetchedAt,
      cacheAge: Date.now() - data.fetchedAt,
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
    // Clear cache and force refresh
    announcementCache = null;
    fetchPromise = null;

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
