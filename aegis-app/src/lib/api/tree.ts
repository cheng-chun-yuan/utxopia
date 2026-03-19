/**
 * Backend Merkle Tree API client
 *
 * Fast path: queries the backend's in-memory cached tree for instant proof serving.
 * Falls back to on-chain rebuild if backend is unavailable.
 */

import { getBackendUrl } from "@/lib/api/constants";

const TRACKER_API_URL = getBackendUrl();

export interface TreeProofResponse {
  success: boolean;
  commitment?: string;
  leaf_index?: number;
  root?: string;
  siblings?: string[];
  indices?: number[];
  error?: string;
}

export interface TreeStatusResponse {
  root: string;
  next_index: number;
  size: number;
}

/**
 * Get Merkle proof from the backend's cached tree (fast path, ~1ms).
 * Returns null if backend is unavailable.
 */
export async function getTreeProofFromBackend(
  commitmentHex: string,
): Promise<TreeProofResponse | null> {
  try {
    const url = `${TRACKER_API_URL}/api/tree/proof?commitment=${encodeURIComponent(commitmentHex)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as TreeProofResponse;
  } catch {
    // Backend unavailable
    return null;
  }
}

/**
 * Get tree status from the backend.
 * Returns null if backend is unavailable.
 */
export async function getTreeStatus(): Promise<TreeStatusResponse | null> {
  try {
    const url = `${TRACKER_API_URL}/api/tree/status`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as TreeStatusResponse;
  } catch {
    return null;
  }
}

