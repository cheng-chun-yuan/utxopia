/**
 * Simple in-memory rate limiter for API routes.
 *
 * Token-bucket algorithm: each IP gets `maxTokens` tokens,
 * replenished at `refillRate` tokens per `windowMs`.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

const CLEANUP_INTERVAL = 60_000; // 1 minute
let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  // Remove buckets idle for > 5 minutes
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > 300_000) {
      buckets.delete(key);
    }
  }
}

export interface RateLimitConfig {
  /** Max requests per window (default: 20) */
  maxTokens?: number;
  /** Window duration in ms (default: 60_000 = 1 min) */
  windowMs?: number;
}

/**
 * Check if a request is rate-limited.
 * Returns { limited: false } if allowed, or { limited: true, retryAfterMs } if blocked.
 */
export function checkRateLimit(
  ip: string,
  endpoint: string,
  config: RateLimitConfig = {}
): { limited: boolean; retryAfterMs?: number } {
  const { maxTokens = 20, windowMs = 60_000 } = config;
  const key = `${ip}:${endpoint}`;
  const now = Date.now();

  cleanup();

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now };
    buckets.set(key, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  const refill = Math.floor((elapsed / windowMs) * maxTokens);
  if (refill > 0) {
    bucket.tokens = Math.min(maxTokens, bucket.tokens + refill);
    bucket.lastRefill = now;
  }

  if (bucket.tokens <= 0) {
    const retryAfterMs = Math.ceil(windowMs / maxTokens);
    return { limited: true, retryAfterMs };
  }

  bucket.tokens -= 1;
  return { limited: false };
}

/**
 * Helper to get client IP from Next.js request headers.
 */
export function getClientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "unknown"
  );
}
