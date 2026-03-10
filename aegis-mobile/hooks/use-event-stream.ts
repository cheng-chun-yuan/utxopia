/**
 * Unified WebSocket event stream (mobile)
 *
 * Uses the SDK EventClient for WS connection + reconnect.
 * Dispatches events to SWR mutators for real-time cache updates.
 */

import { useEffect, useState, useCallback } from "react";
import { useSWRConfig } from "swr";
import { EventClient, DEVNET_CONFIG } from "@aegis/sdk";
import { API_BASE, toWsUrl } from "@/lib/api";

// Singleton EventClient
let eventClient: EventClient | null = null;

function getEventClient(): EventClient {
  if (!eventClient) {
    const wsUrl = toWsUrl(API_BASE);
    eventClient = new EventClient({
      backendUrl: API_BASE,
      backendWsUrl: wsUrl,
      solanaRpcUrl: "https://api.devnet.solana.com",
      programId: DEVNET_CONFIG.aegisProgramId,
      commitmentTreeAddress: DEVNET_CONFIG.commitmentTreePda,
    });
  }
  return eventClient;
}

export { getEventClient };

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

    // Poll connection status
    const interval = setInterval(checkConnection, 2000);
    checkConnection();

    // Subscribe to tree updates → revalidate tree + pool SWR keys
    const unsubTree = client.onTreeUpdate(() => {
      mutate(`${API_BASE}/api/tree/status`);
      mutate(`${API_BASE}/api/announcements`);
      mutate(`${API_BASE}/api/pool/info`);
    });

    // Subscribe to nullifier events → revalidate nullifier SWR keys
    const unsubNullifier = client.onNullifierSpent(() => {
      mutate(`${API_BASE}/api/nullifiers`);
    });

    // Subscribe to announcement events → revalidate announcement SWR keys
    const unsubAnnouncement = client.onAnnouncement(() => {
      mutate(`${API_BASE}/api/announcements`);
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
