/**
 * Backend Merkle Tree API client
 *
 * Fast path: queries the backend's in-memory cached tree for instant proof serving.
 * Falls back to on-chain rebuild if backend is unavailable.
 */

const TRACKER_API_URL =
  process.env.TRACKER_API_URL ||
  process.env.NEXT_PUBLIC_TRACKER_API_URL ||
  "http://localhost:3001";

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

export interface TreeUpdate {
  type: "leaf_inserted";
  leaf_index: number;
  commitment: string;
  new_root: string;
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

/**
 * Subscribe to tree updates via WebSocket.
 * Returns an unsubscribe function.
 */
export function subscribeToTreeUpdates(
  callback: (update: TreeUpdate) => void,
): { unsubscribe: () => void } {
  const wsUrl = TRACKER_API_URL.replace(/^http/, "ws") + "/ws/tree";
  let ws: WebSocket | null = null;
  let closed = false;

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        try {
          const update = JSON.parse(event.data) as TreeUpdate;
          callback(update);
        } catch {
          // ignore malformed messages
        }
      };
      ws.onclose = () => {
        if (!closed) {
          // Reconnect after 5 seconds
          setTimeout(connect, 5000);
        }
      };
      ws.onerror = () => {
        ws?.close();
      };
    } catch {
      // WebSocket not available, retry later
      if (!closed) {
        setTimeout(connect, 5000);
      }
    }
  }

  connect();

  return {
    unsubscribe: () => {
      closed = true;
      ws?.close();
    },
  };
}
