"use client";

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  jwtToAddress,
} from "@mysten/sui/zklogin";
import { UTXOpiaSuiAdapter } from "@utxopia/sdk-sui";
import { detectNetwork, getNetworkConfig } from "@/lib/network-config";

const ZKLOGIN_SESSION_KEY = "utxopia.sui.zklogin";
const DEFAULT_EPOCH_WINDOW = 2;

export interface SuiZkLoginSession {
  provider: "google";
  nonce: string;
  randomness: string;
  maxEpoch: number;
  ephemeralSecretKey: string;
  ephemeralPublicKey: string;
  startedAt: number;
}

export interface SuiZkLoginCallback {
  jwt: string | null;
  address: string | null;
  salt: string | null;
  error: string | null;
}

export function getSuiClient() {
  const network = detectNetwork();
  const cfg = getNetworkConfig(network === "sui-regtest" ? "sui-regtest" : "sui-testnet");
  if (!cfg.sui) throw new Error("Sui configuration is missing");
  return new SuiClient({ url: cfg.sui.rpcUrl });
}

export function getSuiAdapter() {
  const network = detectNetwork();
  const cfg = getNetworkConfig(network === "sui-regtest" ? "sui-regtest" : "sui-testnet");
  const sui = cfg.sui;
  if (!sui) throw new Error("Sui configuration is missing");

  return new UTXOpiaSuiAdapter({
    rpcUrl: sui.rpcUrl,
    packageId: sui.packageId,
    poolObjectId: sui.pool.objectId,
    poolInitialSharedVersion: sui.pool.initialSharedVersion,
    btcDepositRegistryObjectId: sui.btcDepositRegistry?.objectId,
    btcDepositRegistryInitialSharedVersion: sui.btcDepositRegistry?.initialSharedVersion,
    verifyingKeyRegistryObjectId: sui.verifyingKeyRegistry.objectId,
    verifyingKeyRegistryInitialSharedVersion: sui.verifyingKeyRegistry.initialSharedVersion,
    nullifierRegistryObjectId: sui.nullifierRegistry.objectId,
    nullifierRegistryInitialSharedVersion: sui.nullifierRegistry.initialSharedVersion,
    redemptionQueueObjectId: sui.redemptionQueue.objectId,
    redemptionQueueInitialSharedVersion: sui.redemptionQueue.initialSharedVersion,
    redemptionCapObjectId: sui.redemptionCap.objectId,
    redemptionCapVersion: sui.redemptionCap.version,
    redemptionCapDigest: sui.redemptionCap.digest,
  });
}

export async function createSuiZkLoginSession(): Promise<SuiZkLoginSession> {
  const client = getSuiClient();
  const systemState = await client.getLatestSuiSystemState();
  const maxEpoch = Number(systemState.epoch) + DEFAULT_EPOCH_WINDOW;
  const keypair = Ed25519Keypair.generate();
  const randomness = generateRandomness();
  const nonce = generateNonce(keypair.getPublicKey(), maxEpoch, randomness);
  const session: SuiZkLoginSession = {
    provider: "google",
    nonce,
    randomness,
    maxEpoch,
    ephemeralSecretKey: keypair.getSecretKey(),
    ephemeralPublicKey: getExtendedEphemeralPublicKey(keypair.getPublicKey()),
    startedAt: Date.now(),
  };
  saveSuiZkLoginSession(session);
  return session;
}

export function buildGoogleZkLoginUrl(session: SuiZkLoginSession): string {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is required for Sui zkLogin");
  }

  const redirectUri =
    process.env.NEXT_PUBLIC_ZKLOGIN_REDIRECT_URI ??
    `${window.location.origin}/sui`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("nonce", session.nonce);
  url.searchParams.set("state", "utxopia-sui-zklogin");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export function getSuiZkLoginSession(): SuiZkLoginSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ZKLOGIN_SESSION_KEY);
    return raw ? JSON.parse(raw) as SuiZkLoginSession : null;
  } catch {
    return null;
  }
}

export function saveSuiZkLoginSession(session: SuiZkLoginSession) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(ZKLOGIN_SESSION_KEY, JSON.stringify(session));
}

export function clearSuiZkLoginSession() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(ZKLOGIN_SESSION_KEY);
}

export async function consumeSuiZkLoginCallback(): Promise<SuiZkLoginCallback> {
  if (typeof window === "undefined") {
    return { jwt: null, address: null, salt: null, error: null };
  }

  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const jwt = hash.get("id_token");
  const error = hash.get("error") ?? hash.get("error_description");
  if (!jwt) return { jwt: null, address: null, salt: null, error };

  const salt = await fetchZkLoginSalt(jwt);
  const address = salt ? jwtToAddress(jwt, salt) : null;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return { jwt, address, salt, error };
}

async function fetchZkLoginSalt(jwt: string): Promise<string | null> {
  const saltServerUrl = process.env.NEXT_PUBLIC_ZKLOGIN_SALT_SERVER_URL;
  if (!saltServerUrl) return null;

  const response = await fetch(saltServerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt }),
  });
  if (!response.ok) {
    throw new Error(`zkLogin salt server returned HTTP ${response.status}`);
  }

  const body = await response.json() as { salt?: string; userSalt?: string };
  return body.salt ?? body.userSalt ?? null;
}
