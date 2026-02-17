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
} from "@zvault/sdk";
import { getHeliusConnection } from "@/lib/helius-server";

// =============================================================================
// Types
// =============================================================================

interface CachedAnnouncement {
  pubkey: string;
  ephemeralPub: string; // hex
  encryptedAmount: string; // hex
  commitment: string; // hex
  leafIndex: number;
  createdAt: string; // bigint as string
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
const ZVAULT_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.zvaultProgramId);

// In-memory cache
let announcementCache: CacheData | null = null;
let fetchPromise: Promise<CacheData> | null = null;

// =============================================================================
// Fetch Logic
// =============================================================================

async function fetchAnnouncements(): Promise<CacheData> {
  const connection = getHeliusConnection("devnet");

  console.log("[StealthAPI] Fetching stealth announcements from chain...");

  const accounts = await connection.getProgramAccounts(ZVAULT_PROGRAM_ID, {
    filters: [{ dataSize: STEALTH_ANNOUNCEMENT_SIZE }],
  });

  console.log(`[StealthAPI] Found ${accounts.length} stealth announcement accounts`);

  const announcements: CachedAnnouncement[] = [];
  console.log("[StealthAPI] Parsing announcements...");

  for (const account of accounts) {
    try {
      const parsed = parseStealthAnnouncement(new Uint8Array(account.account.data));
      if (parsed) {
        const commitmentHex = Buffer.from(parsed.commitment).toString("hex");
        console.log(`[StealthAPI] Announcement: leafIndex=${parsed.leafIndex}, commitment=${commitmentHex.slice(0, 16)}...`);
        announcements.push({
          pubkey: account.pubkey.toBase58(),
          ephemeralPub: Buffer.from(parsed.ephemeralPub).toString("hex"),
          encryptedAmount: Buffer.from(parsed.encryptedAmount).toString("hex"),
          commitment: commitmentHex,
          leafIndex: parsed.leafIndex,
          createdAt: parsed.createdAt.toString(),
        });
      }
    } catch (e) {
      // Skip invalid announcements
      console.warn("[StealthAPI] Failed to parse announcement:", e);
    }
  }

  // Sort by leafIndex for consistent ordering
  announcements.sort((a, b) => a.leafIndex - b.leafIndex);

  const cacheData: CacheData = {
    announcements,
    fetchedAt: Date.now(),
    count: announcements.length,
  };

  console.log(`[StealthAPI] Cached ${announcements.length} announcements`);

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
