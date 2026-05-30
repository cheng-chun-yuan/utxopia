"use client";

import { useSyncExternalStore } from "react";
import { initConfig, UTXOpiaClient, type NetworkConfig as SdkNetworkConfig } from "@utxopia/sdk";
import {
  detectNetwork,
  getNetworkConfig,
  NETWORK_CHANGE_EVENT,
  type NetworkConfig,
  type NetworkId,
} from "@/lib/network-config";

export interface ChainEnvironment {
  networkId: NetworkId;
  config: NetworkConfig;
}

let configuredNetwork: NetworkId | null = null;
let configurePromise: Promise<SdkNetworkConfig> | null = null;

function subscribeToNetwork(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(NETWORK_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(NETWORK_CHANGE_EVENT, onChange);
  };
}

export function getChainEnvironment(networkId: NetworkId = detectNetwork()): ChainEnvironment {
  return {
    networkId,
    config: getNetworkConfig(networkId, { applyEnvOverrides: false }),
  };
}

export function useChainEnvironment(): ChainEnvironment {
  const networkId = useSyncExternalStore<NetworkId>(
    subscribeToNetwork,
    () => detectNetwork(),
    () => "devnet",
  );
  return getChainEnvironment(networkId);
}

export async function ensureChainEnvironment(networkId: NetworkId = detectNetwork()): Promise<ChainEnvironment> {
  const env = getChainEnvironment(networkId);

  if (env.config.chain === "sui") {
    if (!UTXOpiaClient.isInitialized) {
      await UTXOpiaClient.init({ backendUrl: "" });
    }
    return env;
  }

  if (configuredNetwork !== networkId || !configurePromise) {
    configurePromise = initConfig({
      utxopiaProgramId: env.config.solana.utxopiaProgramId,
      zkbtcMint: env.config.tokens.zkbtcMint,
      solanaRpcUrl: env.config.solana.rpcUrl,
      groupPubKey: env.config.bitcoin.groupPubkey,
      ikaDwalletXOnlyPubkey: env.config.ika?.dwalletXOnlyPubkey,
      depositMode: env.config.bitcoin.depositMode,
    });
    configuredNetwork = networkId;
  }

  await configurePromise;

  if (!UTXOpiaClient.isInitialized) {
    await UTXOpiaClient.init({ backendUrl: "" });
  }

  return env;
}
