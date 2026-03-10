"use client";

/**
 * Thin SWR revalidation hook that subscribes to the SDK EventClient
 * and invalidates appropriate SWR cache keys on each event.
 */

import { useEffect, useState, useCallback } from "react";
import { useSWRConfig } from "swr";
import { getEventClient } from "@/stores/aegis-store";

const TRACKER_API_URL =
  process.env.NEXT_PUBLIC_ZKBTC_API_URL || "http://localhost:3001";

export function useEventStream() {
  const { mutate } = useSWRConfig();
  const [connected, setConnected] = useState(false);

  const checkConnection = useCallback(() => {
    const client = getEventClient();
    setConnected(client.isWsConnected);
  }, []);

  useEffect(() => {
    const client = getEventClient();

    // Start WS connection
    client.start().catch(() => {});

    // Poll connection status (WS connected state isn't observable via callback)
    const interval = setInterval(checkConnection, 2000);
    checkConnection();

    // Subscribe to tree updates → revalidate tree-related SWR keys
    const unsubTree = client.onTreeUpdate(() => {
      mutate(`${TRACKER_API_URL}/api/tree/status`);
      mutate(`${TRACKER_API_URL}/api/announcements`);
    });

    // Subscribe to nullifier events → revalidate nullifier SWR keys
    const unsubNullifier = client.onNullifierSpent(() => {
      mutate(`${TRACKER_API_URL}/api/nullifiers`);
    });

    // Subscribe to announcement events → revalidate announcement SWR keys
    const unsubAnnouncement = client.onAnnouncement(() => {
      mutate(`${TRACKER_API_URL}/api/announcements`);
    });

    return () => {
      clearInterval(interval);
      unsubTree();
      unsubNullifier();
      unsubAnnouncement();
    };
  }, [mutate, checkConnection]);

  return { connected };
}
