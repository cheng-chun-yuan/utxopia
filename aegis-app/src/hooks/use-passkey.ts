"use client";

import { useState, useCallback, useEffect } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@aegis/sdk";
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  bufferToBase64URLString,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const CREDENTIAL_STORAGE_KEY = "aegis:passkey_credential_id";
const SEED_STORAGE_KEY = "aegis:passkey_seed";
/** Derive per-user PRF salt by mixing domain separator with credential ID */
function getPrfSalt(credentialId?: string | null): Uint8Array {
  const base = "aegis-passkey-prf-v1";
  const input = credentialId ? `${base}:${credentialId}` : base;
  return sha256(new TextEncoder().encode(input));
}

const RP_NAME = "Privacy Coin";

function getRpId(): string {
  if (typeof window === "undefined") return "localhost";
  return window.location.hostname;
}

function getStoredCredentialId(): string | null {
  try {
    return localStorage.getItem(CREDENTIAL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeCredentialId(id: string): void {
  try {
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, id);
  } catch {
    // localStorage unavailable
  }
}

export function clearStoredCredential(): void {
  try {
    localStorage.removeItem(CREDENTIAL_STORAGE_KEY);
    localStorage.removeItem(SEED_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Fallback seed storage (used when PRF is not available) ──

/** Derive AES-GCM key from credential ID for encrypting fallback seed at rest */
async function deriveStorageKey(credentialId: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`aegis-seed-enc:${credentialId}`),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("aegis-fallback-seed") },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function storeFallbackSeed(seed: Uint8Array, credentialId: string): Promise<void> {
  try {
    const key = await deriveStorageKey(credentialId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const seedCopy = new Uint8Array(seed).buffer as ArrayBuffer;
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, seedCopy));
    // Store as iv(12) || ciphertext
    const combined = new Uint8Array(iv.length + ct.length);
    combined.set(iv);
    combined.set(ct, iv.length);
    localStorage.setItem(SEED_STORAGE_KEY, bytesToHex(combined));
  } catch {
    // ignore
  }
}

async function loadFallbackSeed(credentialId: string): Promise<Uint8Array | null> {
  try {
    const hex = localStorage.getItem(SEED_STORAGE_KEY);
    if (!hex) return null;
    const data = hexToBytes(hex);
    if (data.length < 28) return null; // iv(12) + tag(16) minimum
    const key = await deriveStorageKey(credentialId);
    const iv = data.slice(0, 12);
    const ct = data.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new Uint8Array(plaintext);
  } catch {
    return null;
  }
}

// ── PRF extraction ──

/**
 * Try to extract PRF output from WebAuthn credential response.
 * Returns 32-byte seed or null if PRF not supported.
 */
function tryExtractPrfOutput(
  extensions: AuthenticationExtensionsClientOutputs | undefined,
): Uint8Array | null {
  if (!extensions) return null;

  const prf = (extensions as Record<string, unknown>).prf as
    | { results?: { first?: ArrayBuffer } }
    | undefined;
  if (!prf?.results?.first) return null;

  return sha256(new Uint8Array(prf.results.first));
}

function randomBase64URL(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bufferToBase64URLString(bytes.buffer as ArrayBuffer);
}

export interface UsePasskeyReturn {
  isSupported: boolean;
  hasCredential: boolean;
  isLoading: boolean;
  error: string | null;
  register: () => Promise<Uint8Array | null>;
  authenticate: () => Promise<Uint8Array | null>;
  clearCredential: () => void;
}

export function usePasskey(): UsePasskeyReturn {
  const [isSupported, setIsSupported] = useState(false);
  const [hasCredential, setHasCredential] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsSupported(browserSupportsWebAuthn());
    setHasCredential(!!getStoredCredentialId());
  }, []);

  const register = useCallback(async (): Promise<Uint8Array | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const rpId = getRpId();

      // Use base PRF salt for registration (no credential ID yet)
      const prfSalt = getPrfSalt();

      const creationOptions: PublicKeyCredentialCreationOptionsJSON = {
        rp: { name: RP_NAME, id: rpId },
        user: {
          id: randomBase64URL(32),
          name: "aegis-user",
          displayName: "Privacy Coin User",
        },
        challenge: randomBase64URL(32),
        pubKeyCredParams: [
          { alg: -7, type: "public-key" }, // ES256
          { alg: -257, type: "public-key" }, // RS256
        ],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        extensions: {
          prf: {
            eval: { first: prfSalt.buffer as ArrayBuffer },
          },
        } as Record<string, unknown>,
      };

      const credential = await startRegistration({
        optionsJSON: creationOptions,
      });

      // Try PRF first
      let seed = tryExtractPrfOutput(credential.clientExtensionResults);

      if (!seed) {
        // PRF not supported — generate random seed and encrypt in localStorage.
        // The passkey serves as a biometric gate; the seed is encrypted at rest.
        seed = new Uint8Array(32);
        crypto.getRandomValues(seed);
        await storeFallbackSeed(seed, credential.id);
      }

      storeCredentialId(credential.id);
      setHasCredential(true);

      return seed;
    } catch (err) {
      if (err instanceof Error) {
        if (
          err.name === "NotAllowedError" ||
          err.message.includes("cancelled")
        ) {
          setError(null);
          return null;
        }
        setError(err.message);
      } else {
        setError("Failed to create passkey");
      }
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const authenticate = useCallback(async (): Promise<Uint8Array | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const rpId = getRpId();
      const storedId = getStoredCredentialId();

      // Use per-user PRF salt when credential ID is known
      const prfSalt = getPrfSalt(storedId);

      const requestOptions: PublicKeyCredentialRequestOptionsJSON = {
        rpId,
        challenge: randomBase64URL(32),
        allowCredentials: storedId
          ? [{ id: storedId, type: "public-key" }]
          : [],
        userVerification: "required",
        extensions: {
          prf: {
            eval: { first: prfSalt.buffer as ArrayBuffer },
          },
        } as Record<string, unknown>,
      };

      const credential = await startAuthentication({
        optionsJSON: requestOptions,
      });

      // Try PRF first
      let seed = tryExtractPrfOutput(credential.clientExtensionResults);

      if (!seed) {
        // PRF not available — load encrypted fallback seed from localStorage
        const credId = storedId || credential.id;
        seed = await loadFallbackSeed(credId);
        if (!seed) {
          throw new Error(
            "No saved key found. This can happen if you registered on a different device. " +
              "Please use the original device or connect a wallet instead.",
          );
        }
      }

      if (!storedId) {
        storeCredentialId(credential.id);
        setHasCredential(true);
      }

      return seed;
    } catch (err) {
      if (err instanceof Error) {
        if (
          err.name === "NotAllowedError" ||
          err.message.includes("cancelled")
        ) {
          setError(null);
          return null;
        }
        setError(err.message);
      } else {
        setError("Failed to authenticate with passkey");
      }
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const clearCredential = useCallback(() => {
    clearStoredCredential();
    setHasCredential(false);
  }, []);

  return {
    isSupported,
    hasCredential,
    isLoading,
    error,
    register,
    authenticate,
    clearCredential,
  };
}
